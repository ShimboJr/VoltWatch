/**
 * VoltWatch Simulator — shared HTTP client and utilities.
 *
 * Used by both simulate.js (scenario runner) and seed.js (bulk seeder).
 */

import { createHash, randomBytes } from 'crypto';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * POST a single heartbeat/event reading.
 *
 * @param {string} api    Base API URL, e.g. http://localhost:3001/api/v1
 * @param {string} token  Device bearer token
 * @param {object} body   Reading payload
 * @returns {Promise<object>} Parsed JSON response
 */
export async function postHeartbeat(api, token, body) {
  const res = await fetch(`${api}/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`heartbeat ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * POST a batch of offline readings.
 *
 * @param {string}   api
 * @param {string}   token
 * @param {object[]} readings  Array of reading payloads (max 500)
 * @returns {Promise<object>}
 */
export async function postBatch(api, token, readings) {
  // Split into chunks of 500 (backend max)
  const chunks = [];
  for (let i = 0; i < readings.length; i += 500) {
    chunks.push(readings.slice(i, i + 500));
  }

  let total = { processed: 0, duplicates: 0, errors: 0 };

  for (const chunk of chunks) {
    const res = await fetch(`${api}/agent/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ readings: chunk }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`batch ${res.status}: ${text}`);
    }

    const data = await res.json();
    total.processed += data.processed ?? 0;
    total.duplicates += data.duplicates ?? 0;
    total.errors += data.errors ?? 0;
  }

  return total;
}

/**
 * GET a dashboard endpoint (requires session cookie).
 *
 * @param {string} url      Full URL
 * @param {string} cookie   Session cookie string
 * @returns {Promise<object>}
 */
export async function dashGet(url, cookie) {
  const res = await fetch(url, {
    headers: { Cookie: cookie, 'X-Requested-With': 'voltwatch' },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/**
 * Login to the dashboard and return a session cookie string.
 *
 * @param {string} api
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} Cookie header value
 */
export async function login(api, email, password) {
  const res = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'voltwatch',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Login failed ${res.status}: ${text}`);
  }

  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookieName = setCookie.match(/^([^=]+=[^;]+)/)?.[1];
  if (!cookieName) throw new Error('No session cookie returned from login');
  return cookieName;
}

// ─── Deterministic UUID from a seed string ────────────────────────────────────

/**
 * Generate a deterministic UUID v4-shaped string from a seed string.
 * Identical seed → identical UUID. Used for idempotent readingIds.
 *
 * @param {string} seed
 * @returns {string} UUID string
 */
export function deterministicUuid(seed) {
  const hash = createHash('sha256').update(seed).digest('hex');
  // Format as UUID v4
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),           // version 4
    (((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)) + hash.slice(17, 20), // variant
    hash.slice(20, 32),
  ].join('-');
}

// ─── Simple seeded PRNG (mulberry32) ─────────────────────────────────────────

/**
 * Create a seeded pseudo-random number generator.
 *
 * @param {number} seed
 * @returns {() => number} Returns float in [0, 1)
 */
export function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Delay helper ─────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Reading factory ──────────────────────────────────────────────────────────

/**
 * Build a complete reading payload.
 *
 * @param {object} overrides
 * @returns {object}
 */
export function makeReading(overrides = {}) {
  return {
    readingId: crypto.randomUUID(),
    deviceTime: new Date().toISOString(),
    kind: 'heartbeat',
    event: null,
    percent: 80,
    charging: true,
    acConnected: true,
    secsLeft: null,
    mt5Running: true,
    uptimeSec: 3600,
    internetLatencyMs: 80,
    agentVersion: '1.0.0-sim',
    hostname: 'SIM-LAPTOP',
    meta: {},
    ...overrides,
  };
}

// ─── Console narration ────────────────────────────────────────────────────────

const COLOURS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
  bold: '\x1b[1m',
};

function ts() {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info: (msg) => console.log(`${COLOURS.cyan}[${ts()}]${COLOURS.reset} ${msg}`),
  ok:   (msg) => console.log(`${COLOURS.green}[${ts()}] ✓${COLOURS.reset} ${msg}`),
  warn: (msg) => console.log(`${COLOURS.yellow}[${ts()}] ⚡${COLOURS.reset} ${msg}`),
  err:  (msg) => console.error(`${COLOURS.red}[${ts()}] ✗${COLOURS.reset} ${msg}`),
  step: (msg) => console.log(`\n${COLOURS.bold}${COLOURS.cyan}── ${msg} ──${COLOURS.reset}`),
  grey: (msg) => console.log(`${COLOURS.grey}[${ts()}] ${msg}${COLOURS.reset}`),
};
