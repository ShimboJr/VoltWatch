/**
 * VoltWatch Simulator — all scenarios.
 *
 * Each scenario is an async generator that yields { reading, delayMs, narration }.
 * `delayMs` is the real-time delay BEFORE sending this reading (already speed-adjusted by the runner).
 *
 * All scenarios use the same signature:
 *   scenario(opts) → AsyncGenerator<Step>
 *
 * opts: { intervalSec, speed, seed, prng }
 */

import { deterministicUuid, makeReading, makePrng } from './lib.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoAt(base, offsetSec) {
  return new Date(new Date(base).getTime() + offsetSec * 1000).toISOString();
}

function uuid(seed, tag) {
  return deterministicUuid(`${seed}:${tag}`);
}

/**
 * Yield a sequence of heartbeats between two states.
 *
 * @param {object} params
 */
function* heartbeats({ seed, tag, count, intervalSec, startTime, pctStart, pctEnd, acConnected, charging, mt5Running, secsLeftFn, uptimeSec }) {
  const pctStep = count > 1 ? (pctEnd - pctStart) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const pct = Math.round(Math.max(0, Math.min(100, pctStart + pctStep * i)));
    const t = isoAt(startTime, i * intervalSec);
    yield {
      delayMs: i === 0 ? 0 : intervalSec * 1000,
      narration: null,
      reading: makeReading({
        readingId: uuid(seed, `${tag}:${i}`),
        deviceTime: t,
        percent: pct,
        charging: charging ?? false,
        acConnected: acConnected ?? false,
        secsLeft: secsLeftFn ? secsLeftFn(pct) : null,
        mt5Running: mt5Running ?? true,
        uptimeSec: (uptimeSec ?? 3600) + i * intervalSec,
      }),
    };
  }
}

// ─── Scenario: normal ─────────────────────────────────────────────────────────

export async function* normal({ intervalSec = 45, seed = 1, startTime }) {
  startTime ??= new Date().toISOString();
  yield { delayMs: 0, narration: 'Laptop plugged in at 100%. Steady heartbeats.' };
  yield* heartbeats({
    seed, tag: 'normal', count: 20, intervalSec, startTime,
    pctStart: 100, pctEnd: 100, acConnected: true, charging: true,
    secsLeftFn: () => null,
  });
}

// ─── Scenario: power-cut ──────────────────────────────────────────────────────

