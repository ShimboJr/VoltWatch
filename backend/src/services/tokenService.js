import crypto from 'crypto';

/**
 * Generate a new device bearer token.
 * - 32 random bytes → base64url string (never stored)
 * - SHA-256 hex of the token is what gets stored in MongoDB
 *
 * @returns {{ token: string, tokenHash: string }}
 */
export function generateToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/**
 * Hash a plaintext token for storage or lookup.
 * @param {string} token
 * @returns {string} hex SHA-256 digest
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of a plaintext token against its stored hash.
 * Returns false immediately if lengths differ (avoids timing leak for that case).
 *
 * @param {string} token plaintext bearer token
 * @param {string} storedHash hex SHA-256
 * @returns {boolean}
 */
export function verifyToken(token, storedHash) {
  const inputHash = crypto.createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(inputHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
