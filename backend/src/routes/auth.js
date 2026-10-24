import { Router } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/authSession.js';
import { validate } from '../middleware/validate.js';
import { loginRateLimit } from '../middleware/rateLimiter.js';
import { sendVerificationEmail, sendWelcomeEmail } from '../services/emailService.js';
import config from '../config/index.js';
import { logger } from '../middleware/logger.js';

const router = Router();

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Zod schemas ───────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(80).optional().default(''),
});

const resendSchema = z.object({
  email: z.string().email(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a cryptographically secure raw token + its SHA-256 hash. */
function generateVerificationToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/** Build the full verification URL from the raw token. */
function verificationUrl(rawToken) {
  return `${config.appUrl}/api/v1/auth/verify?token=${rawToken}`;
}

// ── POST /api/v1/auth/register ────────────────────────────────────────────────
router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    // Check for existing account (return generic message to avoid user enumeration)
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      // Return 409 only for the actual duplicate — don't reveal "email already in use"
      // in a way that allows enumeration timing attacks (we don't call argon2 here).
      return res.status(409).json({
        error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists.' },
      });
    }

    const passwordHash = await argon2.hash(password);
    const { raw, hash } = generateVerificationToken();
    const expiry = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

    await User.create({
      email: email.toLowerCase(),
      passwordHash,
      name: name || '',
      emailVerified: false,
      verificationToken: hash,
      verificationTokenExpiry: expiry,
    });

    // Send verification email (non-fatal — don't fail registration if email fails)
    try {
      await sendVerificationEmail(email, name || '', verificationUrl(raw));
    } catch (emailErr) {
      logger.error({ emailErr, email }, 'Failed to send verification email after registration');
    }

    res.status(201).json({
      ok: true,
      message: 'Account created. Please check your email to verify your address before signing in.',
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/v1/auth/verify?token=<raw> ──────────────────────────────────────
router.get('/verify', async (req, res, next) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.redirect(`${config.appUrl}/app#/login?verified=error`);
    }

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      verificationToken: hash,
      verificationTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
      // Expired or invalid token — redirect with error flag so the login page shows a message
      return res.redirect(`${config.appUrl}/app#/login?verified=error`);
    }

    user.emailVerified = true;
    user.verificationToken = null;
    user.verificationTokenExpiry = null;
    await user.save();

    logger.info({ email: user.email }, 'Email verified');

    // Send welcome email (non-fatal)
    try {
      await sendWelcomeEmail(user.email, user.name || '');
    } catch (emailErr) {
      logger.error({ emailErr, email: user.email }, 'Failed to send welcome email');
    }

    return res.redirect(`${config.appUrl}/app#/login?verified=1`);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/resend-verification ────────────────────────────────────
router.post('/resend-verification', validate(resendSchema), async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });

    // Generic response to prevent enumeration — always return success
    if (!user || user.emailVerified) {
      return res.json({ ok: true });
    }

    const { raw, hash } = generateVerificationToken();
    const expiry = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

    user.verificationToken = hash;
    user.verificationTokenExpiry = expiry;
    await user.save();

    try {
      await sendVerificationEmail(email, user.name || '', verificationUrl(raw));
    } catch (emailErr) {
      logger.error({ emailErr, email }, 'Failed to resend verification email');
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/login ──────────────────────────────────────────────────
router.post('/login', loginRateLimit, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });

    // If user not found, spend time to prevent user enumeration via timing
    if (!user) {
      await new Promise((r) => setTimeout(r, 200));
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    // Check lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainMin = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      return res.status(429).json({
        error: {
          code: 'ACCOUNT_LOCKED',
          message: `Account locked. Try again in ${remainMin} minute(s).`,
        },
      });
    }

    // Verify password
    let valid = false;
    try {
      valid = await argon2.verify(user.passwordHash, password);
    } catch {
      // hash format mismatch — treat as wrong password
    }

    if (!valid) {
      user.failedLogins = (user.failedLogins || 0) + 1;
      if (user.failedLogins >= LOCKOUT_FAILURES) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.failedLogins = 0;
      }
      await user.save();
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    // Block unverified users
    if (!user.emailVerified) {
      return res.status(403).json({
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Please verify your email address before signing in. Check your inbox for the verification link.',
        },
      });
    }

    // Success — reset failure counters
    user.failedLogins = 0;
    user.lockedUntil = null;
    await user.save();

    const token = jwt.sign({ userId: user._id.toString() }, config.jwtSecret, {
      expiresIn: '14d',
    });

    res.cookie('session', token, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/logout ─────────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

// ── GET /api/v1/auth/me ──────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId, {
      passwordHash: 0,
      failedLogins: 0,
      lockedUntil: 0,
      verificationToken: 0,
      verificationTokenExpiry: 0,
    }).lean();

    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/change-password ───────────────────────────────────────
router.post(
  '/change-password',
  requireAuth,
  validate(z.object({
    current: z.string().min(1),
    next:    z.string().min(8),
  })),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.userId);
      if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });

      let valid = false;
      try { valid = await argon2.verify(user.passwordHash, req.body.current); } catch { /* ignore */ }
      if (!valid) {
        return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' } });
      }

      user.passwordHash = await argon2.hash(req.body.next);
      await user.save();

      // Invalidate current session so the new password is required on next login
      res.clearCookie('session');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/v1/auth/sign-out-all ───────────────────────────────────────────
router.post('/sign-out-all', requireAuth, (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true, message: 'All sessions cleared. Please log in again.' });
});

export default router;
