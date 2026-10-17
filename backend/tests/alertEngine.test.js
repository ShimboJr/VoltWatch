/**
 * Alert engine tests — table-driven, zero I/O.
 * Every test calls the pure evaluate() function directly.
 */
import {
  evaluate,
  isInQuietHours,
  lowBatterySeverity,
  MSG,
} from '../src/services/alertEngine.js';

// ─── Test factories ───────────────────────────────────────────────────────────

function makeState(overrides = {}) {
  return {
    deviceId: 'aabbcc112233445566778899',
    currentCycleId: 1,
    firedLevels: [],
    alertsPaused: false,
    plannedStopUntil: null,
    mt5OffSince: null,
    mt5AlertFired: false,
    prevAcConnected: false,       // already on battery by default
    prevMt5Running: true,
    hasActiveHeartbeatLostAlert: false,
    ...overrides,
  };
}

function makeReading(overrides = {}) {
  return {
    readingId: crypto.randomUUID(),
    deviceTime: new Date().toISOString(),
    kind: 'heartbeat',
    event: null,
    percent: 80,
    charging: false,
    acConnected: false,
    secsLeft: null,
    mt5Running: true,
    uptimeSec: 3600,
    backfilled: false,
    ...overrides,
  };
}

function makeSettings(overrides = {}) {
  return {
    thresholds: [50, 30, 20, 15],
    criticalLevel: 15,
    criticalRepeatMin: 5,
    offlineAfterSec: 180,
    staleAfterSec: 120,
    intervalSec: 45,
    mt5Alert: true,
    mt5DebounceSec: 120,
    quietHours: { enabled: false, from: '23:00', to: '06:00' },
    timeZone: 'UTC',
    ...overrides,
  };
}

/** Pull CREATE_ALERT effects from an effects array. */
const alertEffects = (effects) => effects.filter((e) => e.type === 'CREATE_ALERT');

/** Pull the first CREATE_ALERT effect. */
const firstAlert = (effects) => alertEffects(effects)[0]?.data ?? null;

/** Check if any RESOLVE_ALERTS effect targets a type. */
const resolvesType = (effects, type) =>
  effects.some((e) => e.type === 'RESOLVE_ALERTS' && e.filter?.type === type);

// ─── isInQuietHours unit tests ────────────────────────────────────────────────
describe('isInQuietHours()', () => {
  test('returns false when quiet hours disabled', () => {
    const now = new Date('2024-01-01T02:00:00Z');
    expect(isInQuietHours({ enabled: false, from: '00:00', to: '06:00' }, now, 'UTC')).toBe(false);
  });

  test('returns true inside window (same day, does not cross midnight)', () => {
    const now = new Date('2024-01-01T02:00:00Z'); // 02:00 UTC
    expect(isInQuietHours({ enabled: true, from: '01:00', to: '06:00' }, now, 'UTC')).toBe(true);
  });

  test('returns false outside window', () => {
    const now = new Date('2024-01-01T10:00:00Z'); // 10:00 UTC
    expect(isInQuietHours({ enabled: true, from: '23:00', to: '06:00' }, now, 'UTC')).toBe(false);
  });

  test('handles cross-midnight window (23:00–06:00) — during window', () => {
    const now = new Date('2024-01-01T23:30:00Z'); // 23:30 UTC
    expect(isInQuietHours({ enabled: true, from: '23:00', to: '06:00' }, now, 'UTC')).toBe(true);
  });

  test('handles cross-midnight window — early morning inside window', () => {
    const now = new Date('2024-01-01T05:00:00Z'); // 05:00 UTC
    expect(isInQuietHours({ enabled: true, from: '23:00', to: '06:00' }, now, 'UTC')).toBe(true);
  });

  test('handles cross-midnight window — just outside (06:01 UTC)', () => {
    const now = new Date('2024-01-01T06:01:00Z');
    expect(isInQuietHours({ enabled: true, from: '23:00', to: '06:00' }, now, 'UTC')).toBe(false);
  });
});

// ─── lowBatterySeverity unit tests ───────────────────────────────────────────
describe('lowBatterySeverity()', () => {
  test.each([
    [50, 'info'],
    [51, 'info'],
    [30, 'warning'],
    [29, 'high'],
    [20, 'high'],
  ])('level %d → %s', (level, expected) => {
    expect(lowBatterySeverity(level)).toBe(expected);
  });
});

