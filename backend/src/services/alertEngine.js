/**
 * VoltWatch Alert Engine — pure, I/O-free evaluate function.
 *
 * `evaluate(state, reading, settings, now)` takes a snapshot of device state,
 * a single reading, and owner settings, and returns:
 *   { nextState, effects[] }
 *
 * Callers apply effects to MongoDB; this file has zero I/O so it is
 * trivially testable without mocking.
 *
 * Effect types:
 *   CREATE_ALERT  { type, severity, level?, cycleId?, message, dedupeKey? }
 *   RESOLVE_ALERTS { filter: { type } }
 *   RECORD_EVENT  { type, at, percent, cycleId?, meta? }
 *   UPDATE_DEVICE { currentCycleId, firedLevels, mt5OffSince, mt5AlertFired }
 */

// ─── Message templates (must match spec section 6 exactly) ──────────────────
export const MSG = {
  acDisconnected: (pct, mt5) =>
    `⚡ Your laptop is now running on battery. Current charge: ${pct}%. MT5 is ${mt5 ? 'running' : 'not running'}.`,

  lowBattery: (pct) =>
    `⚠️ Battery is at ${pct}%. Your laptop is still running. Please restore power.`,

  criticalBattery: (pct) =>
    `🚨 Battery is at ${pct}%. MT5 may stop if the laptop shuts down. Take immediate action.`,

  heartbeatLost: (n) =>
    `No heartbeat received for ${n} minutes. The laptop may have lost power, lost internet, or the monitoring agent may have stopped.`,

  heartbeatRecovered: (pct, chargingState) =>
    `Laptop is reporting again. Battery ${pct}%, ${chargingState}.`,

  acReconnected: (pct) =>
    `🔌 Charger connected. Battery ${pct}%.`,

  mt5NotRunning: () =>
    `MT5 is not running on the laptop.`,

  unexpectedShutdown: () =>
    `The laptop shut down unexpectedly (detected at next start).`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine the severity for a LOW_BATTERY alert based on the threshold level.
 * @param {number} level  Threshold that was crossed (e.g. 50, 30, 20)
 * @returns {'info'|'warning'|'high'}
 */
export function lowBatterySeverity(level) {
  if (level >= 50) return 'info';
  if (level >= 30) return 'warning';
  return 'high'; // 20 and similar
}

/**
 * Check whether the current time falls inside the configured quiet hours.
 * Quiet hours never mute 'critical' alerts — the caller handles that.
 *
 * @param {{ enabled: boolean, from: string, to: string }} quietHours
 * @param {Date} now
 * @param {string} timeZone  IANA timezone string
 * @returns {boolean}
 */
export function isInQuietHours(quietHours, now, timeZone = 'UTC') {
  if (!quietHours?.enabled) return false;

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    const cur = h * 60 + m;

    const [fh, fm] = (quietHours.from || '23:00').split(':').map(Number);
    const [th, tm] = (quietHours.to || '06:00').split(':').map(Number);
    const from = fh * 60 + fm;
    const to = th * 60 + tm;

    return from < to
      ? cur >= from && cur < to        // same day (e.g. 01:00–06:00)
      : cur >= from || cur < to;        // crosses midnight (e.g. 23:00–06:00)
  } catch {
    return false;
  }
}

/**
 * Charging-state string used in HEARTBEAT_RECOVERED message.
 * @param {{ charging: boolean, acConnected: boolean }} reading
 * @returns {string}
 */
function chargingStateLabel(reading) {
  if (reading.charging) return 'charging';
  if (reading.acConnected) return 'plugged in (not charging)';
  return 'on battery';
}

// ─── Main evaluate function ───────────────────────────────────────────────────

/**
 * Pure evaluation of what alerts/events to produce for a single reading.
 *
 * @param {object} state
 *   @param {string}   state.deviceId
 *   @param {number}   state.currentCycleId
 *   @param {number[]} state.firedLevels
 *   @param {boolean}  state.alertsPaused
 *   @param {Date|null} state.plannedStopUntil
 *   @param {Date|null} state.mt5OffSince
 *   @param {boolean}  state.mt5AlertFired
 *   @param {boolean|null} state.prevAcConnected   From device.lastReading
 *   @param {boolean|null} state.prevMt5Running    From device.lastReading
 *   @param {boolean}  state.hasActiveHeartbeatLostAlert
 *
 * @param {object} reading  Validated heartbeat/event payload (+ backfilled flag)
 * @param {object} settings Owner settings
 * @param {Date}   now      Current time (injected for determinism)
 *
 * @returns {{ nextState: object, effects: object[] }}
 */