export async function* powerCut({ intervalSec = 45, seed = 2, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;
  let uptime = 3600;

  // 1 — Plugged in at 96%
  yield { delayMs: 0, narration: '🔌 Plugged in at 96%. Running on charger.' };
  for (let i = 0; i < 3; i++) {
    yield {
      delayMs: i === 0 ? 0 : intervalSec * 1000,
      narration: null,
      reading: makeReading({
        readingId: uuid(seed, `pre:${i}`),
        deviceTime: isoAt(t, i * intervalSec),
        percent: 96, charging: true, acConnected: true, mt5Running: true,
        uptimeSec: uptime + i * intervalSec,
      }),
    };
  }

  // 2 — AC disconnect event
  t = isoAt(t, 3 * intervalSec);
  yield { delayMs: intervalSec * 1000, narration: '⚡ Power cut! Charger unplugged. Expect AC_DISCONNECTED alert.' };
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'ac_off'),
      deviceTime: t,
      kind: 'event', event: 'ac_disconnected',
      percent: 96, charging: false, acConnected: false, mt5Running: true,
      secsLeft: Math.round(96 / 6 * 3600),
      uptimeSec: uptime + 3 * intervalSec,
    }),
  };

  // 3 — Drain from 96% to 5% at ~6%/hour
  const drainReadings = Math.ceil((96 - 5) / 6 * 3600 / intervalSec);
  const drainPctPerStep = (96 - 5) / drainReadings;
  for (let i = 0; i < drainReadings; i++) {
    const pct = Math.round(Math.max(5, 96 - drainPctPerStep * (i + 1)));
    t = isoAt(t, intervalSec);
    const secsLeft = Math.round(pct / 6 * 3600);
    let narration = null;
    if (pct === 50) narration = '⚠️  50% threshold crossed — LOW_BATTERY info expected.';
    if (pct === 30) narration = '⚠️  30% threshold crossed — LOW_BATTERY warning expected.';
    if (pct === 20) narration = '⚠️  20% threshold crossed — LOW_BATTERY high expected.';
    if (pct === 15) narration = '🚨 15% threshold crossed — CRITICAL_BATTERY expected.';
    if (pct === 5)  narration = '🔴 Battery at 5% — about to die.';
    yield {
      delayMs: intervalSec * 1000, narration,
      reading: makeReading({
        readingId: uuid(seed, `drain:${i}`),
        deviceTime: t,
        percent: pct, charging: false, acConnected: false, mt5Running: true,
        secsLeft,
        uptimeSec: uptime + (3 + i + 1) * intervalSec,
      }),
    };
  }

  // 4 — Charger returns at 5%
  t = isoAt(t, intervalSec);
  yield { delayMs: intervalSec * 1000, narration: '🔌 Charger reconnected at 5%. Expect AC_RECONNECTED info alert.' };
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'ac_on'),
      deviceTime: t,
      kind: 'event', event: 'ac_connected',
      percent: 5, charging: true, acConnected: true, mt5Running: true,
      uptimeSec: uptime + (3 + drainReadings + 1) * intervalSec,
    }),
  };

  // 5 — Charge back up to 80%
  yield { delayMs: 0, narration: '🔋 Charging back up. Should be quiet from here.' };
  for (let i = 0; i < 10; i++) {
    t = isoAt(t, intervalSec);
    const pct = Math.min(80, 5 + i * 8);
    yield {
      delayMs: intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `charge:${i}`),
        deviceTime: t,
        percent: pct, charging: true, acConnected: true, mt5Running: true,
        uptimeSec: uptime + (3 + drainReadings + 1 + i + 1) * intervalSec,
      }),
    };
  }
}

// ─── Scenario: fast-drain ─────────────────────────────────────────────────────
// 52% → 28% in one reading. Expects only the 30-level alert (not 50).

export async function* fastDrain({ intervalSec = 45, seed = 3, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: 'On battery at 52%. Next reading jumps to 28% — only the 30-level alert should fire.' };

  // AC disconnect
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'ac_off'),
      deviceTime: t,
      kind: 'event', event: 'ac_disconnected',
      percent: 52, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 31200, uptimeSec: 3600,
    }),
  };

  // One heartbeat at 52% (no threshold crossed)
  t = isoAt(t, intervalSec);
  yield {
    delayMs: intervalSec * 1000, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'hb1'),
      deviceTime: t,
      percent: 52, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 31200, uptimeSec: 3645,
    }),
  };

  // Jump to 28%
  t = isoAt(t, intervalSec);
  yield {
    delayMs: intervalSec * 1000,
    narration: '⚡ Jump from 52% to 28%! Only LOW_BATTERY at level 30 (warning) expected.',
    reading: makeReading({
      readingId: uuid(seed, 'jump'),
      deviceTime: t,
      percent: 28, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 16800, uptimeSec: 3690,
    }),
  };

  // A few more heartbeats
  for (let i = 0; i < 5; i++) {
    t = isoAt(t, intervalSec);
    yield {
      delayMs: intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `tail:${i}`),
        deviceTime: t,
        percent: Math.max(21, 28 - i * 2),
        charging: false, acConnected: false, mt5Running: true,
        secsLeft: Math.round((28 - i * 2) / 6 * 3600),
        uptimeSec: 3735 + i * intervalSec,
      }),
    };
  }
}

// ─── Scenario: agent-crash ────────────────────────────────────────────────────

