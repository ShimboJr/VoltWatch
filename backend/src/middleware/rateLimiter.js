import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const isTest = process.env.NODE_ENV === 'test';

/** Standard error-response factory matching the spec shape. */
const errBody = (code, message) => ({ error: { code, message } });

/**
 * Login endpoint limiter: 20 attempts per 15 minutes.
 * Separate window from general dashboard so it's harder to lock out the owner.
 */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: errBody('RATE_LIMITED', 'Too many login attempts — try again in 15 minutes'),
});

/**
 * General dashboard rate limit: 200 req/min per IP.
 */
export const dashboardRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10_000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: errBody('RATE_LIMITED', 'Too many requests'),
});

/**
 * Per-device-token rate limit: 10 req/min.
 * Key is the SHA-256 of the raw bearer token so the plaintext never sits in
 * the limiter's in-memory store.
 */
export const agentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    const auth = req.headers.authorization || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!raw) return req.ip || 'unknown';
    return crypto.createHash('sha256').update(raw).digest('hex');
  },
  message: errBody('RATE_LIMITED', 'Agent rate limit exceeded (10 req/min per device)'),
});