// ─── Backfill guard ───────────────────────────────────────────────────────────
describe('Backfill guard', () => {
  test('backfilled reading produces no alerts', () => {
    const { effects } = evaluate(
      makeState(),
      makeReading({ percent: 10, acConnected: false, backfilled: true }),
      makeSettings(),
    );
    expect(alertEffects(effects)).toHaveLength(0);
  });

  test('reading older than 2 minutes produces no alerts', () => {
    const oldTime = new Date(Date.now() - 3 * 60_000);
    const { effects } = evaluate(
      makeState(),
      makeReading({ percent: 10, deviceTime: oldTime.toISOString() }),
      makeSettings(),
    );
    expect(alertEffects(effects)).toHaveLength(0);
  });
});

// ─── alertsPaused ─────────────────────────────────────────────────────────────
describe('alertsPaused', () => {
  test('no alerts when alertsPaused=true', () => {
    const { effects } = evaluate(
      makeState({ alertsPaused: true }),
      makeReading({ percent: 5, acConnected: false }),
      makeSettings(),
    );
    expect(alertEffects(effects)).toHaveLength(0);
  });
});

// ─── Battery threshold table ──────────────────────────────────────────────────
describe('Battery threshold alerts — gradual discharge (100→0)', () => {
  // Simulate the device just entering battery mode at 100%
  const baseState = makeState({ firedLevels: [], currentCycleId: 1 });

  test.each([
    { percent: 50, expType: 'LOW_BATTERY',     expLevel: 50, expSeverity: 'info'     },
    { percent: 30, expType: 'LOW_BATTERY',     expLevel: 30, expSeverity: 'warning'  },
    { percent: 20, expType: 'LOW_BATTERY',     expLevel: 20, expSeverity: 'high'     },
    { percent: 15, expType: 'CRITICAL_BATTERY',expLevel: 15, expSeverity: 'critical' },
  ])('percent=$percent fires $expType at level $expLevel ($expSeverity)', ({ percent, expType, expLevel, expSeverity }) => {
    // Build up firedLevels from previous thresholds
    const alreadyFired = [50, 30, 20, 15].filter((t) => t > percent);
    const state = { ...baseState, firedLevels: alreadyFired };

    const { effects } = evaluate(
      state,
      makeReading({ percent, acConnected: false }),
      makeSettings(),
    );

    const created = alertEffects(effects);
    expect(created).toHaveLength(1);
    expect(created[0].data.type).toBe(expType);
    expect(created[0].data.level).toBe(expLevel);
    expect(created[0].data.severity).toBe(expSeverity);
  });

  test('each threshold fires exactly once across sequential readings', () => {
    const settings = makeSettings();
    let state = makeState({ firedLevels: [], currentCycleId: 1 });
    let totalAlerts = 0;
    let now = new Date();

    for (const pct of [60, 50, 40, 30, 22, 20, 16, 15, 10, 5]) {
      // Keep deviceTime in sync so readings always pass the 2-minute liveness check
      const reading = makeReading({ percent: pct, acConnected: false, deviceTime: now.toISOString() });
      const { effects, nextState } = evaluate(state, reading, settings, now);
      totalAlerts += alertEffects(effects).length;
      state = { ...state, ...nextState };
      now = new Date(now.getTime() + 60_000);
    }

    // 50, 30, 20 → LOW_BATTERY; 15 → CRITICAL_BATTERY; rest already fired
    expect(totalAlerts).toBe(4);
  });
});

// ─── Jump from 52 to 28 ───────────────────────────────────────────────────────
describe('Jump 52→28 fires only the 30-threshold alert', () => {
  test('fires one LOW_BATTERY alert at level 30 (not level 50)', () => {
    // At 52%, nothing has fired yet
    const state = makeState({ firedLevels: [] });

    const { effects, nextState } = evaluate(
      state,
      makeReading({ percent: 28, acConnected: false }),
      makeSettings(),
    );

    const created = alertEffects(effects);
    expect(created).toHaveLength(1);
    expect(created[0].data.type).toBe('LOW_BATTERY');
    expect(created[0].data.level).toBe(30);
    expect(created[0].data.severity).toBe('warning');

    // Both 50 and 30 should be marked as fired
    expect(nextState.firedLevels).toContain(50);
    expect(nextState.firedLevels).toContain(30);
    expect(nextState.firedLevels).not.toContain(20);
  });
});