export async function* agentCrash({ intervalSec = 45, seed = 4, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: 'On battery at 41%. Agent will crash after 5 heartbeats. Expect HEARTBEAT_LOST.' };

  // AC disconnect
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'ac_off'),
      deviceTime: t,
      kind: 'event', event: 'ac_disconnected',
      percent: 41, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 24600, uptimeSec: 7200,
    }),
  };

  for (let i = 0; i < 5; i++) {
    t = isoAt(t, intervalSec);
    yield {
      delayMs: intervalSec * 1000,
      narration: i === 4 ? '💀 Last heartbeat before crash.' : null,
      reading: makeReading({
        readingId: uuid(seed, `pre-crash:${i}`),
        deviceTime: t,
        percent: 41 - i, charging: false, acConnected: false, mt5Running: true,
        secsLeft: Math.round((41 - i) / 6 * 3600),
        uptimeSec: 7200 + (i + 1) * intervalSec,
      }),
    };
  }

  yield { delayMs: 0, narration: '🔇 Agent stopped. Waiting for HEARTBEAT_LOST (after offlineAfterSec=180s)...' };
  // Simulator simply stops sending; the offline watcher fires the alert
}

// ─── Scenario: internet-loss ──────────────────────────────────────────────────

export async function* internetLoss({ intervalSec = 45, seed = 5, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: '📡 Simulating 10-minute internet outage. Readings queued locally, then flushed via /batch.' };

  // 2 live heartbeats before outage
  for (let i = 0; i < 2; i++) {
    yield {
      delayMs: i === 0 ? 0 : intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `pre:${i}`),
        deviceTime: isoAt(t, i * intervalSec),
        percent: 72, charging: true, acConnected: true, mt5Running: true,
        uptimeSec: 3600 + i * intervalSec,
      }),
    };
  }

  // Build 10 minutes of offline readings
  const offlineStart = isoAt(t, 2 * intervalSec);
  const offlineCount = Math.ceil(10 * 60 / intervalSec);
  const offlineReadings = [];

  for (let i = 0; i < offlineCount; i++) {
    offlineReadings.push(makeReading({
      readingId: uuid(seed, `offline:${i}`),
      deviceTime: isoAt(offlineStart, i * intervalSec),
      percent: 72, charging: true, acConnected: true, mt5Running: true,
      internetLatencyMs: null,
      uptimeSec: 3600 + (2 + i) * intervalSec,
    }));
  }

  // Return the batch as a special "batch" step
  yield {
    delayMs: 10 * 60 * 1000, // Wait 10 min (real time)
    narration: `📤 Internet restored. Flushing ${offlineCount} queued readings via /batch. No live alerts expected.`,
    batch: offlineReadings,
  };

  // Resume live heartbeats
  const resumeStart = isoAt(offlineStart, offlineCount * intervalSec);
  for (let i = 0; i < 3; i++) {
    yield {
      delayMs: intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `post:${i}`),
        deviceTime: isoAt(resumeStart, i * intervalSec),
        percent: 72, charging: true, acConnected: true, mt5Running: true,
        uptimeSec: 3600 + (2 + offlineCount + i) * intervalSec,
      }),
    };
  }
}

// ─── Scenario: planned-stop ───────────────────────────────────────────────────

export async function* plannedStop({ intervalSec = 45, seed = 6, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: '🛑 Sending agent_stopping_planned. No HEARTBEAT_LOST alert expected within 15 min.' };

  // Normal heartbeat
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'pre'),
      deviceTime: t,
      percent: 88, charging: true, acConnected: true, mt5Running: true,
      uptimeSec: 3600,
    }),
  };

  // Planned stop event
  t = isoAt(t, intervalSec);
  yield {
    delayMs: intervalSec * 1000,
    narration: '📴 Sending planned stop event.',
    reading: makeReading({
      readingId: uuid(seed, 'stop'),
      deviceTime: t,
      kind: 'event', event: 'agent_stopping_planned',
      percent: 88, charging: true, acConnected: true, mt5Running: false,
      uptimeSec: 3600 + intervalSec,
    }),
  };

  yield { delayMs: 0, narration: '⏸  Agent is now silent for 14 min (within the 15-min grace window). No HEARTBEAT_LOST should fire.' };
}

