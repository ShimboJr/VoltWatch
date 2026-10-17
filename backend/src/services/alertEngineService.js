/**
 * Alert Engine Service — applies effects returned by the pure evaluate()
 * function to MongoDB and dispatches notifications.
 *
 * This is the only file that performs I/O on behalf of the alert engine.
 */
import { evaluate } from './alertEngine.js';
import { Alert } from '../models/Alert.js';
import { Device } from '../models/Device.js';
import { PowerEvent } from '../models/PowerEvent.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import { registry as notifierRegistry } from './notifier/index.js';
import { logger } from '../middleware/logger.js';

// ─── Owner settings loader ────────────────────────────────────────────────────

/** @returns {Promise<object>} merged settings */
async function getSettings() {
  const user = await User.findOne({}).lean();
  return user ? { ...DEFAULT_SETTINGS, ...user.settings } : { ...DEFAULT_SETTINGS };
}

// ─── Effect applier ──────────────────────────────────────────────────────────

/**
 * Apply a single effect to the database.
 *
 * @param {object} effect
 * @param {import('../models/Device.js').Device} device
 * @returns {Promise<import('../models/Alert.js').Alert|null>}  Created alert, if any
 */
async function applyEffect(effect, device) {
  switch (effect.type) {
    case 'CREATE_ALERT': {
      const data = { ...effect.data, deviceId: device._id };
      let alert;
      try {
        alert = await Alert.create(data);
      } catch (err) {
        if (err.code === 11000) {
          // Duplicate dedupeKey — idempotent, not an error
          logger.debug({ dedupeKey: data.dedupeKey }, 'Duplicate alert dedupeKey — skipped');
          return null;
        }
        throw err;
      }
      // Send to all registered notifiers
      try {
        await notifierRegistry.notify(alert, device);
      } catch (err) {
        logger.error({ err, alertId: alert._id }, 'Notifier dispatch failed');
      }
      return alert;
    }

    case 'RESOLVE_ALERTS': {
      const { filter } = effect;
      await Alert.updateMany(
        { deviceId: device._id, ...filter, state: 'active' },
        { $set: { state: 'resolved', resolvedAt: new Date() } },
      );
      return null;
    }

    case 'RECORD_EVENT': {
      try {
        await PowerEvent.create({ ...effect.data, deviceId: device._id });
      } catch (err) {
        if (err.code === 11000) return null; // Unlikely but safe
        throw err;
      }
      return null;
    }

    case 'UPDATE_DEVICE': {
      await Device.updateOne({ _id: device._id }, { $set: effect.update });
      return null;
    }

    default:
      logger.warn({ effectType: effect.type }, 'Unknown alert engine effect type');
      return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Process a reading through the alert engine and apply all effects.
 *
 * Called by the agent heartbeat route after a reading is persisted.
 * `live=false` is set for batch/backfilled readings.
 *
 * @param {object} device   Mongoose Device document (lean or Mongoose object)
 * @param {object} reading  Mongoose Reading document
 * @param {{ live?: boolean }} opts
 */
export async function processReading(device, reading, { live = true } = {}) {
  if (!live) return; // Backfill check is also inside evaluate, but short-circuit here

  try {
    const settings = await getSettings();

    // Pre-fetch the one piece of DB state evaluate needs
    const heartbeatLostAlert = await Alert.findOne({
      deviceId: device._id,
      type: 'HEARTBEAT_LOST',
      state: 'active',
    }).lean();

    const state = {
      deviceId: device._id.toString(),
      currentCycleId: device.currentCycleId ?? 0,
      firedLevels: device.firedLevels ?? [],
      alertsPaused: device.alertsPaused ?? false,
      plannedStopUntil: device.plannedStopUntil ?? null,
      mt5OffSince: device.mt5OffSince ?? null,
      mt5AlertFired: device.mt5AlertFired ?? false,
      prevAcConnected: device.lastReading?.acConnected ?? null,
      prevMt5Running: device.lastReading?.mt5Running ?? null,
      hasActiveHeartbeatLostAlert: !!heartbeatLostAlert,
    };

    // Reading object with backfilled flag from the DB record
    const readingData = {
      readingId: reading.readingId,
      deviceTime: reading.deviceTime,
      kind: reading.kind ?? 'heartbeat',
      event: reading.event ?? null,
      percent: reading.percent,
      charging: reading.charging,
      acConnected: reading.acConnected,
      mt5Running: reading.mt5Running,
      backfilled: reading.backfilled ?? false,
    };

    const { effects } = evaluate(state, readingData, settings);

    for (const effect of effects) {
      await applyEffect(effect, device);
    }
  } catch (err) {
    logger.error({ err, deviceId: device._id }, 'Alert engine service error');
  }
}

/**
 * Apply effects directly — used by the offline watcher and repeat job.
 *
 * @param {object[]} effects
 * @param {object}   device
 */
export async function applyEffects(effects, device) {
  for (const effect of effects) {
    await applyEffect(effect, device);
  }
}