// ─── AC disconnect / reconnect ────────────────────────────────────────────────
describe('AC disconnect and reconnect', () => {
  test('plugging in resets firedLevels and resolves battery alerts', () => {
    const state = makeState({
      firedLevels: [50, 30],
      prevAcConnected: false,
      currentCycleId: 2,
    });

    const { effects, nextState } = evaluate(
      state,
      makeReading({ percent: 60, acConnected: true, charging: true, event: 'ac_connected' }),
      makeSettings(),
    );

    expect(nextState.firedLevels).toEqual([]);
    expect(resolvesType(effects, 'CRITICAL_BATTERY')).toBe(true);
    expect(resolvesType(effects, 'LOW_BATTERY')).toBe(true);
    expect(firstAlert(effects)?.type).toBe('AC_RECONNECTED');
  });

  test('unplugging again re-fires thresholds (new cycle, firedLevels reset)', () => {
    const settings = makeSettings();
    let now = new Date();

    // First: plug in (was on battery at 30%)
    const afterReconnect = makeState({
      firedLevels: [50, 30],
      prevAcConnected: false,
      currentCycleId: 1,
    });
    const { nextState: state2 } = evaluate(
      afterReconnect,
      makeReading({ percent: 80, acConnected: true, charging: true, event: 'ac_connected' }),
      settings,
      now,
    );

    // Merge back (simulating DB save)
    const state3 = {
      ...afterReconnect,
      firedLevels: state2.firedLevels,
      currentCycleId: state2.currentCycleId,
      prevAcConnected: true, // was plugged in
    };

    now = new Date(now.getTime() + 60_000);

    // Now unplug
    const { effects, nextState: state4 } = evaluate(
      state3,
      makeReading({ percent: 79, acConnected: false, charging: false, event: 'ac_disconnected' }),
      settings,
      now,
    );

    // New cycle should have incremented
    expect(state4.currentCycleId).toBe(afterReconnect.currentCycleId + 1);
    expect(state4.firedLevels).toEqual([]);
    expect(firstAlert(effects)?.type).toBe('AC_DISCONNECTED');

    now = new Date(now.getTime() + 60_000);

    // Now drop to 30% — should fire again in new cycle
    const state5 = {
      ...state3,
      firedLevels: state4.firedLevels,
      currentCycleId: state4.currentCycleId,
      prevAcConnected: false,
    };
    const { effects: effects2 } = evaluate(
      state5,
      makeReading({ percent: 28, acConnected: false }),
      settings,
      now,
    );

    const batteryAlerts = alertEffects(effects2).filter((e) => e.data.type === 'LOW_BATTERY');
    expect(batteryAlerts).toHaveLength(1);
    expect(batteryAlerts[0].data.level).toBe(30);
  });

  test('AC_DISCONNECTED increments cycleId', () => {
    const state = makeState({ currentCycleId: 5, prevAcConnected: true });
    const { nextState } = evaluate(
      state,
      makeReading({ percent: 90, acConnected: false, event: 'ac_disconnected' }),
      makeSettings(),
    );
    expect(nextState.currentCycleId).toBe(6);
  });
});

