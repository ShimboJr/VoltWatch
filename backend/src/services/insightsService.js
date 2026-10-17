/**
 * Insights service — computes aggregate statistics for a device over a time range.
 *
 * All calculations are done by aggregating MongoDB data; no external I/O.
 */
import mongoose from 'mongoose';
import { Reading } from '../models/Reading.js';
import { PowerEvent } from '../models/PowerEvent.js';

const RANGE_MS = {
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/**
 * Compute median of a numeric array (returns null for empty arrays).
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute all insights for a device over the given range.
 *
 * @param {mongoose.Types.ObjectId} deviceId
 * @param {string} range  '7d' | '30d'
 * @param {object} settings  Owner settings (for intervalSec)
 * @returns {Promise<object>}
 */
export async function computeInsights(deviceId, range, settings) {
  const rangeMs = RANGE_MS[range] ?? RANGE_MS['7d'];
  const from = new Date(Date.now() - rangeMs);
  const now = new Date();

  // ── Fetch readings and events in parallel ──────────────────────────────────
  const [readings, acEvents] = await Promise.all([
    Reading.find({ deviceId, deviceTime: { $gte: from } })
      .sort({ deviceTime: 1 })
      .lean(),
    PowerEvent.find({
      deviceId,
      type: { $in: ['AC_DISCONNECTED', 'AC_RECONNECTED'] },
      at: { $gte: from },
    })
      .sort({ at: 1 })
      .lean(),
  ]);

  // ── Agent availability % ───────────────────────────────────────────────────
  const intervalSec = settings.intervalSec ?? 45;
  const expectedReadings = Math.floor(rangeMs / 1000 / intervalSec);
  const agentAvailabilityPct =
    expectedReadings > 0
      ? Math.min(100, Math.round((readings.length / expectedReadings) * 1000) / 10)
      : null;

  // ── MT5 uptime % ──────────────────────────────────────────────────────────
  const mt5Uptime =
    readings.length > 0
      ? Math.round((readings.filter((r) => r.mt5Running).length / readings.length) * 1000) / 10
      : null;

  // ── Power-cut count (AC_DISCONNECTED events) ──────────────────────────────
  const acDisconnects = acEvents.filter((e) => e.type === 'AC_DISCONNECTED');
  const powerCutCount = acDisconnects.length;

  // ── Total minutes on battery ───────────────────────────────────────────────
  // Sum consecutive reading durations where acConnected=false
  let totalOnBatteryMs = 0;
  let prevOnBattery = null;
  let prevTime = null;

  for (const r of readings) {
    const t = new Date(r.deviceTime).getTime();
    if (prevTime !== null && prevOnBattery === true && !r.acConnected) {
      const gap = t - prevTime;
      // Only count if gap is within 3 agent intervals (not a silent gap)
      if (gap <= intervalSec * 1000 * 3) {
        totalOnBatteryMs += gap;
      }
    }
    prevOnBattery = !r.acConnected;
    prevTime = t;
  }
  const totalOnBatteryMin = Math.round(totalOnBatteryMs / 60_000);

  // ── Discharge rate (pct/hour) ─────────────────────────────────────────────
  // Group on-battery reading runs; compute rate for each run with >= 2 readings
  const dischargeRates = [];

  let runStart = null;
  let runReadings = [];

  for (const r of readings) {
    if (!r.acConnected && !r.charging) {
      if (!runStart) {
        runStart = new Date(r.deviceTime).getTime();
        runReadings = [r];
      } else {
        const gap = new Date(r.deviceTime).getTime() - new Date(runReadings[runReadings.length - 1].deviceTime).getTime();
        if (gap <= intervalSec * 1000 * 3) {
          runReadings.push(r);
        } else {
          // Gap too large — end this run and start a new one
          if (runReadings.length >= 3) {
            const durationH = (new Date(runReadings[runReadings.length - 1].deviceTime).getTime() - runStart) / 3_600_000;
            const pctDrop = runReadings[0].percent - runReadings[runReadings.length - 1].percent;
            if (durationH > 0 && pctDrop > 0) dischargeRates.push(pctDrop / durationH);
          }
          runStart = new Date(r.deviceTime).getTime();
          runReadings = [r];
        }
      }
    } else {
      // AC connected — end any battery run
      if (runReadings.length >= 3) {
        const durationH = (new Date(runReadings[runReadings.length - 1].deviceTime).getTime() - runStart) / 3_600_000;
        const pctDrop = runReadings[0].percent - runReadings[runReadings.length - 1].percent;
        if (durationH > 0 && pctDrop > 0) dischargeRates.push(pctDrop / durationH);
      }
      runStart = null;
      runReadings = [];
    }
  }

  // Flush final run
  if (runReadings.length >= 3) {
    const durationH = (new Date(runReadings[runReadings.length - 1].deviceTime).getTime() - (runStart ?? 0)) / 3_600_000;
    const pctDrop = runReadings[0].percent - runReadings[runReadings.length - 1].percent;
    if (durationH > 0 && pctDrop > 0) dischargeRates.push(pctDrop / durationH);
  }

  const avgDischargeRatePctPerHour =
    dischargeRates.length > 0
      ? Math.round((dischargeRates.reduce((s, r) => s + r, 0) / dischargeRates.length) * 10) / 10
      : null;

  const medianDischargeRatePctPerHour =
    dischargeRates.length > 0
      ? Math.round((median(dischargeRates) ?? 0) * 10) / 10
      : null;

  // ── Longest time on battery (single run) ──────────────────────────────────
  let longestOnBatteryMin = 0;
  let currentRunMs = 0;

  prevOnBattery = null;
  prevTime = null;

  for (const r of readings) {
    const t = new Date(r.deviceTime).getTime();
    const onBattery = !r.acConnected && !r.charging;

    if (onBattery) {
      if (prevTime !== null && prevOnBattery) {
        const gap = t - prevTime;
        if (gap <= intervalSec * 1000 * 3) currentRunMs += gap;
        else currentRunMs = 0; // reset on large gap
      }
    } else {
      longestOnBatteryMin = Math.max(longestOnBatteryMin, Math.round(currentRunMs / 60_000));
      currentRunMs = 0;
    }
    prevOnBattery = onBattery;
    prevTime = t;
  }
  longestOnBatteryMin = Math.max(longestOnBatteryMin, Math.round(currentRunMs / 60_000));

  // ── Longest silent gap ────────────────────────────────────────────────────
  let longestSilentGapMin = 0;
  for (let i = 1; i < readings.length; i++) {
    const gap = new Date(readings[i].deviceTime).getTime() - new Date(readings[i - 1].deviceTime).getTime();
    const gapMin = Math.round(gap / 60_000);
    if (gap > intervalSec * 3 * 1000) {
      longestSilentGapMin = Math.max(longestSilentGapMin, gapMin);
    }
  }

  // ── Power cuts by hour-of-day and day-of-week ─────────────────────────────
  const byHourOfDay = Array(24).fill(0);
  const byDayOfWeek = Array(7).fill(0);

  for (const event of acDisconnects) {
    const d = new Date(event.at);
    byHourOfDay[d.getUTCHours()]++;
    byDayOfWeek[d.getUTCDay()]++;
  }

  // ── Runway minutes now ────────────────────────────────────────────────────
  // current battery % / median discharge rate (pct/min); null while charging
  let runwayMinutesNow = null;
  if (medianDischargeRatePctPerHour) {
    const lastReading = readings[readings.length - 1];
    if (lastReading && !lastReading.acConnected) {
      const medianPctPerMin = medianDischargeRatePctPerHour / 60;
      runwayMinutesNow = Math.round(lastReading.percent / medianPctPerMin);
    }
  }

  return {
    range,
    from: from.toISOString(),
    to: now.toISOString(),
    readingCount: readings.length,
    agentAvailabilityPct,
    mt5UptimePct: mt5Uptime,
    powerCutCount,
    totalOnBatteryMin,
    longestOnBatteryMin,
    avgDischargeRatePctPerHour,
    medianDischargeRatePctPerHour,
    longestSilentGapMin,
    powerCutsByHourOfDay: byHourOfDay,
    powerCutsByDayOfWeek: byDayOfWeek,
    runwayMinutesNow,
  };
}
