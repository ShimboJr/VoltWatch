# VoltWatch Master Spec

> **Source of truth.** If a prompt and this spec disagree, this spec wins.
> If the contract must change, edit this file first.

---

## 1. Purpose

A Windows 11 laptop runs MetaTrader 5 with an Expert Advisor while the owner is away from home. VoltWatch tells the owner, from a phone, whether the laptop is alive, on battery or charger, how long it will last, and when something goes wrong. Single owner, one or a few devices, personal use.

---

## 2. Components and repo layout

```
voltwatch/
  backend/            Node 20, Express, Mongoose, MongoDB Atlas
  agent/              Python 3.11+ Windows tray app (psutil, requests, pystray, Pillow)
  dashboard/          Static site: HTML, CSS, Bootstrap 5.3, vanilla JS ES modules, Chart.js
  tools/simulator/    Fake agent + seed script
  docs/               This spec, OpenAPI file, runbook
```

**Fixed decisions:**
- Backend on an always-on host.
- Dashboard on Vercel with `vercel.json` rewrite `/api/(.*)` → backend URL (same-origin cookies).
- Alerts delivered in the dashboard only, behind a `Notifier` interface so Web Push or Telegram can be added without touching the alert engine.

---

## 3. Conventions

- All timestamps ISO-8601 UTC strings; store as `Date`. Display in the owner's time zone.
- JSON errors: `{ "error": { "code": "STRING_CODE", "message": "human text" } }`.
- Validate every input with **zod**. Body limit 256 KB. No secrets or tokens in logs.
- Agent API prefix `/api/v1/agent/*` uses a device bearer token.
- Dashboard API `/api/v1/*` uses a session cookie.
- Code style: ES modules, async/await, small files, JSDoc on public functions, no dead code.

---

## 4. Data models (MongoDB)

### User
Single owner, seeded from env.

| Field | Type | Notes |
|-------|------|-------|
| `email` | String | |
| `passwordHash` | String | argon2id or bcrypt |
| `settings` | Object | See section 7 |
| `failedLogins` | Number | |
| `lockedUntil` | Date | |
| `createdAt` | Date | |

### Device

| Field | Type | Notes |
|-------|------|-------|
| `name` | String | |
| `hostname` | String | |
| `os` | String | |
| `agentVersion` | String | |
| `tokenHash` | String | SHA-256 |
| `tokenRotatedAt` | Date | |
| `createdAt` | Date | |
| `alertsPaused` | Boolean | |
| `currentCycleId` | Number | Increments on each AC disconnect |
| `firedLevels` | Number[] | Levels already alerted in this battery cycle |
| `lastReading` | Object | Embedded snapshot: `percent`, `charging`, `acConnected`, `secsLeft`, `mt5Running`, `deviceTime`, `serverTime` |
| `lastSeenAt` | Date | |
| `plannedStopUntil` | Date \| null | |
| `lastOfflineAlertCycle` | Number | |

### Reading

| Field | Type | Notes |
|-------|------|-------|
| `deviceId` | ObjectId | |
| `readingId` | String | UUID, unique per device — idempotency key |
| `deviceTime` | Date | |
| `serverTime` | Date | TTL 30 days (configurable) |
| `percent` | Number | 0–100 |
| `charging` | Boolean | |
| `acConnected` | Boolean | |
| `secsLeft` | Number \| null | |
| `mt5Running` | Boolean | |
| `uptimeSec` | Number | |
| `internetLatencyMs` | Number \| null | |
| `cycleId` | Number | |
| `backfilled` | Boolean | |

Index: `{ deviceId, deviceTime }`. TTL on `serverTime`: 30 days.

### ReadingRollup (hourly)

| Field | Type |
|-------|------|
| `deviceId` | ObjectId |
| `hour` | Date |
| `minPercent` | Number |
| `maxPercent` | Number |
| `avgPercent` | Number |
| `samples` | Number |
| `onBatterySamples` | Number |

Retained 365 days.

### PowerEvent

| Field | Type | Notes |
|-------|------|-------|
| `deviceId` | ObjectId | |
| `type` | String | See section 6 |
| `at` | Date | |
| `percent` | Number | |
| `meta` | Object | |
| `cycleId` | Number | |

Index: `{ deviceId, at }`. TTL 180 days.

### Alert

| Field | Type | Notes |
|-------|------|-------|
| `deviceId` | ObjectId | |
| `type` | String | |
| `severity` | String | `info \| warning \| high \| critical` |
| `level` | Number \| null | |
| `cycleId` | Number | |
| `message` | String | |
| `createdAt` | Date | |
| `state` | String | `active \| acknowledged \| resolved` |
| `acknowledgedAt` | Date | |
| `snoozedUntil` | Date | |
| `resolvedAt` | Date | |
| `lastRepeatAt` | Date | |
| `dedupeKey` | String | Unique, sparse |

Index: `{ state, createdAt }`.

---

## 5. API contract

### Agent endpoints — `Authorization: Bearer <deviceToken>`

#### `POST /api/v1/agent/heartbeat`

