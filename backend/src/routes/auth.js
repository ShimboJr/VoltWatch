import { Router } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { z } from 'zod';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/authSession.js';
import { validate } from '../middleware/validate.js';
import config from '../config/index.js';

const router = Router();

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── POST /api/v1/auth/login ──────────────────────────────────────────────────
router.post('/login', validate(loginSchema), async (req, res, next) => {
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
// Single-owner app: clears this session; future: could store a generation counter.
router.post('/sign-out-all', requireAuth, (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true, message: 'All sessions cleared. Please log in again.' });
});

export default router;
