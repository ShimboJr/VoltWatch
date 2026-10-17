/**
 * Critical-repeat job — runs every 30 seconds.
 *
 * For every active CRITICAL_BATTERY alert whose condition still holds
 * (device still on battery, still below criticalLevel, not acknowledged,
 * not snoozed) and whose `lastRepeatAt` is older than `criticalRepeatMin`
 * minutes, update `lastRepeatAt` and re-dispatch all notifiers.
 */
import { Alert } from '../models/Alert.js';
import { Device } from '../models/Device.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import { registry as notifierRegistry } from './notifier/index.js';
import { logger } from '../middleware/logger.js';

async function getSettings() {
  const user = await User.findOne({}).lean();
  return user ? { ...DEFAULT_SETTINGS, ...user.settings } : { ...DEFAULT_SETTINGS };
}

export async function runCriticalRepeat() {
  const settings = await getSettings();
  const now = new Date();
  const repeatWindowMs = (settings.criticalRepeatMin ?? 5) * 60_000;
  const repeatCutoff = new Date(now.getTime() - repeatWindowMs);

  // Find active critical battery alerts that have not been repeated recently
  // and are not currently snoozed or acknowledged
  const alerts = await Alert.find({
    type: 'CRITICAL_BATTERY',
    state: 'active',
    acknowledgedAt: null,
    $and: [
      { $or: [{ lastRepeatAt: null }, { lastRepeatAt: { $lt: repeatCutoff } }] },
      { $or: [{ snoozedUntil: null }, { snoozedUntil: { $lt: now } }] },
    ],
  }).lean();

  for (const alert of alerts) {
    const device = await Device.findById(alert.deviceId).lean();
    if (!device?.lastReading) continue;

    const { percent, acConnected } = device.lastReading;

    // If condition no longer holds, resolve the alert
    if (acConnected || percent > (settings.criticalLevel ?? 15)) {
      await Alert.findByIdAndUpdate(alert._id, {
        $set: { state: 'resolved', resolvedAt: now },
      });
      continue;
    }

    // Update repeat timestamp and re-notify
    await Alert.findByIdAndUpdate(alert._id, { $set: { lastRepeatAt: now } });

    try {
      await notifierRegistry.notify(alert, device);
    } catch (err) {
      logger.error({ err, alertId: alert._id }, 'Critical repeat notifier failed');
    }

    logger.info({ alertId: alert._id, deviceId: device._id, percent }, 'Critical alert repeat sent');
  }
}

/**
 * Start the critical-repeat interval (checked every 30 s; actual repeat cadence
 * is controlled by `settings.criticalRepeatMin`).
 *
 * @returns {NodeJS.Timeout}
 */
export function startCriticalRepeatJob() {
  const handle = setInterval(async () => {
    try {
      await runCriticalRepeat();
    } catch (err) {
      logger.error({ err }, 'Critical repeat job error');
    }
  }, 30_000);

  logger.info('Critical repeat job started (30 s poll interval)');
  return handle;
}