```json
{
  "readingId": "uuid",
  "deviceTime": "2026-10-17T10:00:00Z",
  "kind": "heartbeat",
  "event": null,
  "percent": 96,
  "charging": false,
  "acConnected": false,
  "secsLeft": 14400,
  "mt5Running": true,
  "uptimeSec": 86400,
  "internetLatencyMs": 120,
  "agentVersion": "1.0.0",
  "hostname": "LAPTOP-XYZ",
  "meta": {}
}
```

- `kind`: `"heartbeat"` or `"event"`.
- `event` (when `kind === "event"`): `ac_connected` | `ac_disconnected` | `agent_started` | `agent_stopping_planned` | `system_shutdown` | `resumed_from_sleep` | `unexpected_shutdown_detected` | `mt5_started` | `mt5_stopped`.
- `secsLeft`: null when unknown.

**Response 200:**
```json
{ "serverTime": "...", "config": { "intervalSec": 45, "configVersion": 3 } }
```

Duplicate `readingId` returns `200` with `{ "duplicate": true }`.

#### `POST /api/v1/agent/batch`

```json
{ "readings": [ /* same shape as heartbeat, max 500 */ ] }
```

Used to upload the offline queue. Items processed in `deviceTime` order, marked `backfilled: true`.

---

### Dashboard endpoints — cookie session, JSON

| Method | Path | Body / Notes |
|--------|------|--------------|
| `POST` | `/api/v1/auth/login` | `{ email, password }` |
| `POST` | `/api/v1/auth/logout` | — |
| `GET` | `/api/v1/auth/me` | — |
| `GET` | `/api/v1/devices` | — |
| `POST` | `/api/v1/devices` | `{ name }` → `{ device, token }` (token shown **once**) |
| `PATCH` | `/api/v1/devices/:id` | — |
| `POST` | `/api/v1/devices/:id/rotate-token` | — |
| `DELETE` | `/api/v1/devices/:id` | — |
| `GET` | `/api/v1/devices/:id/status` | Returns derived status (section 8) |
| `GET` | `/api/v1/devices/:id/readings` | `?range=1h\|6h\|24h\|7d\|30d` — ≤300 downsampled points `{ t, percent, acConnected, charging, mt5Running }` + `gaps: [{from,to}]` |
| `GET` | `/api/v1/devices/:id/events` | `?limit=50&before=ISO&types=a,b` |
| `GET` | `/api/v1/devices/:id/insights` | `?range=7d` |
| `GET` | `/api/v1/alerts` | `?state=active\|all&limit=50` |
| `POST` | `/api/v1/alerts/:id/ack` | — |
| `POST` | `/api/v1/alerts/:id/snooze` | `{ minutes }` |
| `POST` | `/api/v1/alerts/test` | Creates a harmless test alert |
| `GET` | `/api/v1/settings` | — |
| `PUT` | `/api/v1/settings` | — |
| `GET` | `/api/v1/stream` | Server-Sent Events: `status`, `alert`, `event` (dashboard falls back to polling) |
| `GET` | `/api/v1/health` | **Public.** `{ ok: true, time }` |

---

## 6. Event and alert types

### PowerEvent types
`AC_DISCONNECTED` · `AC_RECONNECTED` · `LOW_BATTERY` · `HEARTBEAT_LOST` · `HEARTBEAT_RECOVERED` · `AGENT_STARTED` · `AGENT_STOPPED_PLANNED` · `SYSTEM_SHUTDOWN` · `RESUMED_FROM_SLEEP` · `UNEXPECTED_SHUTDOWN` · `MT5_STARTED` · `MT5_STOPPED`

### Alert types and message templates

| Type | Severity | Message |
|------|----------|---------|
| `AC_DISCONNECTED` | warning | `⚡ Your laptop is now running on battery. Current charge: {pct}%. MT5 is {running/not running}.` |
| `LOW_BATTERY` (level above critical) | info (50) / warning (30) / high (20) | `⚠️ Battery is at {pct}%. Your laptop is still running. Please restore power.` |
| `CRITICAL_BATTERY` (level ≤ criticalLevel) | critical | `🚨 Battery is at {pct}%. MT5 may stop if the laptop shuts down. Take immediate action.` |
| `HEARTBEAT_LOST` | critical | `No heartbeat received for {n} minutes. The laptop may have lost power, lost internet, or the monitoring agent may have stopped.` |
| `HEARTBEAT_RECOVERED` | info | `Laptop is reporting again. Battery {pct}%, {charging state}.` |
| `AC_RECONNECTED` | info | `🔌 Charger connected. Battery {pct}%.` |
| `MT5_NOT_RUNNING` | warning | `MT5 is not running on the laptop.` |
| `UNEXPECTED_SHUTDOWN` | critical | `The laptop shut down unexpectedly (detected at next start).` |

---

## 7. Settings (defaults)

