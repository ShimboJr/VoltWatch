import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/authSession.js';
import { validate } from '../middleware/validate.js';
import { Alert } from '../models/Alert.js';
import { Device } from '../models/Device.js';
import { broadcast } from './stream.js';

const router = Router();
router.use(requireAuth);

// ── POST /api/v1/alerts/test ─────────────────────────────────────────────────
// Must be defined BEFORE /:id routes
router.post('/test', async (req, res, next) => {
  try {
    const device = await Device.findOne({}, { _id: 1 }).lean();
    const deviceId = device?._id ?? new mongoose.Types.ObjectId();

    // Remove any previously unresolved test alerts so the unique dedupeKey
    // constraint is never triggered on repeated clicks.
    await Alert.deleteMany({ type: 'TEST', state: { $in: ['active', 'acknowledged'] } });

    const alert = await Alert.create({
      deviceId,
      type:      'TEST',
      severity:  'info',
      message:   '✅ This is a test alert from VoltWatch. Notifications are working.',
      state:     'active',
      // Unique key per test run so the sparse unique index never conflicts.
      dedupeKey: `TEST:${Date.now()}`,
    });

    // Auto-resolve after 2 minutes
    setTimeout(async () => {
      try {
        await Alert.findByIdAndUpdate(alert._id, {
          $set: { state: 'resolved', resolvedAt: new Date() },
        });
      } catch {
        /* Non-fatal */
      }
    }, 2 * 60_000);

    // Broadcast over SSE
    broadcast('alert', { alert });
    res.status(201).json({ alert });
  } catch (err) {
    // Duplicate key (11000) can only happen if two requests race; treat as success-ish.
    if (err.code === 11000) {
      return res.status(429).json({ error: { code: 'TEST_IN_PROGRESS', message: 'A test alert was just created. Please wait a moment.' } });
    }
    next(err);
  }
});

// ── GET /api/v1/alerts?state=active|all&limit=50 ──────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { state = 'active', limit = '50' } = req.query;
    const query = {};

    if (state === 'active') {
      query.state = 'active';
    } else if (state !== 'all') {
      return res.status(422).json({
        error: { code: 'INVALID_PARAM', message: 'state must be "active" or "all"' },
      });
    }

    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const alerts = await Alert.find(query).sort({ createdAt: -1 }).limit(limitNum).lean();
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/alerts/:id/ack ───────────────────────────────────────────────
router.post('/:id/ack', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found' } });
    }

    const alert = await Alert.findByIdAndUpdate(
      id,
      { $set: { state: 'acknowledged', acknowledgedAt: new Date() } },
      { new: true },
    );

    if (!alert) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found' } });
    }

    broadcast('alert', { alert });
    res.json({ alert });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/alerts/:id/snooze ───────────────────────────────────────────
router.post(
  '/:id/snooze',
  validate(z.object({ minutes: z.number().int().min(1).max(1440) })),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found' } });
      }

      const snoozedUntil = new Date(Date.now() + req.body.minutes * 60_000);
      const alert = await Alert.findByIdAndUpdate(id, { $set: { snoozedUntil } }, { new: true });

      if (!alert) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found' } });
      }

      broadcast('alert', { alert });
      res.json({ alert });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
