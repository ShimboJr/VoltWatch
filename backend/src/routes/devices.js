import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/authSession.js';
import { validate } from '../middleware/validate.js';
import { Device } from '../models/Device.js';
import { Reading } from '../models/Reading.js';
import { ReadingRollup } from '../models/ReadingRollup.js';
import { PowerEvent } from '../models/PowerEvent.js';
import { Alert } from '../models/Alert.js';
import { User } from '../models/User.js';
import { generateToken } from '../services/tokenService.js';
import { deriveStatus } from '../services/statusService.js';
import { computeInsights } from '../services/insightsService.js';
import { DEFAULT_SETTINGS } from '../models/User.js';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resolve owner settings (falling back to defaults)
// ─────────────────────────────────────────────────────────────────────────────
async function getSettings() {
  const user = await User.findOne({}).lean();
  return user ? { ...DEFAULT_SETTINGS, ...user.settings } : { ...DEFAULT_SETTINGS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate ObjectId param
// ─────────────────────────────────────────────────────────────────────────────
function parseId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Readings downsampling
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_DEFS = {
  '1h':  { ms: 3_600_000,         bucketUnit: null,     bucketSize: null, useRollup: false },
  '6h':  { ms: 6 * 3_600_000,     bucketUnit: 'minute', bucketSize: 2,    useRollup: false },
  '24h': { ms: 24 * 3_600_000,    bucketUnit: 'minute', bucketSize: 5,    useRollup: false },
  '7d':  { ms: 7 * 86_400_000,    bucketUnit: 'hour',   bucketSize: 1,    useRollup: true  },
  '30d': { ms: 30 * 86_400_000,   bucketUnit: 'hour',   bucketSize: 3,    useRollup: true  },
};

/**
 * Downsample readings for a device over a range, returning ≤300 points.
 *
 * For 7d and 30d, reads from ReadingRollup (hourly pre-computed aggregates).
 * For shorter ranges, aggregates raw Reading documents via $dateTrunc.
 *
 * @param {mongoose.Types.ObjectId} deviceId
 * @param {string} range  '1h' | '6h' | '24h' | '7d' | '30d'
 * @param {object} settings  Owner settings (for intervalSec)
 * @returns {Promise<{ points: object[], gaps: object[] }>}
 */
async function getDownsampledReadings(deviceId, range, settings) {
  const def = RANGE_DEFS[range];
  const intervalMs = (settings.intervalSec || 45) * 1000;
  const from = new Date(Date.now() - def.ms);

  let points;
  let effectiveBucketMs;

  if (def.useRollup) {
    effectiveBucketMs = def.bucketSize * 3_600_000;

    if (def.bucketSize === 1) {
      // 7d: use hourly rollup directly (max 168 points)
      const rollups = await ReadingRollup.find({ deviceId, hour: { $gte: from } })
        .sort({ hour: 1 })
        .lean();

      points = rollups.map((r) => ({
        t: r.hour.toISOString(),
        percent: r.avgPercent,
        acConnected: null,
        charging: null,
        mt5Running: null,
      }));
    } else {
      // 30d: bucket hourly rollup into 3h buckets (max 240 points)
      const rollups = await ReadingRollup.aggregate([
        { $match: { deviceId, hour: { $gte: from } } },
        {
          $group: {
            _id: {
              $dateTrunc: { date: '$hour', unit: 'hour', binSize: def.bucketSize },
            },
            avgPercent: { $avg: '$avgPercent' },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      points = rollups.map((r) => ({
        t: r._id.toISOString(),
        percent: Math.round(r.avgPercent * 10) / 10,
        acConnected: null,
        charging: null,
        mt5Running: null,
      }));
    }
  } else if (!def.bucketUnit) {
    // 1h: return raw readings (max ~80 at 45s interval)
    effectiveBucketMs = intervalMs;
    const readings = await Reading.find({ deviceId, deviceTime: { $gte: from } })
      .sort({ deviceTime: 1 })
      .select({ deviceTime: 1, percent: 1, acConnected: 1, charging: 1, mt5Running: 1, _id: 0 })
      .lean();

    points = readings.map((r) => ({
      t: r.deviceTime.toISOString(),
      percent: r.percent,
      acConnected: r.acConnected,
      charging: r.charging,
      mt5Running: r.mt5Running,
    }));
  } else {
    // 6h → 2-min buckets (max 180); 24h → 5-min buckets (max 288)
    effectiveBucketMs = def.bucketSize * 60_000;

    const bucketedReadings = await Reading.aggregate([
      { $match: { deviceId, deviceTime: { $gte: from } } },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$deviceTime',
              unit: def.bucketUnit,
              binSize: def.bucketSize,
            },
          },
          percent: { $avg: '$percent' },
          acConnected: { $last: '$acConnected' },
          charging: { $last: '$charging' },
          mt5Running: { $last: '$mt5Running' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    points = bucketedReadings.map((r) => ({
      t: r._id.toISOString(),
      percent: Math.round(r.percent * 10) / 10,
      acConnected: r.acConnected,
      charging: r.charging,
      mt5Running: r.mt5Running,
    }));
  }

  // ── Gap detection ──────────────────────────────────────────────────────────
  // A gap is where consecutive output points are more than 3 agent intervals apart
  // (or more than 2 bucket widths apart for downsampled data — whichever is larger).
  const gapThresholdMs = Math.max(effectiveBucketMs * 2, 3 * intervalMs);
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const diff = new Date(points[i].t) - new Date(points[i - 1].t);
    if (diff > gapThresholdMs) {
      gaps.push({ from: points[i - 1].t, to: points[i].t });
    }
  }

  return { points, gaps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/devices
router.get('/', async (req, res, next) => {
  try {
    const raw = await Device.find({}, { tokenHash: 0 }).lean();
    // Remap lastReading → latestReading to match the frontend field name
    const devices = raw.map(({ lastReading, ...d }) => ({
      ...d,
      latestReading: lastReading ?? null,
    }));
    res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/devices
router.post(
  '/',
  validate(z.object({ name: z.string().min(1).max(100).trim() })),
  async (req, res, next) => {
    try {
      const { token, tokenHash } = generateToken();
      const device = await Device.create({ name: req.body.name, tokenHash });
      const { tokenHash: _omit, ...safeDevice } = device.toObject();
      res.status(201).json({ device: safeDevice, token });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/devices/:id
router.patch(
  '/:id',
  validate(
    z.object({
      name: z.string().min(1).max(100).trim().optional(),
      alertsPaused: z.boolean().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

      const device = await Device.findByIdAndUpdate(
        id,
        { $set: req.body },
        { new: true, projection: { tokenHash: 0 } },
      ).lean();

      if (!device) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
      }

      res.json({ device });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/devices/:id/rotate-token
router.post('/:id/rotate-token', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const { token, tokenHash } = generateToken();
    const device = await Device.findByIdAndUpdate(
      id,
      { $set: { tokenHash, tokenRotatedAt: new Date() } },
      { new: true },
    );

    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/devices/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const device = await Device.findById(id);
    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    await Promise.all([
      Reading.deleteMany({ deviceId: id }),
      ReadingRollup.deleteMany({ deviceId: id }),
      PowerEvent.deleteMany({ deviceId: id }),
      Alert.deleteMany({ deviceId: id }),
      Device.deleteOne({ _id: id }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/devices/:id/status
router.get('/:id/status', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const [device, settings] = await Promise.all([Device.findById(id).lean(), getSettings()]);

    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    const status = await deriveStatus(device, settings);
    res.json({ deviceId: id.toString(), ...status });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/devices/:id/readings?range=1h|6h|24h|7d|30d
router.get('/:id/readings', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const { range = '24h' } = req.query;
    if (!RANGE_DEFS[range]) {
      return res.status(422).json({
        error: { code: 'INVALID_RANGE', message: 'range must be one of: 1h, 6h, 24h, 7d, 30d' },
      });
    }

    const [device, settings] = await Promise.all([Device.findById(id), getSettings()]);
    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    const result = await getDownsampledReadings(id, range, settings);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/devices/:id/events?limit&before&types
router.get('/:id/events', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const device = await Device.findById(id);
    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const query = { deviceId: id };

    if (req.query.before) {
      const beforeDate = new Date(req.query.before);
      if (!isNaN(beforeDate)) query.at = { $lt: beforeDate };
    }

    if (req.query.types) {
      query.type = { $in: req.query.types.split(',').map((t) => t.trim()) };
    }

    const events = await PowerEvent.find(query).sort({ at: -1 }).limit(limit).lean();
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/devices/:id/insights?range=7d|30d
router.get('/:id/insights', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });

    const device = await Device.findById(id);
    if (!device) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    const { range = '7d' } = req.query;
    if (!['7d', '30d'].includes(range)) {
      return res.status(422).json({
        error: { code: 'INVALID_RANGE', message: 'range must be 7d or 30d' },
      });
    }

    const settings = await getSettings();
    const insights = await computeInsights(id, range, settings);
    res.json({ insights });
  } catch (err) {
    next(err);
  }
});

export default router;