// ─── Scenario: sleep-resume ───────────────────────────────────────────────────

export async function* sleepResume({ intervalSec = 45, seed = 7, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: '💤 3 heartbeats, then a 5-minute sleep gap, then resumed_from_sleep event.' };

  for (let i = 0; i < 3; i++) {
    yield {
      delayMs: i === 0 ? 0 : intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `pre:${i}`),
        deviceTime: isoAt(t, i * intervalSec),
        percent: 75, charging: false, acConnected: false, mt5Running: true,
        secsLeft: 45000, uptimeSec: 3600 + i * intervalSec,
      }),
    };
  }

  // 5-minute gap (laptop sleeping)
  t = isoAt(t, 3 * intervalSec + 5 * 60);
  yield {
    delayMs: 5 * 60 * 1000 + intervalSec * 1000,
    narration: '😴 Laptop was sleeping. Now resuming.',
    reading: makeReading({
      readingId: uuid(seed, 'resume'),
      deviceTime: t,
      kind: 'event', event: 'resumed_from_sleep',
      percent: 74, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 44400, uptimeSec: 3600 + 3 * intervalSec + 5 * 60,
    }),
  };

  for (let i = 0; i < 3; i++) {
    t = isoAt(t, intervalSec);
    yield {
      delayMs: intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `post:${i}`),
        deviceTime: t,
        percent: 74 - i, charging: false, acConnected: false, mt5Running: true,
        secsLeft: Math.round((74 - i) / 6 * 3600),
        uptimeSec: 3600 + (3 + 1 + i) * intervalSec + 5 * 60,
      }),
    };
  }
}

// ─── Scenario: mt5-stops ──────────────────────────────────────────────────────

export async function* mt5Stops({ intervalSec = 45, seed = 8, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: '📉 MT5 will stop while on battery. Expect MT5_NOT_RUNNING alert after debounce (120s).' };

  // On battery
  yield {
    delayMs: 0, narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'ac_off'),
      deviceTime: t,
      kind: 'event', event: 'ac_disconnected',
      percent: 80, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 48000, uptimeSec: 3600,
    }),
  };

  // MT5 stops
  t = isoAt(t, intervalSec);
  yield {
    delayMs: intervalSec * 1000,
    narration: '🛑 MT5 stopped!',
    reading: makeReading({
      readingId: uuid(seed, 'mt5_stop'),
      deviceTime: t,
      kind: 'event', event: 'mt5_stopped',
      percent: 79, charging: false, acConnected: false, mt5Running: false,
      secsLeft: 47400, uptimeSec: 3645,
    }),
  };

  // Heartbeats with mt5Running=false (debounce = 120s)
  for (let i = 0; i < 6; i++) {
    t = isoAt(t, intervalSec);
    yield {
      delayMs: intervalSec * 1000,
      narration: i === 2 ? '⏰ Debounce window (120s) should have elapsed. MT5_NOT_RUNNING alert expected now.' : null,
      reading: makeReading({
        readingId: uuid(seed, `no-mt5:${i}`),
        deviceTime: t,
        percent: 79 - i, charging: false, acConnected: false, mt5Running: false,
        secsLeft: Math.round((79 - i) / 6 * 3600),
        uptimeSec: 3645 + (i + 1) * intervalSec,
      }),
    };
  }

  // MT5 restarts
  t = isoAt(t, intervalSec);
  yield {
    delayMs: intervalSec * 1000,
    narration: '✅ MT5 restarted! MT5_NOT_RUNNING should resolve.',
    reading: makeReading({
      readingId: uuid(seed, 'mt5_start'),
      deviceTime: t,
      kind: 'event', event: 'mt5_started',
      percent: 73, charging: false, acConnected: false, mt5Running: true,
      secsLeft: Math.round(73 / 6 * 3600),
      uptimeSec: 3645 + 7 * intervalSec,
    }),
  };
}

// ─── Scenario: shutdown-recovery ─────────────────────────────────────────────

