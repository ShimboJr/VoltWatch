/**
 * Offline watcher — runs every 30 seconds.
 *
 * Finds devices that have exceeded `offlineAfterSec` without a heartbeat
 * and are not in a planned stop. Creates ONE HEARTBEAT_LOST alert per
 * offline episode (idempotent via dedupeKey based on lastSeenAt timestamp).
 *
 * The derived status (`OFFLINE`) is computed at read time from `lastSeenAt`,
 * so this job can be stopped without breaking the dashboard — it only controls
 * whether the push-alert fires.
 */
import { Device } from '../models/Device.js';
import { Alert } from '../models/Alert.js';
import { PowerEvent } from '../models/PowerEvent.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import { registry as notifierRegistry } from './notifier/index.js';
import { MSG } from './alertEngine.js';
import { logger } from '../middleware/logger.js';

async function getSettings(userId) {
  const user = userId
    ? await User.findById(userId).lean()
    : await User.findOne({}).lean();
  return user ? { ...DEFAULT_SETTINGS, ...user.settings } : { ...DEFAULT_SETTINGS };
}

/**
 * Single pass of the offline check. Safe to call concurrently from multiple
 * instances — the unique dedupeKey on Alert prevents double-firing.
 */
export async function runOfflineCheck() {
  const now = new Date();
  // Use default offlineAfterSec for the broad DB query — each device's actual
  // threshold is checked per-device inside the loop using the owner's settings.
  const cutoff = new Date(now.getTime() - DEFAULT_SETTINGS.offlineAfterSec * 1000);

  // Devices offline and not in a planned stop window
  const devices = await Device.find({
    lastSeenAt: { $lt: cutoff, $ne: null },
    $or: [{ plannedStopUntil: null }, { plannedStopUntil: { $lt: now } }],
  }).lean();

  for (const device of devices) {
    // Load the device owner's settings (correct per-user thresholds)
    const settings = await getSettings(device.userId);
    const ownerCutoff = new Date(now.getTime() - settings.offlineAfterSec * 1000);

    // If the device hasn't crossed this owner's specific threshold yet, skip it
    if (device.lastSeenAt >= ownerCutoff) continue;

    const episodeId = device.lastSeenAt.getTime();
    const dedupeKey = `${device._id}:HEARTBEAT_LOST:${episodeId}`;

    // Already fired for this offline episode — skip
    const exists = await Alert.exists({ dedupeKey });
    if (exists) continue;

    const offlineMinutes = Math.round((now.getTime() - device.lastSeenAt.getTime()) / 60_000);

    let alert;
    try {
      alert = await Alert.create({
        deviceId: device._id,
        type: 'HEARTBEAT_LOST',
        severity: 'critical',
        message: MSG.heartbeatLost(offlineMinutes),
        dedupeKey,
      });
    } catch (err) {
      if (err.code === 11000) continue; // Race condition — other instance beat us
      logger.error({ err, deviceId: device._id }, 'Failed to create HEARTBEAT_LOST alert');
      continue;
    }

    try {
      await PowerEvent.create({
        deviceId: device._id,
        userId: device.userId,
        type: 'HEARTBEAT_LOST',
        at: now,
        percent: device.lastReading?.percent ?? null,
      });
    } catch {
      /* Non-fatal */
    }

    try {
      await notifierRegistry.notify(alert, device);
    } catch (err) {
      logger.error({ err, alertId: alert._id }, 'Notifier failed for HEARTBEAT_LOST');
    }

    logger.warn({ deviceId: device._id, offlineMinutes }, 'HEARTBEAT_LOST alert created');
  }
}

/**
 * Start the offline-watcher interval.
 * @returns {NodeJS.Timeout} Handle (call clearInterval to stop)
 */
export function startOfflineWatcher() {
  const handle = setInterval(async () => {
    try {
      await runOfflineCheck();
    } catch (err) {
      logger.error({ err }, 'Offline watcher error');
    }
  }, 30_000);

  logger.info('Offline watcher started (30 s interval)');
  return handle;
}
