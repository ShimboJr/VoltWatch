import { Reading } from '../models/Reading.js';
import { Alert } from '../models/Alert.js';
import { PowerEvent } from '../models/PowerEvent.js';
import { DEFAULT_SETTINGS } from '../models/User.js';

// ─── Linear regression ────────────────────────────────────────────────────────

/**
 * Ordinary least-squares linear regression.
 * x values are normalised to seconds from the first point to avoid float issues.
 *
 * @param {{ x: number, y: number }[]} points  x = ms timestamp, y = battery %
 * @returns {{ slopePctPerSec: number, interceptPct: number, xBase: number }|null}
 */
function linReg(points) {
  if (points.length < 2) return null;
  const xBase = points[0].x;
  const pts = points.map((p) => ({ x: (p.x - xBase) / 1000, y: p.y })); // x in seconds

  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom; // %/s
  const intercept = (sumY - slope * sumX) / n;

  return { slopePctPerSec: slope, interceptPct: intercept, xBase };
}

/**
 * Compute battery predictions from recent on-battery readings.
 * Guards: min 5 samples, all on battery, no charging/AC changes in window.
 *
 * @param {import('mongoose').Types.ObjectId} deviceId
 * @param {object} lastReading  device.lastReading
 * @returns {Promise<{ predictedEmptyAt: string|null, trendSecsLeft: number|null, drainRatePctPerHour: number|null }>}
 */
export async function computePrediction(deviceId, lastReading) {
  if (!lastReading || lastReading.acConnected) {
    return { predictedEmptyAt: null, trendSecsLeft: null, drainRatePctPerHour: null };
  }

  const windowMs = 15 * 60 * 1000; // 15 min
  const from = new Date(Date.now() - windowMs);

  const readings = await Reading.find({
    deviceId,
    deviceTime: { $gte: from },
    acConnected: false,
    charging: false,
  })
    .sort({ deviceTime: 1 })
    .select({ deviceTime: 1, percent: 1 })
    .lean();

  if (readings.length < 5) {
    return { predictedEmptyAt: null, trendSecsLeft: null, drainRatePctPerHour: null };
  }

  const points = readings.map((r) => ({
    x: new Date(r.deviceTime).getTime(),
    y: r.percent,
  }));

  const reg = linReg(points);
  if (!reg || reg.slopePctPerSec >= 0) {
    // Non-negative slope = battery is not draining
    return { predictedEmptyAt: null, trendSecsLeft: null, drainRatePctPerHour: null };
  }

  const { slopePctPerSec, interceptPct, xBase } = reg;

  // Seconds from xBase until percent = 0
  const secsToEmpty = -interceptPct / slopePctPerSec;
  const tEmptyMs = xBase + secsToEmpty * 1000;
  const nowMs = Date.now();
  const trendSecsLeft = Math.round((tEmptyMs - nowMs) / 1000);

  if (trendSecsLeft < 0) {
    return { predictedEmptyAt: null, trendSecsLeft: null, drainRatePctPerHour: null };
  }

  const drainRatePctPerHour = Math.round(Math.abs(slopePctPerSec) * 3600 * 10) / 10;

  return {
    predictedEmptyAt: new Date(tEmptyMs).toISOString(),
    trendSecsLeft,
    drainRatePctPerHour,
  };
}

// ─── Diagnosis heuristics ─────────────────────────────────────────────────────

/**
 * Generate a diagnosis object from device state (spec section 8).
 *
 * @param {object} device
 * @param {object|null} lastEvent  Most recent PowerEvent
 * @returns {{ likelyCause: string, confidence: string, reasons: string[] }|null}
 */
export function getDiagnosis(device, lastEvent) {
  const lr = device.lastReading;
  if (!lr) return null;

  // Planned stop or agent signalled graceful exit
  if (
    lastEvent?.type === 'AGENT_STOPPED_PLANNED' ||
    lastEvent?.type === 'SYSTEM_SHUTDOWN' ||
    (device.plannedStopUntil && new Date(device.plannedStopUntil) > new Date())
  ) {
    return {
      likelyCause: 'Laptop likely stopped by owner',
      confidence: 'likely',
      reasons: [`Last event was ${lastEvent?.type ?? 'planned stop'}`],
    };
  }

  // Battery exhausted
  if (!lr.acConnected && lr.percent <= 5) {
    return {
      likelyCause: 'Battery likely exhausted',
      confidence: 'likely',
      reasons: [`Last reading showed ${lr.percent}% on battery with no charger`],
    };
  }

  // Unexpected shutdown
  if (lastEvent?.type === 'UNEXPECTED_SHUTDOWN') {
    return {
      likelyCause: 'Laptop shut down unexpectedly',
      confidence: 'likely',
      reasons: ['Agent detected an unexpected shutdown at next start'],
    };
  }

  // Resumed from sleep then went silent → possibly sleeping again
  if (lastEvent?.type === 'RESUMED_FROM_SLEEP') {
    return {
      likelyCause: 'Laptop may have gone back to sleep',
      confidence: 'possible',
      reasons: ['Most recent event was RESUMED_FROM_SLEEP'],
    };
  }

  // Charger connected with healthy percent → internet or agent issue
  if (lr.acConnected && lr.percent > 20) {
    return {
      likelyCause: 'Internet loss, agent stopped, or laptop is sleeping',
      confidence: 'possible',
      reasons: [
        `Last reading: charger connected, battery at ${lr.percent}%`,
        'A healthy battery on AC that stops reporting is usually network or agent related',
      ],
    };
  }

  // Low battery on battery → power cut followed by drain
  if (!lr.acConnected && lr.percent <= 20) {
    return {
      likelyCause: 'Battery critical at last report; laptop may have shut down',
      confidence: 'likely',
      reasons: [`Battery was at ${lr.percent}% on battery when last seen`],
    };
  }

  return {
    likelyCause: 'Unknown — insufficient data',
    confidence: 'possible',
    reasons: [],
  };
}