export async function* shutdownRecovery({ intervalSec = 45, seed = 9, startTime }) {
  startTime ??= new Date().toISOString();
  let t = startTime;

  yield { delayMs: 0, narration: '💥 3 heartbeats, then agent goes silent (unexpected shutdown). Later it comes back and reports.' };

  for (let i = 0; i < 3; i++) {
    yield {
      delayMs: i === 0 ? 0 : intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `pre:${i}`),
        deviceTime: isoAt(t, i * intervalSec),
        percent: 65, charging: false, acConnected: false, mt5Running: true,
        secsLeft: 39000, uptimeSec: 3600 + i * intervalSec,
      }),
    };
  }

  yield { delayMs: 0, narration: '💀 Laptop went silent. Offline watcher will fire HEARTBEAT_LOST after 180s.' };

  // After 5 minutes, agent comes back with startup + shutdown-detected
  const gapSec = 5 * 60;
  t = isoAt(t, 3 * intervalSec + gapSec);

  yield {
    delayMs: (gapSec + intervalSec) * 1000,
    narration: '🔁 Laptop is back! Reporting unexpected_shutdown_detected. Expect UNEXPECTED_SHUTDOWN + HEARTBEAT_RECOVERED.',
    reading: makeReading({
      readingId: uuid(seed, 'recovery'),
      deviceTime: t,
      kind: 'event', event: 'unexpected_shutdown_detected',
      percent: 62, charging: false, acConnected: false, mt5Running: false,
      secsLeft: 37200, uptimeSec: 45,
    }),
  };

  // agent_started
  t = isoAt(t, 5);
  yield {
    delayMs: 5000,
    narration: null,
    reading: makeReading({
      readingId: uuid(seed, 'started'),
      deviceTime: t,
      kind: 'event', event: 'agent_started',
      percent: 62, charging: false, acConnected: false, mt5Running: false,
      secsLeft: 37200, uptimeSec: 50,
    }),
  };

  // Resume normal heartbeats
  for (let i = 0; i < 4; i++) {
    t = isoAt(t, intervalSec);
    yield {
      delayMs: intervalSec * 1000, narration: null,
      reading: makeReading({
        readingId: uuid(seed, `post:${i}`),
        deviceTime: t,
        percent: 61 - i, charging: false, acConnected: false, mt5Running: true,
        secsLeft: Math.round((61 - i) / 6 * 3600),
        uptimeSec: 50 + (i + 1) * intervalSec,
      }),
    };
  }
}

// ─── Scenario: full-day ───────────────────────────────────────────────────────
// 24 hours compressed. Two power cuts. Used for demo data.

