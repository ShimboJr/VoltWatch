#!/usr/bin/env node
/**
 * VoltWatch Seed Script
 *
 * Generates 30 days of realistic history directly via /agent/batch.
 * Idempotent: readingIds are derived from timestamps, so running twice
 * results in the same data (duplicates are silently ignored by the backend).
 *
 * Usage:
 *   node seed.js --api http://localhost:3001/api/v1 \
 *                --token <device-token> \
 *                [--days 30] \
 *                [--interval 60] \
 *                [--seed 1234]
 *
 * Profile generated:
 *   - Readings every `interval` seconds (default 60s = 1 per minute)
 *   - Nights (22:00–07:00 UTC): plugged in, charging/charged
 *   - Days: on battery, draining at ~5-7%/hour
 *   - 2–4 power cuts per day (daytime, random duration)
 *   - One 6-hour internet outage on day 15
 *   - MT5 restarts 1–2 times per day
 *   - Occasional overnight battery dip if charger "forgets" to be plugged in
 */

import { parseArgs } from 'node:util';
import { postBatch, deterministicUuid, makePrng, log } from './lib.js';

// ─── CLI ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    api:      { type: 'string', default: 'http://localhost:3001/api/v1' },
    token:    { type: 'string', default: '' },
    days:     { type: 'string', default: '30' },
    interval: { type: 'string', default: '60' },
    seed:     { type: 'string', default: '9999' },
    help:     { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`
VoltWatch Seed Script

  --api <url>       Backend base URL (default: http://localhost:3001/api/v1)
  --token <token>   Device bearer token (required)
  --days <n>        Days of history to generate (default: 30)
  --interval <sec>  Reading interval in seconds (default: 60)
  --seed <n>        PRNG seed (default: 9999)
  `);
  process.exit(0);
}

const API      = args.api.replace(/\/$/, '');
const TOKEN    = args.token;
const DAYS     = Math.max(1, Math.min(90, parseInt(args.days, 10) || 30));
const INTERVAL = Math.max(30, Math.min(300, parseInt(args.interval, 10) || 60));
const SEED     = parseInt(args.seed, 10) || 9999;

if (!TOKEN) {
  log.err('--token is required');
  process.exit(1);
}

// ─── PRNG ─────────────────────────────────────────────────────────────────────

const prng = makePrng(SEED);

function rand(min, max) {
  return min + Math.floor(prng() * (max - min + 1));
}

function randFloat(min, max) {
  return min + prng() * (max - min);
}

// ─── Simulation state ─────────────────────────────────────────────────────────

const endTime   = new Date();
endTime.setSeconds(0, 0); // round to the minute
const startTime = new Date(endTime.getTime() - DAYS * 86_400_000);

log.step(`Generating ${DAYS} days of history`);
log.info(`From: ${startTime.toISOString()}`);
log.info(`To:   ${endTime.toISOString()}`);
log.info(`Interval: ${INTERVAL}s  Seed: ${SEED}`);

// ─── Schedule: power cuts per day ─────────────────────────────────────────────

/**
 * Generate power-cut intervals for a given day index.
 * Returns array of { offHour, offMin, onHour, onMin } in UTC.
 */
function powerCutsForDay(dayIndex) {
  // Use a sub-prng seeded per day for stability
  const dayPrng = makePrng(SEED ^ (dayIndex * 2654435761));
  const numCuts = dayIndex % 7 === 5 ? 0 : dayPrng() < 0.3 ? 0 : rand(1, 3); // 0 on some Saturdays

  const cuts = [];
  for (let i = 0; i < numCuts; i++) {
    // Power cuts only during day hours (07:00–22:00 UTC)
    const offHour = rand(7, 18);
    const offMin  = rand(0, 59);
    const durationH = randFloat(0.5, 4); // 30 min to 4 hours
    const offTotal  = offHour * 60 + offMin;
    const onTotal   = Math.min(offTotal + Math.round(durationH * 60), 21 * 60 + 59);
    cuts.push({
      offMin: offTotal,
      onMin:  onTotal,
    });
  }

  // Sort and remove overlaps
  cuts.sort((a, b) => a.offMin - b.offMin);
  return cuts;
}

// ─── MT5 restart schedule ─────────────────────────────────────────────────────

function mt5RestartsForDay(dayIndex) {
  const dayPrng = makePrng((SEED ^ dayIndex) * 1234567);
  const num = dayPrng() < 0.4 ? 0 : 1;
  const restarts = [];
  for (let i = 0; i < num; i++) {
    const min = rand(8 * 60, 20 * 60); // between 08:00 and 20:00 UTC
    const downMin = rand(2, 8);
    restarts.push({ min, downMin });
  }
  return restarts;
}

// ─── Reading generator ────────────────────────────────────────────────────────

/**
 * Build all readings for the full period.
 * Returns a flat array of reading payloads.
 */
