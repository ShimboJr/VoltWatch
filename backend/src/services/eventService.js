import { PowerEvent } from '../models/PowerEvent.js';

/**
 * Record a power event for a device.
 *
 * @param {import('mongoose').Types.ObjectId | string} deviceId
 * @param {string} type One of the POWER_EVENT_TYPES constants
 * @param {object} [data]
 * @param {Date}   [data.at]       Defaults to now
 * @param {number} [data.percent]
 * @param {number} [data.cycleId]
 * @param {object} [data.meta]
 * @returns {Promise<import('../models/PowerEvent.js').PowerEvent>}
 */
export async function recordEvent(deviceId, type, data = {}) {
  return PowerEvent.create({
    deviceId,
    type,
    at: data.at ?? new Date(),
    percent: data.percent ?? null,
    meta: data.meta ?? {},
    cycleId: data.cycleId ?? 0,
  });
}