// ─── Quiet hours ──────────────────────────────────────────────────────────────
describe('Quiet hours', () => {
  // 02:00 UTC — inside the 23:00–06:00 quiet window
  const quietNow = new Date('2024-01-01T02:00:00Z');

  test('LOW_BATTERY (warning) is suppressed during quiet hours', () => {
    const settings = makeSettings({
      quietHours: { enabled: true, from: '23:00', to: '06:00' },
    });

    const { effects } = evaluate(
      makeState({ firedLevels: [] }),
      makeReading({ percent: 30, acConnected: false }),
      settings,
      quietNow,
    );

    const batteryAlerts = alertEffects(effects).filter((e) => e.data.type === 'LOW_BATTERY');
    expect(batteryAlerts).toHaveLength(0);
  });

  test('CRITICAL_BATTERY is NOT suppressed during quiet hours', () => {
    const settings = makeSettings({
      quietHours: { enabled: true, from: '23:00', to: '06:00' },
    });

    const { effects } = evaluate(
      makeState({ firedLevels: [50, 30, 20] }),
      makeReading({ percent: 15, acConnected: false }),
      settings,
      quietNow,
    );

    const critAlerts = alertEffects(effects).filter((e) => e.data.type === 'CRITICAL_BATTERY');
    expect(critAlerts).toHaveLength(1);
    expect(critAlerts[0].data.severity).toBe('critical');
  });

  test('AC_DISCONNECTED is suppressed during quiet hours', () => {
    const settings = makeSettings({
      quietHours: { enabled: true, from: '23:00', to: '06:00' },
    });

    const { effects } = evaluate(
      makeState({ prevAcConnected: true }),
      makeReading({ percent: 90, acConnected: false, event: 'ac_disconnected' }),
      settings,
      quietNow,
    );

    const acAlerts = alertEffects(effects).filter((e) => e.data.type === 'AC_DISCONNECTED');
    expect(acAlerts).toHaveLength(0);
  });

  test('HEARTBEAT_RECOVERED (info) is suppressed during quiet hours', () => {
    const settings = makeSettings({
      quietHours: { enabled: true, from: '23:00', to: '06:00' },
    });

    const { effects } = evaluate(
      makeState({ hasActiveHeartbeatLostAlert: true }),
      makeReading({ percent: 80, acConnected: true }),
      settings,
      quietNow,
    );

    const recoveredAlerts = alertEffects(effects).filter(
      (e) => e.data.type === 'HEARTBEAT_RECOVERED',
    );
    expect(recoveredAlerts).toHaveLength(0);
    // But the RESOLVE_ALERTS effect must still fire
    expect(resolvesType(effects, 'HEARTBEAT_LOST')).toBe(true);
  });
});

// ─── Planned stop ─────────────────────────────────────────────────────────────
describe('Planned stop suppresses non-critical alerts', () => {
  test('AC_DISCONNECTED alert suppressed during planned stop', () => {
    const state = makeState({
      prevAcConnected: true,
      plannedStopUntil: new Date(Date.now() + 10 * 60_000), // 10 min in future
    });

    const { effects } = evaluate(
      state,
      makeReading({ percent: 90, acConnected: false, event: 'ac_disconnected' }),
      makeSettings(),
    );

    const acAlerts = alertEffects(effects).filter((e) => e.data.type === 'AC_DISCONNECTED');
    expect(acAlerts).toHaveLength(0);
  });

  test('expired plannedStopUntil does not suppress alerts', () => {
    const state = makeState({
      prevAcConnected: true,
      plannedStopUntil: new Date(Date.now() - 60_000), // 1 min in past — expired
    });

    const { effects } = evaluate(
      state,
      makeReading({ percent: 90, acConnected: false, event: 'ac_disconnected' }),
      makeSettings(),
    );

    const acAlerts = alertEffects(effects).filter((e) => e.data.type === 'AC_DISCONNECTED');
    expect(acAlerts).toHaveLength(1);
  });
});

// ─── Heartbeat recovery ───────────────────────────────────────────────────────
describe('Heartbeat recovery', () => {
  test('resolves HEARTBEAT_LOST and creates HEARTBEAT_RECOVERED when device comes back', () => {
    const state = makeState({ hasActiveHeartbeatLostAlert: true });

    const { effects } = evaluate(
      state,
      makeReading({ percent: 75, acConnected: true, charging: true }),
      makeSettings(),
    );

    expect(resolvesType(effects, 'HEARTBEAT_LOST')).toBe(true);
    const recovered = alertEffects(effects).filter((e) => e.data.type === 'HEARTBEAT_RECOVERED');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].data.message).toContain('75%');
    expect(recovered[0].data.message).toContain('charging');
  });

  test('does not fire HEARTBEAT_RECOVERED if no active HEARTBEAT_LOST', () => {
    const state = makeState({ hasActiveHeartbeatLostAlert: false });

    const { effects } = evaluate(
      state,
      makeReading({ percent: 75 }),
      makeSettings(),
    );

    const recovered = alertEffects(effects).filter((e) => e.data.type === 'HEARTBEAT_RECOVERED');
    expect(recovered).toHaveLength(0);
  });
});

