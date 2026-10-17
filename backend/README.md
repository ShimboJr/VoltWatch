# VoltWatch Backend

Node 20 · Express · Mongoose · MongoDB Atlas

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default 3001) |
| `MONGODB_URI` | **Yes** | MongoDB Atlas connection string |
| `JWT_SECRET` | **Yes** | Secret for signing session JWTs (min 32 chars) |
| `OWNER_EMAIL` | **Yes** | Owner account email (seeded on first start) |
| `OWNER_PASSWORD_HASH` | **Yes** | argon2id hash of the owner password |
| `NODE_ENV` | No | `development` \| `production` |
| `APP_ORIGIN` | No | Dashboard origin for CORS (default `http://localhost:3000`) |
| `RETENTION_DAYS` | No | Reading TTL in days (default 30) |
| `LOG_LEVEL` | No | Pino log level (default `info`) |

---

## First-time Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Generate a password hash

```bash
npm run hash-password yourSuperSecretPassword
# → $argon2id$v=19$...
```

Copy the output into `.env` as `OWNER_PASSWORD_HASH`.

### 3. Start the server

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

On first start, the server will upsert the owner user from `OWNER_EMAIL` / `OWNER_PASSWORD_HASH`.

---

## Creating the First Device (curl)

### Step 1 — Login and capture the session cookie

```bash
curl -s -c cookies.txt \
  -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"email":"owner@example.com","password":"yourPassword"}' | jq
```

### Step 2 — Create a device

```bash
curl -s -b cookies.txt \
  -X POST http://localhost:3001/api/v1/devices \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"name":"My Laptop"}' | jq
```

> ⚠️ **Save the returned `token` immediately** — it is shown only once.
> Store it in the agent's `config.json` as `deviceToken`.

### Step 3 — Send a test heartbeat

```bash
curl -s \
  -X POST http://localhost:3001/api/v1/agent/heartbeat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-from-step-2>" \
  -d '{
    "readingId": "00000000-0000-0000-0000-000000000001",
    "deviceTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "kind": "heartbeat",
    "event": null,
    "percent": 95,
    "charging": true,
    "acConnected": true,
    "secsLeft": null,
    "mt5Running": true,
    "uptimeSec": 3600,
    "agentVersion": "1.0.0",
    "hostname": "MY-LAPTOP"
  }' | jq
```

### Step 4 — Confirm device status

```bash
# First get the device ID
DEVICE_ID=$(curl -s -b cookies.txt http://localhost:3001/api/v1/devices | jq -r '.devices[0]._id')

curl -s -b cookies.txt \
  http://localhost:3001/api/v1/devices/$DEVICE_ID/status | jq
# Expect: "status": "ONLINE"
```

---

## Running Tests

```bash
npm test
```

Tests use `mongodb-memory-server` — no external MongoDB required.

Test suites:
- `tests/auth.test.js` — Login, lockout, CSRF rejection, logout, me
- `tests/devices.test.js` — Create (token shown once, hash stored), rotate, cascade delete
- `tests/agent.test.js` — Auth failures, idempotency, batch ordering/backfilling
- `tests/readings.test.js` — Downsampling ≤300 points, gap detection
- `tests/status.test.js` — ONLINE/STALE/OFFLINE at exact thresholds, power states

---

## Alert Engine

The alert engine lives in `src/services/alertEngine.js`. The core function:

```
evaluate(state, reading, settings, now) → { nextState, effects[] }
```

is **purely functional — zero I/O**. Effects are applied by `alertEngineService.js`.

Features:
- Battery threshold alerts (configurable in settings)
- Lowest-crossed-level rule (one alert per battery episode)
- FiredLevels reset when AC is reconnected
- Critical repeat (re-notify every `criticalRepeatMin`)
- MT5 not-running debounce (`mt5DebounceSec`)
- Backfill guard (no live alerts for readings older than 2 min)
- Quiet hours (suppresses info/warning/high; never suppresses critical)
- AlertsPaused / planned stop suppression

---

## Adding a New Notifier

A **Notifier** is any object with the shape:

```js
{
  name: 'mynotifier',              // unique name (string)
  async send(alert, device) { … }  // called for every new alert
}
```

### Steps

1. **Create** `src/services/notifier/myNotifier.js`:

```js
export const MyNotifier = {
  name: 'my-notifier',
  async send(alert, device) {
    // e.g. HTTP request to your notification service
    await fetch('https://myservice.example/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: alert.message, severity: alert.severity }),
    });
  },
};
```

2. **Register** it in `src/server.js` (alongside the existing InAppNotifier line):

```js
import { MyNotifier } from './services/notifier/myNotifier.js';
// …
notifierRegistry.register(MyNotifier);
```

That's it. The registry dispatches every new alert to all registered notifiers.
A failed notifier is logged but does not prevent others from firing.

See `src/services/notifier/inApp.js` for commented extension stubs for
**WebPushNotifier** and **TelegramNotifier**.

---


```
src/
  config/       Environment config
  models/       Mongoose schemas (User, Device, Reading, ReadingRollup, PowerEvent, Alert)
  middleware/   Auth, CSRF, validation, rate limiting, error handler, logger
  services/     tokenService, ownerBootstrap, statusService, eventService, rollupJob
                alertEngine (pure eval), alertEngineService (I/O), offlineWatcher,
                criticalRepeatJob, insightsService
                notifier/ (registry + InAppNotifier; stubs for WebPush, Telegram)
  routes/       auth, devices (incl. insights), agent, settings, alerts, health, stream
  app.js        Express app factory (no listen — importable by tests)
  server.js     Connects DB, bootstraps owner, registers notifiers, starts jobs
scripts/
  hash-password.js
tests/
  helpers/setup.js
  alertEngine.test.js   ← pure engine, table-driven, zero I/O
  auth.test.js
  devices.test.js
  agent.test.js
  readings.test.js
  status.test.js
```

---

## Security Notes

- Device tokens: 32 random bytes → base64url. Only the SHA-256 hex is stored.
- Constant-time comparison prevents timing-based token enumeration.
- Session: JWT in `httpOnly; Secure; SameSite=Lax` cookie, 14-day expiry.
- CSRF: `X-Requested-With: voltwatch` header required on all mutating dashboard requests.
- Login lockout: 5 failures → 15-minute lock.
- Rate limits: 20 login attempts / 15 min; 200 dashboard req/min; 10 agent req/min per token.
- `Authorization` header and cookies are redacted from all log output.
- Stack traces are hidden from clients in `NODE_ENV=production`.
