/**
 * InApp Notifier — stores alerts in MongoDB (already done by the engine)
 * and pushes them in real time over the Server-Sent Events stream.
 *
 * To extend with Web Push, see WebPushNotifier extension stub below.
 */
import { broadcast } from '../../routes/stream.js';

export const InAppNotifier = {
  name: 'inapp',

  /**
   * Push the alert to all connected SSE clients.
   * The Alert has already been persisted to MongoDB by applyEffect().
   *
   * @param {object} alert   Mongoose Alert document (plain object)
   * @param {object} device  Mongoose Device document (plain object)
   */
  async send(alert, device) {
    broadcast('alert', {
      alert: {
        _id: alert._id,
        deviceId: alert.deviceId,
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        state: alert.state,
        createdAt: alert.createdAt,
        level: alert.level ?? null,
        cycleId: alert.cycleId ?? null,
      },
      device: { _id: device._id, name: device.name },
    });
  },
};

// ─── Extension point: WebPushNotifier ─────────────────────────────────────────
// import webpush from 'web-push';
// export const WebPushNotifier = {
//   name: 'webpush',
//   async send(alert, device) {
//     const subscriptions = await PushSubscription.find({});
//     const payload = JSON.stringify({ type: alert.type, message: alert.message, severity: alert.severity });
//     await Promise.allSettled(subscriptions.map(s => webpush.sendNotification(s, payload)));
//   },
// };

// ─── Extension point: TelegramNotifier ───────────────────────────────────────
// import fetch from 'node-fetch';
// export const TelegramNotifier = {
//   name: 'telegram',
//   async send(alert) {
//     const token = process.env.TELEGRAM_BOT_TOKEN;
//     const chatId = process.env.TELEGRAM_CHAT_ID;
//     if (!token || !chatId) return;
//     await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ chat_id: chatId, text: `[VoltWatch] ${alert.message}`, parse_mode: 'HTML' }),
//     });
//   },
// };