// ─── MT5 debounce ─────────────────────────────────────────────────────────────
describe('MT5 not-running debounce', () => {
  test('no alert before debounce window elapses', () => {
    const settings = makeSettings({ mt5DebounceSec: 120 });
    const mt5OffSince = new Date(Date.now() - 60_000); // only 1 minute, debounce=2 min

    const { effects } = evaluate(
      makeState({ mt5OffSince, mt5AlertFired: false }),
      makeReading({ mt5Running: false }),
      settings,
    );

    const mt5Alerts = alertEffects(effects).filter((e) => e.data.type === 'MT5_NOT_RUNNING');
    expect(mt5Alerts).toHaveLength(0);
  });

  test('fires alert after debounce window elapses', () => {
    const settings = makeSettings({ mt5DebounceSec: 120 });
    const mt5OffSince = new Date(Date.now() - 121_000); // 121 seconds > 120s debounce

    const { effects, nextState } = evaluate(
      makeState({ mt5OffSince, mt5AlertFired: false }),
      makeReading({ mt5Running: false }),
      settings,
    );

    const mt5Alerts = alertEffects(effects).filter((e) => e.data.type === 'MT5_NOT_RUNNING');
    expect(mt5Alerts).toHaveLength(1);
    expect(nextState.mt5AlertFired).toBe(true);
  });

  test('does not re-fire if mt5AlertFired=true', () => {
    const settings = makeSettings({ mt5DebounceSec: 120 });
    const mt5OffSince = new Date(Date.now() - 200_000);

    const { effects } = evaluate(
      makeState({ mt5OffSince, mt5AlertFired: true }),
      makeReading({ mt5Running: false }),
      settings,
    );

    const mt5Alerts = alertEffects(effects).filter((e) => e.data.type === 'MT5_NOT_RUNNING');
    expect(mt5Alerts).toHaveLength(0);
  });

  test('resolves MT5_NOT_RUNNING and resets state when MT5 restarts', () => {
    const mt5OffSince = new Date(Date.now() - 200_000);

    const { effects, nextState } = evaluate(
      makeState({ mt5OffSince, mt5AlertFired: true }),
      makeReading({ mt5Running: true }),
      makeSettings(),
    );

    expect(resolvesType(effects, 'MT5_NOT_RUNNING')).toBe(true);
    expect(nextState.mt5OffSince).toBeNull();
    expect(nextState.mt5AlertFired).toBe(false);
  });
});

// ─── Unexpected shutdown ──────────────────────────────────────────────────────
describe('Unexpected shutdown event', () => {
  test('creates UNEXPECTED_SHUTDOWN alert and records event', () => {
    const { effects } = evaluate(
      makeState(),
      makeReading({ event: 'unexpected_shutdown_detected', kind: 'event' }),
      makeSettings(),
    );

    const shutdownAlerts = alertEffects(effects).filter(
      (e) => e.data.type === 'UNEXPECTED_SHUTDOWN',
    );
    expect(shutdownAlerts).toHaveLength(1);
    expect(shutdownAlerts[0].data.severity).toBe('critical');

    const recordedEvents = effects.filter(
      (e) => e.type === 'RECORD_EVENT' && e.data.type === 'UNEXPECTED_SHUTDOWN',
    );
    expect(recordedEvents).toHaveLength(1);
  });
});

// ─── Duplicate-reading no-op ──────────────────────────────────────────────────
describe('Duplicate reading is a no-op', () => {
  test('same state produces same effects on re-evaluation but dedupeKey prevents DB duplicates', () => {
    // percent=19 crosses threshold 20 (since 19 <= 20 and 20 not yet in firedLevels)
    const state = makeState({ firedLevels: [50, 30] });
    const reading = makeReading({ percent: 19, acConnected: false });
    const now = new Date();

    const { effects: e1 } = evaluate(state, reading, makeSettings(), now);
    const { effects: e2 } = evaluate(state, reading, makeSettings(), now);

    // Both produce the same alert; it is the CREATE_ALERT+dedupeKey unique index
    // in MongoDB (not evaluate itself) that prevents actual duplicates.
    expect(alertEffects(e1)).toHaveLength(1);
    expect(alertEffects(e2)).toHaveLength(1);
    expect(alertEffects(e1)[0].data.dedupeKey).toBe(alertEffects(e2)[0].data.dedupeKey);
  });
});

