import jwt from 'jsonwebtoken';
import config from '../config/index.js';

/**
 * Express middleware that validates the session cookie (JWT).
 * Sets req.userId (string) and req.user { _id } on success; returns 401 otherwise.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.userId;
    // Provide req.user for routes that need it (avoids re-fetching the User document)
    req.user   = { _id: payload.userId };
    next();
  } catch {
    return res.status(401).json({
      error: { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' },
    });
  }
}