function generateReadings() {
  const readings = [];

  let t = new Date(startTime);
  let pct = 85;           // start at 85%
  let acConnected = true;
  let charging = true;
  let mt5Running = true;
  let uptimeSec = rand(3600, 86400);
  let currentCycleId = 1;

  // Internet outage window: day ~15, 6 hours
  const outageDay   = Math.floor(DAYS / 2);
  const outageStart = new Date(startTime.getTime() + outageDay * 86_400_000 + 10 * 3_600_000); // 10:00 UTC
  const outageEnd   = new Date(outageStart.getTime() + 6 * 3_600_000); // 16:00 UTC

  while (t < endTime) {
    const dayIndex = Math.floor((t.getTime() - startTime.getTime()) / 86_400_000);
    const minuteOfDay = t.getUTCHours() * 60 + t.getUTCMinutes();
    const isNight = minuteOfDay < 7 * 60 || minuteOfDay >= 22 * 60;
    const inOutage = t >= outageStart && t < outageEnd;

    // Build power-cut schedule for this day (cached)
    const cuts = powerCutsForDay(dayIndex);
    const inCut = cuts.some((c) => minuteOfDay >= c.offMin && minuteOfDay < c.onMin);
    const cutStart = cuts.find((c) => minuteOfDay === c.offMin);
    const cutEnd   = cuts.find((c) => minuteOfDay === c.onMin);

    // MT5 restart schedule
    const mt5Events = mt5RestartsForDay(dayIndex);
    const mt5DownEvent = mt5Events.find((e) => minuteOfDay === e.min);
    const mt5UpEvent   = mt5Events.find((e) => minuteOfDay === e.min + e.downMin);

    // ── AC transitions ──────────────────────────────────────────────────────

    let event = null;
    let kind = 'heartbeat';

    if (cutStart && acConnected) {
      // Power cut starts
      event = 'ac_disconnected';
      kind = 'event';
      acConnected = false;
      charging = false;
      currentCycleId++;
    } else if (cutEnd && !acConnected) {
      // Power restored
      event = 'ac_connected';
      kind = 'event';
      acConnected = true;
      charging = pct < 99;
    } else if (isNight && !acConnected) {
      // Night auto-plug
      event = 'ac_connected';
      kind = 'event';
      acConnected = true;
      charging = pct < 99;
    } else if (!isNight && !inCut && acConnected && minuteOfDay === 7 * 60) {
      // At 07:00, might unplug for the day (30% chance)
      if (prng() < 0.3 && pct >= 90) {
        event = 'ac_disconnected';
        kind = 'event';
        acConnected = false;
        charging = false;
        currentCycleId++;
      }
    }

    // ── MT5 transitions ─────────────────────────────────────────────────────

    if (mt5DownEvent && mt5Running) {
      mt5Running = false;
    } else if (mt5UpEvent && !mt5Running) {
      mt5Running = true;
    }

    // ── Battery drain / charge simulation ───────────────────────────────────

    const stepH = INTERVAL / 3600;

    if (acConnected && charging) {
      // Charging at ~20%/h
      pct = Math.min(100, pct + 20 * stepH);
      if (pct >= 100) charging = false;
    } else if (acConnected && !charging) {
      // Plugged at 100%, minimal drift
      pct = 100;
    } else {
      // On battery — drain at 5–7%/h with slight noise
      const drainRate = 6 + (prng() - 0.5) * 2; // 5–7%/h
      pct = Math.max(3, pct - drainRate * stepH);
    }

    const pctRounded = Math.round(pct);
    const secsLeft = (!acConnected && !charging)
      ? Math.round(pct / 6 * 3600)
      : null;

    uptimeSec += INTERVAL;

    // ── Skip reading if in outage (don't store them — simulating lost packets) ──
    if (!inOutage || kind === 'event') {
      const readingId = deterministicUuid(`seed:${SEED}:${t.toISOString()}`);

      readings.push({
        readingId,
        deviceTime: t.toISOString(),
        kind,
        event,
        percent: pctRounded,
        charging,
        acConnected,
        secsLeft,
        mt5Running,
        uptimeSec,
        internetLatencyMs: inOutage ? null : rand(40, 200),
        agentVersion: '1.0.0-seed',
        hostname: 'SEED-LAPTOP',
        meta: {},
      });
    }

    t = new Date(t.getTime() + INTERVAL * 1000);
  }

  return readings;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const readings = generateReadings();
  log.info(`Generated ${readings.length} readings. Uploading in batches of 500…`);

  const result = await postBatch(API, TOKEN, readings);

  log.ok(`Done! processed=${result.processed}  duplicates=${result.duplicates}  errors=${result.errors}`);

  if (result.duplicates > 0) {
    log.info('Duplicates detected — seed was already run. Data is idempotent.');
  }

  if (result.errors > 0) {
    log.warn(`${result.errors} errors — check backend logs.`);
  }
}

main().catch((err) => {
  log.err(`Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
