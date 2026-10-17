#!/usr/bin/env node
/**
 * VoltWatch Simulator
 *
 * Usage:
 *   node simulate.js --api http://localhost:3001/api/v1 \
 *                    --token <device-token> \
 *                    --scenario power-cut \
 *                    --speed 60 \
 *                    --interval 45 \
 *                    --seed 42 \
 *                    --assert \
 *                    [--owner-email owner@example.com] \
 *                    [--owner-password secret]
 *
 * --speed   1–120  (default 1). Divides all delays. 60 = 1 second equals 1 minute of sim time.
 * --assert  After the scenario completes, query the backend alerts API and verify expected alert types appeared.
 */

import { parseArgs } from 'node:util';
import { postHeartbeat, postBatch, dashGet, login, log, sleep, makePrng } from './lib.js';
import { SCENARIOS, EXPECTED_ALERTS } from './scenarios.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    api:            { type: 'string',  default: 'http://localhost:3001/api/v1' },
    token:          { type: 'string',  default: '' },
    scenario:       { type: 'string',  default: 'normal' },
    speed:          { type: 'string',  default: '1' },
    interval:       { type: 'string',  default: '45' },
    seed:           { type: 'string',  default: '1' },
    assert:         { type: 'boolean', default: false },
    'owner-email':  { type: 'string',  default: '' },
    'owner-password': { type: 'string', default: '' },
    help:           { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`
VoltWatch Simulator

  --api <url>           Backend base URL (default: http://localhost:3001/api/v1)
  --token <token>       Device bearer token (required)
  --scenario <name>     Scenario to run (default: normal)
  --speed <1-120>       Time compression factor (default: 1)
  --interval <sec>      Heartbeat interval in seconds (default: 45)
  --seed <number>       PRNG seed for deterministic behaviour (default: 1)
  --assert              Verify expected alerts after scenario completes
  --owner-email <email> Owner email (required for --assert)
  --owner-password <pw> Owner password (required for --assert)

Scenarios: ${Object.keys(SCENARIOS).join(', ')}
  `);
  process.exit(0);
}

const API      = args.api.replace(/\/$/, '');
const TOKEN    = args.token;
const SCENARIO = args.scenario;
const SPEED    = Math.max(1, Math.min(120, parseFloat(args.speed) || 1));
const INTERVAL = Math.max(30, Math.min(60, parseInt(args.interval, 10) || 45));
const SEED     = parseInt(args.seed, 10) || 1;
const ASSERT   = args.assert;

if (!TOKEN) {
  log.err('--token is required. Create a device via the dashboard API first.');
  process.exit(1);
}

if (!SCENARIOS[SCENARIO]) {
  log.err(`Unknown scenario "${SCENARIO}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  log.step(`Scenario: ${SCENARIO}  speed=${SPEED}x  interval=${INTERVAL}s  seed=${SEED}`);

  const prng = makePrng(SEED);
  const gen = SCENARIOS[SCENARIO]({ intervalSec: INTERVAL, speed: SPEED, seed: SEED, prng });

  let stepCount = 0;
  let sentReadings = 0;
  const startedAt = Date.now();

  for await (const step of gen) {
    stepCount++;

    // Print narration
    if (step.narration) {
      log.warn(step.narration);
    }

    // Apply speed-adjusted delay
    if (step.delayMs > 0) {
      const adjustedMs = Math.round(step.delayMs / SPEED);
      log.grey(`  waiting ${(adjustedMs / 1000).toFixed(1)}s (real ${(step.delayMs / 1000).toFixed(0)}s sim)…`);
      await sleep(adjustedMs);
    }

    // Send reading or batch
    if (step.batch) {
      // Batch flush (internet-loss scenario)
      try {
        const result = await postBatch(API, TOKEN, step.batch);
        log.ok(`Batch flushed: ${result.processed} processed, ${result.duplicates} duplicates, ${result.errors} errors`);
        sentReadings += result.processed;
      } catch (err) {
        log.err(`Batch failed: ${err.message}`);
      }
    } else if (step.reading) {
      try {
        const resp = await postHeartbeat(API, TOKEN, step.reading);
        if (resp.duplicate) {
          log.grey(`  [dup] ${step.reading.readingId.slice(0, 8)} pct=${step.reading.percent}%`);
        } else {
          log.ok(`  [hb]  pct=${step.reading.percent}%  ac=${step.reading.acConnected}  mt5=${step.reading.mt5Running}  event=${step.reading.event ?? '-'}`);
          sentReadings++;
        }
      } catch (err) {
        log.err(`Heartbeat failed: ${err.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.step(`Scenario complete — ${sentReadings} readings sent in ${elapsed}s real time`);

  // ── Assert mode ──────────────────────────────────────────────────────────
  if (ASSERT) {
    await runAssert();
  }
}

async function runAssert() {
  const email    = args['owner-email'];
  const password = args['owner-password'];

  if (!email || !password) {
    log.err('--assert requires --owner-email and --owner-password');
    process.exit(1);
  }

  log.step('Assert mode — checking alerts via dashboard API');

  // Give the engine a moment to process
  await sleep(2000);

  let cookie;
  try {
    cookie = await login(API, email, password);
    log.ok('Logged in to dashboard API');
  } catch (err) {
    log.err(`Login failed: ${err.message}`);
    process.exit(1);
  }

  let alerts;
  try {
    const data = await dashGet(`${API}/alerts?state=all&limit=200`, cookie);
    alerts = data.alerts ?? [];
    log.ok(`Fetched ${alerts.length} alert(s) from backend`);
  } catch (err) {
    log.err(`Failed to fetch alerts: ${err.message}`);
    process.exit(1);
  }

  const expected = EXPECTED_ALERTS[SCENARIO] ?? [];
  if (expected.length === 0) {
    log.ok(`No alerts expected for scenario "${SCENARIO}" — assertion passed.`);
    return;
  }

  const foundTypes = new Set(alerts.map((a) => a.type));
  let allPassed = true;

  for (const expectedType of expected) {
    if (foundTypes.has(expectedType)) {
      log.ok(`  ✓ Found expected alert type: ${expectedType}`);
    } else {
      log.err(`  ✗ Missing expected alert type: ${expectedType}`);
      allPassed = false;
    }
  }

  if (allPassed) {
    log.ok(`All ${expected.length} expected alert type(s) found. Assertion PASSED.`);
  } else {
    log.err(`Assertion FAILED — some expected alert types were not found.`);
    log.grey(`Found types: ${[...foundTypes].join(', ')}`);
    process.exit(1);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

run().catch((err) => {
  log.err(`Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
