import mongoose from 'mongoose';
import { Reading } from '../models/Reading.js';
import { ReadingRollup } from '../models/ReadingRollup.js';
import { Device } from '../models/Device.js';
import { logger } from '../middleware/logger.js';

/**
 * Compute and upsert the hourly rollup for every device for the given hour.
 * Idempotent — safe to call multiple times for the same hour.
 *
 * @param {Date} hour UTC floor-of-hour timestamp
 */
export async function computeRollupForHour(hour) {
  const hourEnd = new Date(hour.getTime() + 3_600_000);

  const devices = await Device.find({}, { _id: 1 }).lean();
  let computed = 0;

  for (const { _id: deviceId } of devices) {
    const [agg] = await Reading.aggregate([
      {
        $match: {
          deviceId: new mongoose.Types.ObjectId(deviceId),
          deviceTime: { $gte: hour, $lt: hourEnd },
        },
      },
      {
        $group: {
          _id: null,
          minPercent: { $min: '$percent' },
          maxPercent: { $max: '$percent' },
          avgPercent: { $avg: '$percent' },
          samples: { $sum: 1 },
          onBatterySamples: { $sum: { $cond: [{ $eq: ['$acConnected', false] }, 1, 0] } },
        },
      },
    ]);

    if (!agg) continue;

    await ReadingRollup.findOneAndUpdate(
      { deviceId, hour },
      {
        $set: {
          minPercent: agg.minPercent,
          maxPercent: agg.maxPercent,
          avgPercent: Math.round(agg.avgPercent * 10) / 10,
          samples: agg.samples,
          onBatterySamples: agg.onBatterySamples,
        },
      },
      { upsert: true },
    );

    computed++;
  }

  logger.info({ hour, devicesComputed: computed }, 'Hourly rollup complete');
}

/**
 * Start the hourly rollup background job.
 * At the top of each hour it rolls up the previous hour.
 *
 * @returns {NodeJS.Timeout} The interval handle (call clearInterval to stop)
 */
export function startRollupJob() {
  async function run() {
    const now = new Date();
    const prevHour = new Date(now);
    prevHour.setUTCMinutes(0, 0, 0);
    prevHour.setUTCHours(prevHour.getUTCHours() - 1);

    try {
      await computeRollupForHour(prevHour);
    } catch (err) {
      logger.error({ err }, 'Rollup job failed');
    }
  }

  return setInterval(run, 3_600_000);
}
