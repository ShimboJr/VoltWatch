import { Router } from 'express';
import { z } from 'zod';
import { requireDeviceAuth } from '../middleware/agentAuth.js';
import { agentRateLimit } from '../middleware/rateLimiter.js';
import { validate } from '../middleware/validate.js';
import { Reading } from '../models/Reading.js';
import { Device } from '../models/Device.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import { processReading } from '../services/alertEngineService.js';
import { recordEvent } from '../services/eventService.js';
import { broadcastStatus } from './stream.js';

const router = Router();

// Every agent route requires a valid device bearer token and is rate-limited
router.use(requireDeviceAuth, agentRateLimit);

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_VALUES = [
  'ac_connected',
  'ac_disconnected',
  'agent_started',
  'agent_stopping_planned',
  'system_shutdown',
  'resumed_from_sleep',
  'unexpected_shutdown_detected',
  'mt5_started',
  'mt5_stopped',
];

const readingSchema = z
  .object({
    readingId: z.string().uuid(),
    deviceTime: z.string().datetime(),
    kind: z.enum(['heartbeat', 'event']),
    event: z.enum(EVENT_VALUES).nullable().default(null),
    percent: z.number().min(0).max(100),
    charging: z.boolean(),
    acConnected: z.boolean(),
    secsLeft: z.number().nullable().optional().default(null),
    mt5Running: z.boolean(),
    uptimeSec: z.number().min(0),
    internetLatencyMs: z.number().nullable().optional().default(null),
    agentVersion: z.string(),
    hostname: z.string(),
    meta: z.record(z.unknown()).optional().default({}),
  })
  .refine(
    (d) => d.kind !== 'event' || d.event !== null,
    { message: 'event field is required when kind is "event"' },
  );