// ─── Main derive-status ───────────────────────────────────────────────────────

/**
 * Compute the full status object from device state and owner settings.
 * No mutation — safe to call from any read path.
 *
 * @param {object} device  Mongoose device doc (lean or plain)
 * @param {object} settings  Merged owner settings
 * @param {{ predictions?: boolean }} opts
 * @returns {Promise<object>}
 */
export async function deriveStatus(device, settings, { predictions = true } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const now = Date.now();

  // ── Status ──────────────────────────────────────────────────────────────
  let status;
  if (!device.lastSeenAt) {
    status = 'NEVER_SEEN';
  } else if (device.plannedStopUntil && new Date(device.plannedStopUntil).getTime() > now) {
    status = 'PLANNED_STOP';
  } else {
    const ageSec = (now - new Date(device.lastSeenAt).getTime()) / 1000;
    if (ageSec <= s.staleAfterSec) status = 'ONLINE';
    else if (ageSec <= s.offlineAfterSec) status = 'STALE';
    else status = 'OFFLINE';
  }

  // ── Power ────────────────────────────────────────────────────────────────
  const lr = device.lastReading;
  let power = 'UNKNOWN';
  if (lr) {
    if (lr.charging) power = 'CHARGING';
    else if (lr.acConnected) power = 'PLUGGED_NOT_CHARGING';
    else power = 'ON_BATTERY';
  }

  // ── Severity ─────────────────────────────────────────────────────────────
  const activeAlerts = await Alert.find({ deviceId: device._id, state: 'active' })
    .sort({ createdAt: -1 })
    .lean();

  let severity;
  const SEVERITY_ORDER = ['critical', 'high', 'warning', 'info', 'ok', 'unknown'];
  if (activeAlerts.some((a) => a.severity === 'critical')) severity = 'critical';
  else if (activeAlerts.some((a) => a.severity === 'high')) severity = 'high';
  else if (activeAlerts.some((a) => a.severity === 'warning')) severity = 'warning';
  else if (status === 'OFFLINE') severity = 'critical';
  else if (status === 'STALE') severity = 'warning';
  else if (status === 'NEVER_SEEN') severity = 'unknown';
  else severity = 'ok';

  // ── onBatterySince ────────────────────────────────────────────────────────
  let onBatterySince = null;
  if (power === 'ON_BATTERY' || power === 'CHARGING') {
    const lastAcOff = await PowerEvent.findOne({
      deviceId: device._id,
      type: 'AC_DISCONNECTED',
    })
      .sort({ at: -1 })
      .lean();
    onBatterySince = lastAcOff?.at ?? null;
  }

  // ── batteryCycleDrainPct ──────────────────────────────────────────────────
  let batteryCycleDrainPct = null;
  if (power === 'ON_BATTERY' && onBatterySince && lr) {
    const firstReading = await Reading.findOne({
      deviceId: device._id,
      deviceTime: { $gte: onBatterySince },
      acConnected: false,
    })
      .sort({ deviceTime: 1 })
      .lean();

    if (firstReading) {
      batteryCycleDrainPct = Math.max(0, firstReading.percent - lr.percent);
    }
  }

  // ── Predictions (linear regression over last 15 min) ─────────────────────
  let predictedEmptyAt = null;
  let trendSecsLeft = null;
  let drainRatePctPerHour = null;

  if (predictions && (power === 'ON_BATTERY')) {
    ({ predictedEmptyAt, trendSecsLeft, drainRatePctPerHour } = await computePrediction(
      device._id,
      lr,
    ));
  }

  // ── Diagnosis ─────────────────────────────────────────────────────────────
  let diagnosis = null;
  if (status !== 'ONLINE') {
    const lastEvent = await PowerEvent.findOne({ deviceId: device._id })
      .sort({ at: -1 })
      .lean();
    diagnosis = getDiagnosis(device, lastEvent);
  }

  return {
    deviceStatus: status,
    power,
    severity,
    lastSeenAt: device.lastSeenAt ?? null,
    latestReading: lr
      ? {
          percent: lr.percent,
          charging: lr.charging,
          acConnected: lr.acConnected,
          secsLeft: lr.secsLeft ?? null,
          mt5Running: lr.mt5Running,
          deviceTime: lr.deviceTime,
          serverTime: lr.serverTime,
        }
      : null,
    predictedEmptyAt,
    trendSecsLeft,
    windowsSecsLeft: lr?.secsLeft ?? null,
    drainRatePctPerHour,
    onBatterySince,
    batteryCycleDrainPct,
    diagnosis,
    activeAlerts: activeAlerts.map((a) => ({
      _id: a._id,
      type: a.type,
      severity: a.severity,
      message: a.message,
      createdAt: a.createdAt,
    })),
  };
}
