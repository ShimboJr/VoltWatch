import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

/**
 * GET /api/v1/health
 * Public endpoint — no auth required.
 * Used by load balancers, uptime monitors, and the dashboard to verify the API is up.
 *
 * Also returns `lastReadingAt` (the most recent reading across ALL devices) so the
 * dashboard can show a "dead man" warning if the backend has not processed any reading
 * for an extended period — even when no individual device is alerting.
 */
router.get('/', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbOk    = dbState === 1;

  let lastReadingAt = null;
  let deadManWarning = false;

  if (dbOk) {
    try {
      // Import lazily to avoid circular deps and to keep cold-start fast
      const { Reading } = await import('../models/Reading.js');
      const last = await Reading.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean();
      if (last) {
        lastReadingAt = last.createdAt.toISOString();
        // Warn if no reading in the last 10 minutes (configurable via DEAD_MAN_SEC env)
        const deadManSec = parseInt(process.env.DEAD_MAN_SEC || '600', 10);
        deadManWarning = (Date.now() - last.createdAt.getTime()) > deadManSec * 1000;
      }
    } catch {
      // Non-fatal — don't fail health check if Reading query errors
    }
  }

  res.status(dbOk ? 200 : 503).json({
    ok:             dbOk,
    time:           new Date().toISOString(),
    db:             dbOk ? 'connected' : 'disconnected',
    lastReadingAt,
    deadManWarning, // true = backend has not seen any reading recently
  });
});

export default router;