export function evaluate(state, reading, settings, now = new Date()) {
  const effects = [];

  // Clone state so we can produce the next state immutably
  const nextState = {
    currentCycleId: state.currentCycleId,
    firedLevels: [...(state.firedLevels || [])],
    mt5OffSince: state.mt5OffSince ? new Date(state.mt5OffSince) : null,
    mt5AlertFired: state.mt5AlertFired ?? false,
  };

  // ── 1. Backfilled readings never produce live alerts ──────────────────────
  if (reading.backfilled) return { nextState, effects };

  const readingAge = now.getTime() - new Date(reading.deviceTime).getTime();
  if (readingAge > 2 * 60 * 1000) return { nextState, effects };

  // ── 2. Mute all non-critical alerts if alertsPaused ───────────────────────
  if (state.alertsPaused) return { nextState, effects };

  const isPlannedStop =
    state.plannedStopUntil && new Date(state.plannedStopUntil).getTime() > now.getTime();

  const isQuiet = isInQuietHours(settings.quietHours, now, settings.timeZone);

  // Helper: push a CREATE_ALERT effect, respecting quiet hours for non-critical
  function alert(data) {
    const isCritical = data.severity === 'critical';
    if (isQuiet && !isCritical) return; // quiet hours mute info/warning/high
    effects.push({ type: 'CREATE_ALERT', data });
  }

  // ── 3. Heartbeat recovery ─────────────────────────────────────────────────
  if (state.hasActiveHeartbeatLostAlert) {
    effects.push({ type: 'RESOLVE_ALERTS', filter: { type: 'HEARTBEAT_LOST' } });
    alert({
      type: 'HEARTBEAT_RECOVERED',
      severity: 'info',
      message: MSG.heartbeatRecovered(reading.percent, chargingStateLabel(reading)),
      dedupeKey: null,
    });
    effects.push({
      type: 'RECORD_EVENT',
      data: { type: 'HEARTBEAT_RECOVERED', at: new Date(reading.deviceTime), percent: reading.percent },
    });
  }

  // ── 4. Detect AC transitions ──────────────────────────────────────────────
  const prevAc = state.prevAcConnected; // null means unknown (first reading)

  const acJustDisconnected =
    reading.event === 'ac_disconnected' ||
    (!reading.acConnected && prevAc === true && reading.event !== 'ac_connected');

  const acJustConnected =
    reading.event === 'ac_connected' ||
    (reading.acConnected && prevAc === false && reading.event !== 'ac_disconnected');

  if (acJustDisconnected && !isPlannedStop) {
    nextState.currentCycleId += 1;
    nextState.firedLevels = [];

    alert({
      type: 'AC_DISCONNECTED',
      severity: 'warning',
      cycleId: nextState.currentCycleId,
      message: MSG.acDisconnected(reading.percent, reading.mt5Running),
      dedupeKey: `${state.deviceId}:AC_DISCONNECTED:${nextState.currentCycleId}`,
    });
    effects.push({
      type: 'RECORD_EVENT',
      data: {
        type: 'AC_DISCONNECTED',
        at: new Date(reading.deviceTime),
        percent: reading.percent,
        cycleId: nextState.currentCycleId,
      },
    });
  }

  if (acJustConnected) {
    nextState.firedLevels = [];

    // Resolve battery alerts when charger is plugged back in
    effects.push({ type: 'RESOLVE_ALERTS', filter: { type: 'CRITICAL_BATTERY' } });
    effects.push({ type: 'RESOLVE_ALERTS', filter: { type: 'LOW_BATTERY' } });
    effects.push({ type: 'RESOLVE_ALERTS', filter: { type: 'AC_DISCONNECTED' } });

    alert({
      type: 'AC_RECONNECTED',
      severity: 'info',
      cycleId: nextState.currentCycleId,
      message: MSG.acReconnected(reading.percent),
      dedupeKey: `${state.deviceId}:AC_RECONNECTED:${nextState.currentCycleId}`,
    });
    effects.push({
      type: 'RECORD_EVENT',
      data: {
        type: 'AC_RECONNECTED',
        at: new Date(reading.deviceTime),
        percent: reading.percent,
        cycleId: nextState.currentCycleId,
      },
    });
  }

  // ── 5. Battery threshold alerts (only while on battery) ───────────────────
  if (!reading.acConnected && !isPlannedStop) {
    const thresholds = settings.thresholds ?? [50, 30, 20, 15];
    const criticalLevel = settings.criticalLevel ?? 15;

    // Thresholds crossed that haven't already fired this cycle
    const crossed = thresholds.filter(
      (t) => reading.percent <= t && !nextState.firedLevels.includes(t),
    );

    if (crossed.length > 0) {
      const lowestThreshold = Math.min(...crossed);

      // Mark ALL crossed levels as fired (including ones above lowest)
      nextState.firedLevels = [...nextState.firedLevels, ...crossed];

      if (lowestThreshold <= criticalLevel) {
        // Critical — never muted by quiet hours
        effects.push({
          type: 'CREATE_ALERT',
          data: {
            type: 'CRITICAL_BATTERY',
            severity: 'critical',
            level: lowestThreshold,
            cycleId: nextState.currentCycleId,
            message: MSG.criticalBattery(reading.percent),
            dedupeKey: `${state.deviceId}:CRITICAL_BATTERY:${lowestThreshold}:${nextState.currentCycleId}`,
          },
        });
      } else {
        alert({
          type: 'LOW_BATTERY',
          severity: lowBatterySeverity(lowestThreshold),
          level: lowestThreshold,
          cycleId: nextState.currentCycleId,
          message: MSG.lowBattery(reading.percent),
          dedupeKey: `${state.deviceId}:LOW_BATTERY:${lowestThreshold}:${nextState.currentCycleId}`,
        });
      }
    }
  }

  // ── 6. Unexpected shutdown event ──────────────────────────────────────────
  if (reading.event === 'unexpected_shutdown_detected') {
    effects.push({
      type: 'CREATE_ALERT',
      data: {
        type: 'UNEXPECTED_SHUTDOWN',
        severity: 'critical',
        message: MSG.unexpectedShutdown(),
        dedupeKey: `${state.deviceId}:UNEXPECTED_SHUTDOWN:${reading.readingId}`,
      },
    });
    effects.push({
      type: 'RECORD_EVENT',
      data: { type: 'UNEXPECTED_SHUTDOWN', at: new Date(reading.deviceTime), percent: reading.percent },
    });
  }

  // ── 7. MT5 not-running debounce ───────────────────────────────────────────
  if (settings.mt5Alert !== false) {
    if (!reading.mt5Running) {
      if (!nextState.mt5OffSince) {
        nextState.mt5OffSince = new Date(reading.deviceTime);
      }
      const debounceMs = (settings.mt5DebounceSec ?? 120) * 1000;
      const offMs = now.getTime() - nextState.mt5OffSince.getTime();

      if (offMs >= debounceMs && !nextState.mt5AlertFired && !isPlannedStop) {
        alert({
          type: 'MT5_NOT_RUNNING',
          severity: 'warning',
          cycleId: nextState.currentCycleId,
          message: MSG.mt5NotRunning(),
          dedupeKey: `${state.deviceId}:MT5_NOT_RUNNING:${nextState.currentCycleId}`,
        });
        nextState.mt5AlertFired = true;
      }
    } else {
      if (nextState.mt5OffSince !== null || nextState.mt5AlertFired) {
        nextState.mt5OffSince = null;
        nextState.mt5AlertFired = false;
        effects.push({ type: 'RESOLVE_ALERTS', filter: { type: 'MT5_NOT_RUNNING' } });
      }
    }
  }

  // ── 8. Persist state changes ──────────────────────────────────────────────
  effects.push({
    type: 'UPDATE_DEVICE',
    update: {
      currentCycleId: nextState.currentCycleId,
      firedLevels: nextState.firedLevels,
      mt5OffSince: nextState.mt5OffSince,
      mt5AlertFired: nextState.mt5AlertFired,
    },
  });

  return { nextState, effects };
}
