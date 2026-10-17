# VoltWatch Simulator

A CLI tool that behaves exactly like the real Windows agent. Sends readings to the backend via `/agent/heartbeat` and `/agent/batch` so you can develop, demo, and test the backend and dashboard without draining a real laptop battery.

---

## Prerequisites

- Node 20+ (uses native `fetch` and `parseArgs`)
- A running VoltWatch backend
- A device token (create one via the dashboard API)

---

## Quick start

### 1 — Create a device and get a token

```bash
# Login
curl -s -c cookies.txt \
  -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"email":"owner@example.com","password":"yourPassword"}' | jq

# Create device
TOKEN=$(curl -s -b cookies.txt \
  -X POST http://localhost:3001/api/v1/devices \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"name":"Simulator"}' | jq -r '.token')

echo "Token: $TOKEN"
```

### 2 — Run a scenario

```bash
node tools/simulator/simulate.js \
  --token $TOKEN \
  --scenario power-cut \
  --speed 60
```

### 3 — Seed 30 days of history

```bash
node tools/simulator/seed.js \
  --token $TOKEN
```

---

## Simulator — `simulate.js`

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--api <url>` | `http://localhost:3001/api/v1` | Backend base URL |
| `--token <token>` | *(required)* | Device bearer token |
| `--scenario <name>` | `normal` | Scenario to run |
| `--speed <1-120>` | `1` | Time compression. `60` = 1 real second = 1 sim minute |
| `--interval <sec>` | `45` | Heartbeat interval (30–60) |
| `--seed <n>` | `1` | PRNG seed for deterministic readingIds |
| `--assert` | `false` | Verify expected alerts via dashboard API after scenario |
| `--owner-email <email>` | — | Required with `--assert` |
| `--owner-password <pw>` | — | Required with `--assert` |

### Scenarios

| Scenario | Description | Expected alerts |
|----------|-------------|-----------------|
| `normal` | Plugged in at 100%, steady heartbeats | None |
| `power-cut` | Unplug at 96%, drain to 5%, charger returns | `AC_DISCONNECTED`, `LOW_BATTERY` (×3), `CRITICAL_BATTERY`, `AC_RECONNECTED` |
| `fast-drain` | Jump from 52% to 28% in one reading | `AC_DISCONNECTED`, `LOW_BATTERY` at level 30 only |
| `agent-crash` | Heartbeats stop at 41% on battery | `AC_DISCONNECTED` (then `HEARTBEAT_LOST` after 3 min) |
| `internet-loss` | 10-min outage flushed via `/batch` | None (backfilled = no live alerts) |
| `planned-stop` | `agent_stopping_planned` event, then silence | None within 15-min grace window |
| `sleep-resume` | Gap then `resumed_from_sleep` event | `AC_DISCONNECTED` |
| `mt5-stops` | MT5 flips false on battery | `AC_DISCONNECTED`, `MT5_NOT_RUNNING` |
| `shutdown-recovery` | Silent then `unexpected_shutdown_detected` | `UNEXPECTED_SHUTDOWN` |
| `full-day` | 24h compressed with two power cuts | Multiple |

### Examples

```bash
# Full power-cut at 60× speed (takes ~2 min for a full drain/recharge)
node tools/simulator/simulate.js \
  --token $TOKEN --scenario power-cut --speed 60

# Fast drain test (completes in a few seconds)
node tools/simulator/simulate.js \
  --token $TOKEN --scenario fast-drain --speed 120

# Assert mode — verifies alerts appeared (exit 1 if not)
node tools/simulator/simulate.js \
  --token $TOKEN \
  --scenario power-cut \
  --speed 120 \
  --assert \
  --owner-email owner@example.com \
  --owner-password secret

# MT5 stops scenario with custom interval
node tools/simulator/simulate.js \
  --token $TOKEN --scenario mt5-stops --interval 30 --speed 60

# Shutdown recovery (go fast, wait for HEARTBEAT_LOST manually)
node tools/simulator/simulate.js \
  --token $TOKEN --scenario shutdown-recovery --speed 60
```

---

## Seeder — `seed.js`

Generates realistic history by uploading via `/agent/batch`. Safe to run multiple times — duplicate `readingId`s are silently ignored.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--api <url>` | `http://localhost:3001/api/v1` | Backend base URL |
| `--token <token>` | *(required)* | Device bearer token |
| `--days <n>` | `30` | Days of history (1–90) |
| `--interval <sec>` | `60` | Reading interval in seconds (30–300) |
| `--seed <n>` | `9999` | PRNG seed (same seed = same data) |

### What it generates

- One reading per minute (default) for 30 days
- **Nights (22:00–07:00 UTC):** plugged in, charging or fully charged
- **Days:** on battery, draining at ~5–7%/hour
- **Power cuts:** 0–3 per day, random duration (30 min – 4 hours)
- **MT5 restarts:** 0–1 per day
- **Day 15:** simulated 6-hour internet outage (readings in that window are dropped as if packets were lost)

### Example

```bash
# Seed 30 days (default)
node tools/simulator/seed.js --token $TOKEN

# Seed 7 days at higher resolution
node tools/simulator/seed.js --token $TOKEN --days 7 --interval 30

# Idempotency test — run twice, second run should report 0 processed, N duplicates
node tools/simulator/seed.js --token $TOKEN
node tools/simulator/seed.js --token $TOKEN
```

---

## npm scripts (from repo root)

```bash
npm run sim -- --token $TOKEN --scenario power-cut --speed 60
npm run seed -- --token $TOKEN
```

---

## Architecture

```
tools/simulator/
  lib.js        Shared utilities (HTTP helpers, PRNG, UUID, logging)
  scenarios.js  All scenario generators (async generators)
  simulate.js   CLI runner — parses args, drives scenario, asserts
  seed.js       Bulk history seeder
```

Each scenario is an **async generator** that yields steps:

```js
{ delayMs: 1000, narration: 'Some event happened', reading: { ... } }
{ delayMs: 0,    narration: null,                  batch: [ ... ] }  // batch flush
```

The runner applies the speed multiplier to `delayMs`, sends the reading or batch, and moves to the next step.
