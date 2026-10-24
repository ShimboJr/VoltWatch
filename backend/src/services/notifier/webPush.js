/**
 * WebPushNotifier — sends Web Push notifications to subscribed browsers.
 *
 * Registered in src/server.js alongside InAppNotifier.
 *
 * Alert-to-notification rules:
 *  - critical / HEARTBEAT_LOST  → urgency "high", requireInteraction, vibrate
 *  - high                       → urgency "high"
 *  - medium / info              → urgency "normal"
 *  - Quiet hours are respected (except critical, matching the alert engine rules)
 *  - alertsPaused devices: skipped
 *  - Backfill (reading older than 2 min): skipped — already handled upstream
 *
 * Dead-subscription cleanup:
 *  - 404 / 410 response → mark subscription dead immediately
 *  - Dead subs are hard-deleted by cleanupDeadSubscriptions() (called by a
 *    scheduled job or on server start).
 */

import webpush from 'web-push';
import { PushSubscription } from '../../models/PushSubscription.js';
import { logger }           from '../../middleware/logger.js';
import config               from '../../config/index.js';

// ── VAPID initialisation ─────────────────────────────────────────────────────

let _vapidReady = false;

export function initVapid() {
  const { vapidPublicKey, vapidPrivateKey, appOrigin } = config;

  if (!vapidPublicKey || !vapidPrivateKey) {
    logger.warn('VAPID keys not set — Web Push disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env');
    return false;
  }

  webpush.setVapidDetails(
    `mailto:${process.env.OWNER_EMAIL || 'owner@example.com'}`,
    vapidPublicKey,
    vapidPrivateKey,
  );

  _vapidReady = true;
  logger.info('WebPushNotifier: VAPID configured');
  return true;
}

// ── Urgency helpers ──────────────────────────────────────────────────────────

function _urgency(level, alertType) {
  if (level === 'critical' || alertType === 'HEARTBEAT_LOST') return 'high';
  if (level === 'high')   return 'high';
  return 'normal';
}

function _vibrate(level) {
  if (level === 'critical') return [200, 100, 200, 100, 600];
  if (level === 'high')     return [200, 100, 200];
  return [100];
}

// ── In-quiet-hours check ─────────────────────────────────────────────────────

function _inQuietHours(settings = {}) {
  if (!settings.quietHours?.enabled) return false;
  const now   = new Date();
  const hhmm  = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // The DB schema stores quietHours.from / quietHours.to (not start/end)
  const start = settings.quietHours.from || '22:00';
  const end   = settings.quietHours.to   || '07:00';

  // Handle overnight ranges (e.g. 22:00 → 07:00)
  if (start > end) {
    return hhmm >= start || hhmm < end;
  }
  return hhmm >= start && hhmm < end;
}

// ── Payload builder (pure, testable) ────────────────────────────────────────

/**
 * Build the Web Push payload for an alert.
 *
 * @param {object} alert  - Mongoose alert document (plain object OK)
 * @param {object} device - Mongoose device document
 * @param {object} settings - Owner settings document
 * @returns {{ payload: string, options: object } | null}  null = skip
 */
export function buildPayload(alert, device, settings = {}) {
  const level     = alert.level || 'info';
  const alertType = alert.type  || '';
  const isCrit    = level === 'critical' || alertType === 'HEARTBEAT_LOST';

  // Skip for quiet hours unless critical
  if (!isCrit && _inQuietHours(settings)) return null;

  // Skip if alerts paused (except critical)
  if (!isCrit && device.alertsPaused) return null;

  const urgency = _urgency(level, alertType);
  const icon    = level === 'critical' ? '🔴' : level === 'high' ? '🟠' : 'ℹ️';

  const title = isCrit
    ? `⚡ CRITICAL — ${device.name || 'Device'}`
    : `VoltWatch — ${device.name || 'Device'}`;

  const body = alert.message || alert.type || 'Battery alert';

  const data = {
    alertId:  String(alert._id),
    deviceId: String(device._id),
    url:      `${config.appOrigin || ''}/app#/alerts`,
    severity: level,
  };

  const payload = JSON.stringify({ title, body, icon, data, vibrate: _vibrate(level) });

  const options = {
    urgency,
    TTL: isCrit ? 3600 : 600,   // seconds
    topic: `alert-${alert._id}`, // replaces previous notification with same alertId
  };

  return { payload, options };
}

// ── Send ─────────────────────────────────────────────────────────────────────

async function _sendToSubscription(sub, payload, options) {
  const pushSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };

  try {
    await webpush.sendNotification(pushSub, payload, options);
    await PushSubscription.updateOne({ _id: sub._id }, { lastSuccessAt: new Date() });
    return { ok: true };
  } catch (err) {
    const statusCode = err.statusCode || 0;
    await PushSubscription.updateOne(
      { _id: sub._id },
      { lastErrorAt: new Date(), lastErrorCode: statusCode,
        dead: statusCode === 404 || statusCode === 410 },
    );
    return { ok: false, statusCode };
  }
}

// ── Notifier interface ───────────────────────────────────────────────────────

async function send(alert, device) {
  if (!_vapidReady) return;

  // VoltWatch is a single-owner app. Settings live on the User document.
  // Device has no userId field — fetch the single owner directly.
  const { User }        = await import('../../models/User.js');
  const { DEFAULT_SETTINGS } = await import('../../models/User.js');
  const owner   = await User.findOne({}).lean();
  if (!owner) {
    logger.warn('WebPush: no owner user found — skipping push');
    return;
  }
  const settings = { ...DEFAULT_SETTINGS, ...(owner.settings || {}) };

  const built = buildPayload(alert, device, settings);
  if (!built) return; // quiet hours or paused

  const { payload, options } = built;

  // Find all live subscriptions — query by the owner user's _id
  const subs = await PushSubscription.find({ userId: owner._id, dead: false }).lean();

  if (!subs.length) {
    logger.debug({ deviceId: device._id }, 'WebPush: no subscriptions');
    return;
  }

  const results = await Promise.allSettled(
    subs.map(sub => _sendToSubscription(sub, payload, options)),
  );

  const ok   = results.filter(r => r.value?.ok).length;
  const fail = results.length - ok;
  logger.info({ alertId: alert._id, ok, fail }, 'WebPush: sent');
}

export const WebPushNotifier = { name: 'WebPushNotifier', send };

// ── Dead-subscription cleanup ────────────────────────────────────────────────

/**
 * Hard-delete subscriptions marked dead (404/410).
 * Call periodically (e.g. every hour from a cron job or on server start).
 *
 * @returns {Promise<number>} count of deleted documents
 */
export async function cleanupDeadSubscriptions() {
  const result = await PushSubscription.deleteMany({ dead: true });
  if (result.deletedCount > 0) {
    logger.info({ deleted: result.deletedCount }, 'WebPush: dead subscriptions cleaned');
  }
  return result.deletedCount;
}
