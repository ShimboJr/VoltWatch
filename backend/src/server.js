import mongoose from 'mongoose';
import { createApp } from './app.js';
import { bootstrapOwner } from './services/ownerBootstrap.js';
import { startRollupJob } from './services/rollupJob.js';
import { startOfflineWatcher } from './services/offlineWatcher.js';
import { startCriticalRepeatJob } from './services/criticalRepeatJob.js';
import { registry as notifierRegistry } from './services/notifier/index.js';
import { InAppNotifier }    from './services/notifier/inApp.js';
import { WebPushNotifier, initVapid, cleanupDeadSubscriptions } from './services/notifier/webPush.js';
import { logger } from './middleware/logger.js';
import config from './config/index.js';

const app = createApp();
let server;
const intervals = [];

async function start() {
  // ── Connect to MongoDB ────────────────────────────────────────────────────
  logger.info(
    { uri: config.mongoUri.replace(/\/\/.*@/, '//[credentials]@') },
    'Connecting to MongoDB',
  );
  await mongoose.connect(config.mongoUri);
  logger.info('MongoDB connected');

  // ── Seed owner user from environment ─────────────────────────────────────
  await bootstrapOwner();

  // ── Register notifiers ────────────────────────────────────────────────────
  notifierRegistry.register(InAppNotifier);
  if (initVapid()) {
    notifierRegistry.register(WebPushNotifier);
    // Clean up dead push subscriptions on boot, then every hour
    await cleanupDeadSubscriptions();
    intervals.push(setInterval(cleanupDeadSubscriptions, 3_600_000));
  }

  // ── Start background jobs ─────────────────────────────────────────────────
  intervals.push(startOfflineWatcher());
  intervals.push(startCriticalRepeatJob());
  intervals.push(startRollupJob());

  // ── Start HTTP server ─────────────────────────────────────────────────────
  server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'VoltWatch backend listening');
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');

  for (const handle of intervals) clearInterval(handle);

  if (server) {
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed');
  }

  await mongoose.disconnect();
  logger.info('MongoDB disconnected');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
