/**
 * Notifier registry and interface definition.
 *
 * A Notifier must implement:
 *   { name: string, send(alert, device): Promise<void> }
 *
 * ## Adding a new Notifier
 *
 * 1. Create `src/services/notifier/myNotifier.js` exporting `{ name, send }`.
 * 2. Import it in `src/server.js` and call `notifierRegistry.register(myNotifier)`.
 * 3. No other code changes are needed — the registry dispatches automatically.
 *
 * Built-in:  InAppNotifier (alerts → MongoDB + SSE push)
 * Extension: WebPushNotifier  → send a Web Push notification to the PWA
 *            TelegramNotifier → send a Telegram message via the Bot API
 */
import { logger } from '../../middleware/logger.js';

class NotifierRegistry {
  constructor() {
    /** @type {Map<string, { name: string, send(alert, device): Promise<void> }>} */
    this._notifiers = new Map();
  }

  /**
   * Register a notifier. Duplicate `name` replaces the previous entry.
   * @param {{ name: string, send(alert, device): Promise<void> }} notifier
   */
  register(notifier) {
    if (typeof notifier?.send !== 'function') {
      throw new TypeError(`Notifier "${notifier?.name}" must have a send() method`);
    }
    this._notifiers.set(notifier.name, notifier);
    logger.info({ notifier: notifier.name }, 'Notifier registered');
  }

  /**
   * Dispatch an alert to all registered notifiers.
   * Failures in individual notifiers are logged but do not abort others.
   *
   * @param {object} alert   Mongoose Alert document
   * @param {object} device  Mongoose Device document
   */
  async notify(alert, device) {
    for (const notifier of this._notifiers.values()) {
      try {
        await notifier.send(alert, device);
      } catch (err) {
        logger.error({ err, notifier: notifier.name, alertId: alert._id }, 'Notifier failed');
      }
    }
  }
}

export const registry = new NotifierRegistry();