// ─── DedupeKey format ─────────────────────────────────────────────────────────
describe('DedupeKey format', () => {
  const deviceId = 'aabbcc112233445566778899';

  test('LOW_BATTERY key = deviceId:LOW_BATTERY:level:cycleId', () => {
    const { effects } = evaluate(
      makeState({ deviceId, currentCycleId: 3, firedLevels: [50] }),
      makeReading({ percent: 30, acConnected: false }),
      makeSettings(),
    );
    const a = firstAlert(effects);
    expect(a?.dedupeKey).toBe(`${deviceId}:LOW_BATTERY:30:3`);
  });

  test('CRITICAL_BATTERY key = deviceId:CRITICAL_BATTERY:level:cycleId', () => {
    const { effects } = evaluate(
      makeState({ deviceId, currentCycleId: 4, firedLevels: [50, 30, 20] }),
      makeReading({ percent: 15, acConnected: false }),
      makeSettings(),
    );
    const a = firstAlert(effects);
    expect(a?.dedupeKey).toBe(`${deviceId}:CRITICAL_BATTERY:15:4`);
  });

  test('AC_DISCONNECTED key uses new cycleId after increment', () => {
    const { effects, nextState } = evaluate(
      makeState({ deviceId, currentCycleId: 2, prevAcConnected: true }),
      makeReading({ percent: 90, acConnected: false, event: 'ac_disconnected' }),
      makeSettings(),
    );
    const a = firstAlert(effects);
    expect(nextState.currentCycleId).toBe(3);
    expect(a?.dedupeKey).toBe(`${deviceId}:AC_DISCONNECTED:3`);
  });
});

// ─── Message wording (spot-check spec templates) ─────────────────────────────
describe('Message wording matches spec templates', () => {
  test('AC_DISCONNECTED includes battery percent and MT5 state', () => {
    const { effects } = evaluate(
      makeState({ prevAcConnected: true }),
      makeReading({ percent: 72, acConnected: false, mt5Running: false, event: 'ac_disconnected' }),
      makeSettings(),
    );
    const msg = firstAlert(effects)?.message ?? '';
    expect(msg).toMatch(/72%/);
    expect(msg).toMatch(/not running/i);
    expect(msg).toMatch(/⚡/);
  });

  test('CRITICAL_BATTERY includes percent and take immediate action', () => {
    const { effects } = evaluate(
      makeState({ firedLevels: [50, 30, 20] }),
      makeReading({ percent: 15, acConnected: false }),
      makeSettings(),
    );
    const msg = firstAlert(effects)?.message ?? '';
    expect(msg).toMatch(/15%/);
    expect(msg).toMatch(/immediate action/i);
    expect(msg).toMatch(/🚨/);
  });

  test('HEARTBEAT_LOST message from MSG helper includes minutes', () => {
    const msg = MSG.heartbeatLost(12);
    expect(msg).toMatch(/12 minutes/);
    expect(msg).toMatch(/heartbeat/i);
  });

  test('AC_RECONNECTED includes percent and plug emoji', () => {
    const { effects } = evaluate(
      makeState({ prevAcConnected: false }),
      makeReading({ percent: 68, acConnected: true, charging: true, event: 'ac_connected' }),
      makeSettings(),
    );
    const msg = firstAlert(effects)?.message ?? '';
    expect(msg).toMatch(/68%/);
    expect(msg).toMatch(/🔌/);
  });
});

// ─── UPDATE_DEVICE effect always present ─────────────────────────────────────
describe('UPDATE_DEVICE effect', () => {
  test('is always included in effects for live readings', () => {
    const { effects } = evaluate(makeState(), makeReading(), makeSettings());
    const update = effects.find((e) => e.type === 'UPDATE_DEVICE');
    expect(update).toBeDefined();
    expect(update.update).toHaveProperty('currentCycleId');
    expect(update.update).toHaveProperty('firedLevels');
  });

  test('is absent for backfilled readings (no effects at all)', () => {
    const { effects } = evaluate(
      makeState(),
      makeReading({ backfilled: true }),
      makeSettings(),
    );
    expect(effects).toHaveLength(0);
  });
});