```json
{
  "thresholds": [50, 30, 20, 15],
  "criticalLevel": 15,
  "criticalRepeatMin": 5,
  "offlineAfterSec": 180,
  "staleAfterSec": 120,
  "intervalSec": 45,
  "mt5Alert": true,
  "mt5DebounceSec": 120,
  "quietHours": { "enabled": false, "from": "23:00", "to": "06:00" },
  "alarmSound": "siren",
  "alarmVolume": 0.8,
  "vibrate": true,
  "theme": "dark",
  "timeZone": "Africa/Lagos",
  "retentionDays": 30
}
```

- `intervalSec` allowed range: **30–60**.
- `quietHours` mutes **info** and **warning** only — **never critical or HEARTBEAT_LOST**.

---

## 8. Derived status

### `status`
| Value | Condition |
|-------|-----------|
| `ONLINE` | age ≤ `staleAfterSec` |
| `STALE` | `staleAfterSec` < age ≤ `offlineAfterSec` |
| `OFFLINE` | age > `offlineAfterSec` |
| `PLANNED_STOP` | within `plannedStopUntil` |
| `NEVER_SEEN` | no reading ever received |

> Computed on every read from `lastSeenAt`. Never rely on a background job to flip it.

### `power`
`CHARGING` · `PLUGGED_NOT_CHARGING` (AC connected, not charging — e.g. 80% charge cap) · `ON_BATTERY` · `UNKNOWN`

### `severity`
| Value | Colour |
|-------|--------|
| `ok` | green |
| `info` | blue |
| `warning` | amber |
| `critical` | red |
| `unknown` | grey |

### `predictedEmptyAt`
While on battery: linear regression of percent over the last 15 minutes (minimum 5 samples); fall back to `secsLeft`; null if charging. Return both `trendSecsLeft` and `windowsSecsLeft`.

### `diagnosis` (STALE / OFFLINE only)
```json
{ "likelyCause": "...", "confidence": "likely|possible", "reasons": [] }
```

Heuristics:
- Last state on battery + percent ≤ 10 → **battery exhausted**.
- Last state on battery + falling trend + gap < predicted time to empty → **likely battery exhausted**.
- Last state AC connected + healthy percent → **internet loss, sleep, or agent stopped**.
- Last event `agent_stopping_planned` or `system_shutdown` → **stopped by owner**.
- Last event `resumed_from_sleep` shortly before silence → **sleep**.

Always word as "likely", never certain.

---

## 9. Alert engine rules

- **Cycle**: `currentCycleId` increments on each AC disconnect. `firedLevels` resets on AC connect.
- **Levels**: while on battery, when `percent` ≤ a threshold not yet in `firedLevels`, fire ONE alert for the **lowest crossed level** and mark **all** crossed levels as fired (so a jump 52→28 fires only the 30 alert).
- **Critical repeat**: while on battery and `percent` ≤ `criticalLevel`, re-send every `criticalRepeatMin` until acknowledged or AC connected.
- **AC disconnect** alert fires immediately on the event or on the first reading showing AC off.
- **Dedupe key**: `deviceId:type:level:cycleId` (heartbeat-lost uses an offline-episode id).
- **Heartbeat lost**: after `offlineAfterSec` with no reading, unless `plannedStopUntil` is in the future. Fires once per offline episode. When readings resume, resolve it and create `HEARTBEAT_RECOVERED`.
- **Backfilled readings** (older than 2 minutes): create history and events but **never live alerts**. Only the newest reading drives current state.
- **Quiet hours**: mute info and warning; **never mute critical or HEARTBEAT_LOST**.
- **Snooze**: silences repeats for an alert. **Ack**: stops repeats. Both are logged.
- **Planned stop**: `agent_stopping_planned` sets `plannedStopUntil = now + 15 min` (or until the next reading); `system_shutdown` does the same.

---

## 10. Security rules

- **Device token**: 32 random bytes, base64url, stored only as SHA-256 hash, compared in constant time, shown once, rotatable. Rate limit: **10 req/min per token** on agent routes.
- **Dashboard**: single owner, password hashed with argon2id/bcrypt, JWT in an `httpOnly`, `Secure`, `SameSite=Lax` cookie (14 days), CSRF defence via required `X-Requested-With: voltwatch` header on state-changing requests, login rate limit + lockout (5 failures → 15 min lock).
- helmet, strict CORS (same-origin only), HTTPS only, zod validation, no stack traces to clients, structured logs with token redaction.

---

## 11. Environment variables

### Backend
| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port |
| `MONGODB_URI` | Atlas connection string |
| `JWT_SECRET` | JWT signing secret |
| `OWNER_EMAIL` | Seed user email |
| `OWNER_PASSWORD_HASH` | Seed user password hash |
| `NODE_ENV` | `production` \| `development` |
| `APP_ORIGIN` | Allowed CORS origin |
| `RETENTION_DAYS` | Reading TTL override |
| `VAPID_PUBLIC_KEY` | Web Push (prompt 09 only) |
| `VAPID_PRIVATE_KEY` | Web Push (prompt 09 only) |

### Agent
Configured via `config.json`:
```json
{ "apiUrl": "...", "deviceToken": "...", "intervalSec": 45 }
```

### Dashboard
None — all calls go to `/api`.
