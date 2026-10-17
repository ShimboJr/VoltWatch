import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/authSession.js';
import { validate } from '../middleware/validate.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Settings validation schema (all fields optional for partial PUT)
// ─────────────────────────────────────────────────────────────────────────────

/** Keys whose changes cause the agent config version to bump. */
const AGENT_RELEVANT_KEYS = ['intervalSec', 'offlineAfterSec', 'staleAfterSec'];

const settingsSchema = z
  .object({
    thresholds: z
      .array(z.number().int().min(1).max(99))
      .min(1)
      .refine(
        (arr) => {
          // must be unique
          const unique = new Set(arr);
          if (unique.size !== arr.length) return false;
          // must be descending
          for (let i = 1; i < arr.length; i++) {
            if (arr[i] >= arr[i - 1]) return false;
          }
          return true;
        },
        { message: 'thresholds must be unique and in descending order' },
      )
      .optional(),
    criticalLevel: z.number().int().min(1).max(99).optional(),
    criticalRepeatMin: z.number().int().min(1).max(60).optional(),
    offlineAfterSec: z.number().int().min(60).max(900).optional(),
    staleAfterSec: z.number().int().min(30).max(300).optional(),
    intervalSec: z.number().int().min(30).max(60).optional(),
    mt5Alert: z.boolean().optional(),
    mt5DebounceSec: z.number().int().min(0).max(3600).optional(),
    quietHours: z
      .object({
        enabled: z.boolean(),
        from: z.string().regex(/^\d{2}:\d{2}$/, 'Invalid time format, use HH:MM'),
        to: z.string().regex(/^\d{2}:\d{2}$/, 'Invalid time format, use HH:MM'),
      })
      .optional(),
    alarmSound: z.string().min(1).max(50).optional(),
    alarmVolume: z.number().min(0).max(1).optional(),
    vibrate: z.boolean().optional(),
    theme: z.enum(['dark', 'light']).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    retentionDays: z.number().int().min(7).max(365).optional(),
  })
  .strict();

// ── GET /api/v1/settings ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }
    res.json({ settings: { ...DEFAULT_SETTINGS, ...user.settings } });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/v1/settings ─────────────────────────────────────────────────────
router.put('/', validate(settingsSchema), async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    const prevSettings = { ...DEFAULT_SETTINGS, ...user.settings };
    const incoming = req.body;

    // Bump configVersion if any agent-relevant key changes
    const agentChanged = AGENT_RELEVANT_KEYS.some(
      (k) => incoming[k] !== undefined && incoming[k] !== prevSettings[k],
    );

    const newSettings = { ...prevSettings, ...incoming };
    if (agentChanged) {
      newSettings.configVersion = (prevSettings.configVersion ?? 1) + 1;
    }

    user.settings = newSettings;
    user.markModified('settings');
    await user.save();

    res.json({ settings: user.settings });
  } catch (err) {
    next(err);
  }
});

export default router;
