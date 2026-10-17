import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import config from '../config/index.js';
import { logger } from '../middleware/logger.js';

/**
 * Upsert the single owner user from environment variables.
 * Called once at server startup. Safe to call multiple times (idempotent).
 *
 * The OWNER_PASSWORD_HASH must already be an argon2id hash produced by
 * `npm run hash-password <password>`.
 */
export async function bootstrapOwner() {
  const { ownerEmail, ownerPasswordHash } = config;

  if (!ownerEmail || !ownerPasswordHash) {
    logger.warn('OWNER_EMAIL or OWNER_PASSWORD_HASH not set — skipping owner bootstrap');
    return;
  }

  const existing = await User.findOne({ email: ownerEmail });
  if (existing) {
    logger.info({ email: ownerEmail }, 'Owner user already exists');
    return;
  }

  await User.create({
    email: ownerEmail,
    passwordHash: ownerPasswordHash,
    settings: { ...DEFAULT_SETTINGS },
  });

  logger.info({ email: ownerEmail }, 'Owner user bootstrapped from environment');
}