const batchSchema = z.object({
  readings: z.array(readingSchema).min(1).max(500),
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-event → PowerEvent type map
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_TYPE_MAP = {
  ac_connected: 'AC_RECONNECTED',
  ac_disconnected: 'AC_DISCONNECTED',
  agent_started: 'AGENT_STARTED',
  agent_stopping_planned: 'AGENT_STOPPED_PLANNED',
  system_shutdown: 'SYSTEM_SHUTDOWN',
  resumed_from_sleep: 'RESUMED_FROM_SLEEP',
  unexpected_shutdown_detected: 'UNEXPECTED_SHUTDOWN',
  mt5_started: 'MT5_STARTED',
  mt5_stopped: 'MT5_STOPPED',
};

// ─────────────────────────────────────────────────────────────────────────────
// Core ingest function (shared by heartbeat and batch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist one reading and update device state.
 *
 * @param {import('../models/Device.js').Device} device Mongoose document
 * @param {object} body  Parsed/validated heartbeat payload
 * @param {{ backfilled?: boolean }} opts
 * @returns {Promise<{ duplicate: boolean, reading?: object }>}
 */
async function ingestReading(device, body, { backfilled = false } = {}) {
  const serverTime = new Date();
  const deviceTime = new Date(body.deviceTime);

  // Reject device times that are implausibly far in the future
  if (deviceTime.getTime() > serverTime.getTime() + 24 * 3_600_000) {
    const err = new Error('deviceTime is more than 24 hours in the future');
    err.status = 422;
    err.code = 'INVALID_DEVICE_TIME';
    throw err;
  }

  // Idempotency: duplicate readingId is a silent success
  const exists = await Reading.exists({ deviceId: device._id, readingId: body.readingId });
  if (exists) return { duplicate: true };

  const reading = await Reading.create({
    deviceId: device._id,
    readingId: body.readingId,
    deviceTime,
    serverTime,
    kind: body.kind ?? 'heartbeat',
    event: body.event ?? null,
    percent: body.percent,
    charging: body.charging,
    acConnected: body.acConnected,
    secsLeft: body.secsLeft ?? null,
    mt5Running: body.mt5Running,
    uptimeSec: body.uptimeSec,
    internetLatencyMs: body.internetLatencyMs ?? null,
    cycleId: device.currentCycleId,
    backfilled,
  });

  // ── Device state update ──────────────────────────────────────────────────
  const deviceUpdate = {
    lastSeenAt: serverTime,
    hostname: body.hostname,
    agentVersion: body.agentVersion,
    lastReading: {
      percent: body.percent,
      charging: body.charging,
      acConnected: body.acConnected,
      secsLeft: body.secsLeft ?? null,
      mt5Running: body.mt5Running,
      deviceTime,
      serverTime,
    },
  };

  // Handle planned-stop events
  if (body.event === 'agent_stopping_planned' || body.event === 'system_shutdown') {
    deviceUpdate.plannedStopUntil = new Date(serverTime.getTime() + 15 * 60_000);
  }

  // Clear plannedStopUntil when the agent signals it's back
  if (body.event === 'agent_started' || (!backfilled && !deviceUpdate.plannedStopUntil)) {
    // Don't clear it here — only clear when the next normal heartbeat arrives
    // after plannedStopUntil has elapsed (handled at read time in deriveStatus)
  }

  // AC cycle management is handled exclusively by the alert engine (processReading below).
  // Do NOT update currentCycleId or firedLevels here — doing so causes a double-increment
  // that corrupts alert dedupeKeys and silently drops AC_DISCONNECTED alerts.

  await device.updateOne({ $set: deviceUpdate });

  // ── Power events ─────────────────────────────────────────────────────────
  if (body.kind === 'event' && body.event && EVENT_TYPE_MAP[body.event]) {
    await recordEvent(device._id, EVENT_TYPE_MAP[body.event], {
      at: deviceTime,
      percent: body.percent,
      cycleId: device.currentCycleId,
      meta: body.meta,
    });
  }

  // ── Alert engine ──────────────────────────────────────────────────────────
  const liveThresholdMs = 2 * 60_000;
  const live = !backfilled && serverTime.getTime() - deviceTime.getTime() < liveThresholdMs;
  // Reload the latest device state so alert engine sees correct firedLevels etc.
  const freshDevice = await Device.findById(device._id).lean();
  if (freshDevice) await processReading(freshDevice, reading, { live });

  // Broadcast status update over SSE after every live accepted reading
  if (live) {
    const user = await User.findOne({}).lean();
    const settings = user ? { ...DEFAULT_SETTINGS, ...user.settings } : { ...DEFAULT_SETTINGS };
    await broadcastStatus(device._id, settings);
  }

  return { duplicate: false, reading };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agent/heartbeat
// ─────────────────────────────────────────────────────────────────────────────
router.post('/heartbeat', validate(readingSchema), async (req, res, next) => {
  try {
    const result = await ingestReading(req.device, req.body);

    if (result.duplicate) {
      return res.json({ duplicate: true });
    }

    const user = await User.findOne({}).lean();
    const settings = user ? { ...DEFAULT_SETTINGS, ...user.settings } : DEFAULT_SETTINGS;

    res.json({
      serverTime: new Date().toISOString(),
      config: {
        intervalSec: settings.intervalSec,
        configVersion: settings.configVersion,
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agent/batch
// ─────────────────────────────────────────────────────────────────────────────
router.post('/batch', validate(batchSchema), async (req, res, next) => {
  try {
    const { readings } = req.body;
    const serverNow = new Date();

    // Process in ascending deviceTime order
    const sorted = [...readings].sort(
      (a, b) => new Date(a.deviceTime) - new Date(b.deviceTime),
    );

    const summary = { processed: 0, duplicates: 0, errors: 0 };

    for (const item of sorted) {
      try {
        // All items from the batch endpoint are considered backfilled
        const result = await ingestReading(req.device, item, { backfilled: true });
        if (result.duplicate) summary.duplicates++;
        else summary.processed++;
      } catch {
        summary.errors++;
      }
    }

    res.json({ ...summary, serverTime: serverNow.toISOString() });
  } catch (err) {
    next(err);
  }
});

export default router;