export async function* fullDay({ intervalSec = 45, seed = 10, startTime }) {
  // Start from midnight
  const base = startTime
    ? new Date(startTime)
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

  yield { delayMs: 0, narration: '🌅 Starting 24h compressed demo day. Two power cuts, overnight charging, MT5 running all day.' };

  function* segment(tag, startSec, durationSec, pctStart, pctEnd, acConnected, charging, mt5) {
    const count = Math.ceil(durationSec / intervalSec);
    yield* heartbeats({
      seed, tag, count, intervalSec,
      startTime: isoAt(base.toISOString(), startSec),
      pctStart, pctEnd, acConnected, charging, mt5Running: mt5 ?? true,
      secsLeftFn: (!acConnected && !charging) ? (pct) => Math.round(pct / 6 * 3600) : null,
      uptimeSec: startSec,
    });
  }

  const H = (h) => h * 3600;

  // 00:00 – 06:00 plugged in, charging from 20% to 100%
  yield { delayMs: 0, narration: '00:00 — Overnight: laptop plugged in, charging from 20%.' };
  yield* segment('night-charge', H(0), H(6), 20, 100, true, true);

  // 06:00 – 07:00 plugged, stable at 100%
  yield* segment('morning-idle', H(6), H(1), 100, 100, true, false);

  // 07:00 — First power cut
  const cut1Start = H(7);
  yield {
    delayMs: 0,
    narration: '07:00 — First power cut!',
    reading: makeReading({
      readingId: uuid(seed, 'cut1-off'),
      deviceTime: isoAt(base.toISOString(), cut1Start),
      kind: 'event', event: 'ac_disconnected',
      percent: 100, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 60000, uptimeSec: cut1Start,
    }),
  };

  // 07:00 – 10:00 draining from 100% to 82%
  yield* segment('cut1-drain', cut1Start, H(3), 100, 82, false, false);

  // 10:00 — Power returns
  const cut1End = H(10);
  yield {
    delayMs: 0,
    narration: '10:00 — Power returns after cut 1.',
    reading: makeReading({
      readingId: uuid(seed, 'cut1-on'),
      deviceTime: isoAt(base.toISOString(), cut1End),
      kind: 'event', event: 'ac_connected',
      percent: 82, charging: true, acConnected: true, mt5Running: true,
      uptimeSec: cut1End,
    }),
  };

  // 10:00 – 14:00 charging back to 100%
  yield* segment('cut1-charge', cut1End, H(4), 82, 100, true, true);

  // 14:00 — Second (longer) power cut
  const cut2Start = H(14);
  yield {
    delayMs: 0,
    narration: '14:00 — Second power cut! Will drain to ~50%.',
    reading: makeReading({
      readingId: uuid(seed, 'cut2-off'),
      deviceTime: isoAt(base.toISOString(), cut2Start),
      kind: 'event', event: 'ac_disconnected',
      percent: 100, charging: false, acConnected: false, mt5Running: true,
      secsLeft: 60000, uptimeSec: cut2Start,
    }),
  };

  // 14:00 – 22:00 draining from 100% to 52%
  yield* segment('cut2-drain', cut2Start, H(8), 100, 52, false, false);

  // 22:00 — Power returns
  const cut2End = H(22);
  yield {
    delayMs: 0,
    narration: '22:00 — Power restored. Charging from 52%.',
    reading: makeReading({
      readingId: uuid(seed, 'cut2-on'),
      deviceTime: isoAt(base.toISOString(), cut2End),
      kind: 'event', event: 'ac_connected',
      percent: 52, charging: true, acConnected: true, mt5Running: true,
      uptimeSec: cut2End,
    }),
  };

  // 22:00 – 24:00 charging from 52% to 72%
  yield* segment('end-charge', cut2End, H(2), 52, 72, true, true);

  yield { delayMs: 0, narration: '🌙 End of 24h demo day.' };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const SCENARIOS = {
  normal,
  'power-cut': powerCut,
  'fast-drain': fastDrain,
  'agent-crash': agentCrash,
  'internet-loss': internetLoss,
  'planned-stop': plannedStop,
  'sleep-resume': sleepResume,
  'mt5-stops': mt5Stops,
  'shutdown-recovery': shutdownRecovery,
  'full-day': fullDay,
};

// ─── Assert helpers ───────────────────────────────────────────────────────────

/**
 * Expected alert types for each scenario (for --assert mode).
 * HEARTBEAT_LOST is excluded because it requires waiting > offlineAfterSec.
 */
export const EXPECTED_ALERTS = {
  normal:            [],
  'power-cut':       ['AC_DISCONNECTED', 'LOW_BATTERY', 'CRITICAL_BATTERY', 'AC_RECONNECTED'],
  'fast-drain':      ['AC_DISCONNECTED', 'LOW_BATTERY'],
  'agent-crash':     ['AC_DISCONNECTED'],
  'internet-loss':   [],
  'planned-stop':    [],
  'sleep-resume':    ['AC_DISCONNECTED'],
  'mt5-stops':       ['AC_DISCONNECTED', 'MT5_NOT_RUNNING'],
  'shutdown-recovery': ['UNEXPECTED_SHUTDOWN'],
  'full-day':        ['AC_DISCONNECTED', 'LOW_BATTERY', 'AC_RECONNECTED'],
};
