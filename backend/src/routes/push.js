/**
 * push.js — Web Push subscription management routes.
 *
 * POST   /api/v1/push/subscribe    — register a push subscription
 * DELETE /api/v1/push/subscribe    — remove the current subscription
 * GET    /api/v1/push/subscriptions — list all subscriptions for the owner
 * PATCH  /api/v1/push/subscriptions/:id — rename a subscription
 * DELETE /api/v1/push/subscriptions/:id — remove a specific subscription
 * POST   /api/v1/push/test          — send a test push notification
 * GET    /api/v1/push/vapid-public-key — return the public VAPID key
 */

import { Router } from 'express';
import { z }      from 'zod';
import webpush    from 'web-push';

import { requireAuth }       from '../middleware/authSession.js';
import { PushSubscription }  from '../models/PushSubscription.js';
import { buildPayload }      from '../services/notifier/webPush.js';
import config                from '../config/index.js';
import { logger }            from '../middleware/logger.js';

const router = Router();

// All routes require session
router.use(requireAuth);

// ── Schemas ──────────────────────────────────────────────────────────────────

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
  label:    z.string().max(80).optional(),
  deviceId: z.string().optional(),
});

// ── GET /vapid-public-key ────────────────────────────────────────────────────

router.get('/vapid-public-key', (_req, res) => {
  if (!config.vapidPublicKey) {
    return res.status(503).json({ error: 'Web Push not configured on this server.' });
  }
  res.json({ publicKey: config.vapidPublicKey });
});

// ── POST /subscribe ──────────────────────────────────────────────────────────

router.post('/subscribe', async (req, res, next) => {
  try {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid subscription', details: parsed.error.flatten() });
    }

    const { endpoint, keys, label = '', deviceId = '' } = parsed.data;
    const userId   = req.user._id;
    const ua       = (req.headers['user-agent'] || '').slice(0, 200);

    // Upsert by endpoint — idempotent if the browser re-registers
    const sub = await PushSubscription.findOneAndUpdate(
      { endpoint },
      { userId, endpoint, keys, label, deviceId, userAgent: ua, dead: false },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(201).json({ subscription: { _id: sub._id, label, userAgent: ua } });
  } catch (err) {
    next(err);
  }
});

// ── GET /subscriptions ───────────────────────────────────────────────────────

router.get('/subscriptions', async (req, res, next) => {
  try {
    const subs = await PushSubscription
      .find({ userId: req.user._id, dead: false })
      .select('_id label userAgent deviceId createdAt lastSuccessAt lastErrorAt lastErrorCode')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ subscriptions: subs });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /subscriptions/:id ─────────────────────────────────────────────────

router.patch('/subscriptions/:id', async (req, res, next) => {
  try {
    const label = String(req.body.label || '').slice(0, 80);
    const sub   = await PushSubscription.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { label },
      { new: true },
    ).lean();

    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json({ subscription: sub });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /subscribe (current endpoint) ─────────────────────────────────────

router.delete('/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    await PushSubscription.deleteOne({ endpoint, userId: req.user._id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── DELETE /subscriptions/:id (by ID) ────────────────────────────────────────

router.delete('/subscriptions/:id', async (req, res, next) => {
  try {
    const result = await PushSubscription.deleteOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!result.deletedCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── POST /test ───────────────────────────────────────────────────────────────

router.post('/test', async (req, res, next) => {
  try {
    if (!config.vapidPublicKey) {
      return res.status(503).json({ error: 'Web Push not configured.' });
    }

    const subs = await PushSubscription
      .find({ userId: req.user._id, dead: false })
      .lean();

    if (!subs.length) {
      return res.status(404).json({ error: 'No push subscriptions found. Register one first.' });
    }

    const fakeAlert  = { _id: 'test', level: 'high', type: 'TEST', message: 'VoltWatch test notification — if you see this, push is working! 🎉' };
    const fakeDevice = { _id: 'test', name: 'Test device', alertsPaused: false, userId: req.user._id };
    const built = buildPayload(fakeAlert, fakeDevice, {});

    let ok = 0, fail = 0;

    await Promise.allSettled(subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          built.payload,
          { ...built.options, urgency: 'high' },
        );
        ok++;
      } catch (err) {
        fail++;
        logger.warn({ endpoint: sub.endpoint, status: err.statusCode }, 'Test push failed');
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.updateOne({ _id: sub._id }, { dead: true });
        }
      }
    }));

    res.json({ sent: ok, failed: fail, total: subs.length });
  } catch (err) {
    next(err);
  }
});

export default router;
