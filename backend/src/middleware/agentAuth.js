import crypto from 'crypto';
import { Device } from '../models/Device.js';

/**
 * Express middleware for agent routes.
 * Parses "Authorization: Bearer <token>", SHA-256 hashes it, and looks
 * up the matching Device. Sets req.device on success.
 *
 * Uses constant-time comparison to prevent timing-based token enumeration.
 */
export async function requireDeviceAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
    });
  }

  const rawToken = auth.slice(7).trim();
  if (!rawToken) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Empty bearer token' },
    });
  }

  const inputHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  try {
    // Find by hash (index lookup); constant-time compare is the final gate
    const device = await Device.findOne({ tokenHash: inputHash });
    if (!device) {
      return res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid device token' },
      });
    }

    // Constant-time comparison (belt-and-suspenders against timing attacks)
    const a = Buffer.from(device.tokenHash, 'hex');
    const b = Buffer.from(inputHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid device token' },
      });
    }

    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}
