# ⚡ VoltWatch

**Laptop battery monitoring and remote alert system for unattended Windows trading rigs.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![Python ≥ 3.11](https://img.shields.io/badge/python-%E2%89%A53.11-blue)
![Platform: Windows 11](https://img.shields.io/badge/platform-Windows%2011-0078D4)
![Status: v1.0.0](https://img.shields.io/badge/status-v1.0.0-informational)

---

## Why VoltWatch?

Your Windows 11 laptop is running MetaTrader 5 with a live Expert Advisor. You are not home. The charger comes loose, the power strip trips, or a thunderstorm kills the circuit — and the only way you find out is when your EA misses a session.

VoltWatch closes that gap. A lightweight Python tray agent on the laptop reports battery percentage, charging state, AC power, MT5 process status, and heartbeats every 45 seconds to a Node.js backend. A mobile-first, installable dashboard on your phone shows live status, a history chart, a power-event timeline, battery insights, and an alert inbox. When the laptop goes silent for more than three minutes, a critical alarm sounds — even on the lock screen if Web Push is enabled.

---

## Screenshots

| Screen | File |
|--------|------|
| Live status | `docs/screenshots/live.png` |
| Critical battery alarm | `docs/screenshots/critical-alarm.png` |
| History chart | `docs/screenshots/history-chart.png` |
| Timeline / events | `docs/screenshots/timeline.png` |
| Insights | `docs/screenshots/insights.png` |
| Alerts inbox | `docs/screenshots/alerts-inbox.png` |
| Agent tray icon | `docs/screenshots/agent-tray.png` |

---

## Table of Contents

1. [Features](#1-features)
2. [How It Works](#2-how-it-works)
3. [Alert Reference](#3-alert-reference)
4. [Tech Stack](#4-tech-stack)
5. [Repository Structure](#5-repository-structure)
6. [Getting Started](#6-getting-started)
7. [Configuration](#7-configuration)
8. [Using VoltWatch](#8-using-voltwatch)
9. [Pre-Travel Checklist](#9-pre-travel-checklist)
10. [API Overview](#10-api-overview)
11. [Deployment](#11-deployment)
12. [Security](#12-security)
13. [Testing](#13-testing)
14. [Troubleshooting / FAQ](#14-troubleshooting--faq)
15. [Limitations](#15-limitations)
16. [Roadmap](#16-roadmap)
17. [Contributing](#17-contributing)
18. [License](#18-license)
19. [Author](#19-author)

---

## 1. Features

### 🤖 Monitoring Agent (Windows)
- Reads battery percentage and AC/charging state via `psutil`, with a PowerShell `Win32_Battery` fallback.
- Detects AC transitions within 5 seconds and sends an immediate event.
- Watches `terminal64.exe` / `terminal.exe` for MT5 status.
- Stores undelivered readings in a local SQLite queue (up to 10 000 rows / 7 days), flushed on reconnect via `/agent/batch`.
- Exponential back-off with ±25 % jitter on retries (5 s → 10 s → … → 5 min).
- Detects sleep gaps via monotonic vs wall-clock comparison; logs `resumed_from_sleep` on wake.
- Detects unexpected shutdowns by querying the Windows Event Log (Kernel-Power 41 / EventLog 6008) on startup.
- Sends `agent_stopping_planned` before a clean exit so no false offline alert fires.
- System tray icon with colour-coded battery level (green / blue / amber / red / grey).
- One-click **Start with Windows** autostart toggle (HKCU Run key, no admin needed).
- **Doctor mode** (`--doctor`) checks battery, config, server reachability, token validity, clock drift, queue size, and MT5.
- Single-instance guard via a named Windows mutex.
- Config stored at `%LOCALAPPDATA%\VoltWatch\config.json`; token stored in Windows Credential Manager.

### 🖥️ Backend and Alerting
- Node 20, Express, Mongoose, MongoDB Atlas.
- Pure-functional alert engine (`alertEngine.js`) — zero I/O, fully unit-tested.
- Heartbeat-lost detection: `offlineWatcher` polls every 30 seconds; fires one `HEARTBEAT_LOST` per offline episode (idempotent via dedupeKey).
- Critical-battery repeat job: re-notifies every `criticalRepeatMin` (default 5 min) until acknowledged or charger reconnected.
- Hourly reading rollups retained for 365 days; raw readings TTL 30 days.
- Server-Sent Events (`/api/v1/stream`) for real-time push to the dashboard; falls back to polling.
- Web Push notifications via the `web-push` / VAPID standard (requires VAPID keys).
- Extensible `Notifier` interface: register any additional notifier (e.g. Telegram) without touching the alert engine.
- Dead-man safeguard: `/health` returns `deadManWarning: true` if no reading has been processed in `DEAD_MAN_SEC` seconds (default 600 s).

### 📱 Dashboard (PWA)
- Mobile-first, installable Progressive Web App (Bootstrap 5, vanilla JS ES modules, Chart.js 4).
- **Live** — battery gauge, runway estimate, 60-minute sparkline, offline diagnosis card, quick actions.
- **History** — interactive battery % chart (1 h / 6 h / 24 h / 7 d / 30 d), AC bands, MT5 strip; pinch/scroll to zoom; gap annotations; CSV export.
- **Timeline** — infinite-scroll power event feed with category filters and a detail bottom sheet.
- **Insights** — aggregated stats per device (time on battery, average %, power-cut count, MT5 uptime).
- **Alerts** — inbox with severity filters, active/history tabs, acknowledge and snooze actions.
- **Devices** — three-step wizard to add a device and pair the agent; live heartbeat listener.
- **Settings** — alert thresholds, quiet hours, alarm sound/volume, time zone, push notifications.
- **Glance mode** — large-text battery view for quick phone glances.
- Full dark/light theme support; flash-of-wrong-theme prevention via `localStorage`.

### ⚙️ Reliability
- Derived status (ONLINE / STALE / OFFLINE / PLANNED_STOP / NEVER_SEEN) computed on every read from `lastSeenAt` — no background job required.
- Offline diagnosis heuristics: battery exhausted, internet loss, sleep, agent stopped, owner-planned stop.
- Backfilled readings (from the agent queue) create history and events but never trigger live alerts.
- Duplicate `readingId` detection (UUID v4 idempotency key) prevents double-counting.
- Clock-skew rejection: readings more than 5 min in the future or past `offlineAfterSec` are rejected.
- PWA service worker caches the app shell; opens from cache while offline.
- Graceful shutdown: backend handles SIGTERM, closes the HTTP server, disconnects MongoDB.

### 🔒 Security
- Device tokens: 32 random bytes, base64url, stored only as SHA-256 hex.
- Sessions: JWT in `httpOnly`, `Secure`, `SameSite=Lax` cookie (14-day expiry).
- CSRF defence: `X-Requested-With: voltwatch` header on all mutating dashboard requests.
- Login lockout: 5 failures → 15-minute lock.
- Rate limits: 20 login req / 15 min; 200 dashboard req / min; 10 agent req / min per token.
- `sanitizeBody` middleware strips all `$`-prefixed and `.`-containing keys from request bodies.
- Structured logging via Pino; `Authorization` header redacted in all log output.

---

## 2. How It Works

### Architecture

```mermaid
graph TD
    subgraph Laptop["🖥️ Windows 11 Laptop"]
        Agent["Python Agent\n(voltwatch_agent)"]
        MT5["MetaTrader 5\n(terminal64.exe)"]
        SQLite["SQLite Queue\n(offline buffer)"]
        Agent -->|watches| MT5
        Agent <-->|offline buffer| SQLite
    end

    subgraph Cloud["☁️ Cloud"]
        Backend["Node.js / Express Backend\n(Render)"]
        MongoDB["MongoDB Atlas\n(readings, alerts, events)"]
        Backend <-->|Mongoose| MongoDB
    end

    subgraph Dashboard["📱 Dashboard (Vercel)"]
        PWA["PWA — HTML / JS / Chart.js\n(mobile browser)"]
        SW["Service Worker\n(offline cache)"]
        PWA <-->|cached shell| SW
    end

    Agent -->|POST /agent/heartbeat\nPOST /agent/batch\nBearer token| Backend
    PWA -->|/api/* rewrite\nsession cookie| Backend
    Backend -->|SSE or polling| PWA
    Backend -->|Web Push| PWA
```

### Sequence: AC Power Cut → Critical Alarm

```mermaid
sequenceDiagram
    participant Agent as Python Agent
    participant Backend as Node.js Backend
    participant DB as MongoDB
    participant Dashboard as PWA Dashboard

    Agent->>Backend: POST /agent/heartbeat\n{event:"ac_disconnected", percent:96}
    Backend->>DB: Save Reading
    Backend->>DB: Increment cycleId, clear firedLevels
    Backend->>DB: Create AC_DISCONNECTED alert
    Backend->>Dashboard: SSE: {type:"alert", severity:"warning"}
    Dashboard-->>Dashboard: Show AC banner

    Note over Agent,Backend: Battery drains…

    Agent->>Backend: POST /agent/heartbeat\n{percent:15, acConnected:false}
    Backend->>DB: Save Reading
    Backend->>DB: Create CRITICAL_BATTERY alert (dedupeKey unique)
    Backend->>Dashboard: SSE: {type:"alert", severity:"critical"}
    Dashboard-->>Dashboard: Red takeover overlay + alarm sound
    Backend->>Dashboard: Web Push notification (if subscribed)
```

### Offline Queue

When the laptop's internet connection drops, the agent stores each reading in a local SQLite database (`%LOCALAPPDATA%\VoltWatch\queue.db`). When connectivity returns, the freshest reading is posted first (so the Live screen updates immediately), then the queue is flushed oldest-first in batches of 500 via `POST /api/v1/agent/batch`. The backend marks these readings `backfilled: true` and processes them for history and events — but **never fires live alerts from backfilled readings**, since by the time they arrive the situation may already have resolved.

### Silent Laptop Detection

The device status (ONLINE / STALE / OFFLINE) is **derived on every read** from `device.lastSeenAt`, not from a scheduled flag update. The `offlineWatcher` job runs every 30 seconds and fires a `HEARTBEAT_LOST` alert when `lastSeenAt` has exceeded `offlineAfterSec` (default 180 s) and no `plannedStopUntil` grace window is active. Each offline episode fires **one** alert, identified by a dedupeKey containing the `lastSeenAt` timestamp — so restarting the backend does not fire duplicate alerts.

---

## 3. Alert Reference

<details>
<summary>Click to expand the full alert reference table</summary>

### Alert types

| Type | Severity | Default Trigger | Message template |
|------|----------|----------------|-----------------|
| `AC_DISCONNECTED` | warning | First reading with AC off (or `ac_disconnected` event) | `⚡ Your laptop is now running on battery. Current charge: {pct}%. MT5 is {running/not running}.` |
| `LOW_BATTERY` | info (≥50 %) · warning (≥30 %) · high (≥20 %) | `percent` ≤ threshold, not yet fired this cycle | `⚠️ Battery is at {pct}%. Your laptop is still running. Please restore power.` |
| `CRITICAL_BATTERY` | critical | `percent` ≤ `criticalLevel` (default 15 %) | `🚨 Battery is at {pct}%. MT5 may stop if the laptop shuts down. Take immediate action.` |
| `HEARTBEAT_LOST` | critical | No heartbeat for > `offlineAfterSec` (default 180 s) | `No heartbeat received for {n} minutes. The laptop may have lost power, lost internet, or the monitoring agent may have stopped.` |
| `HEARTBEAT_RECOVERED` | info | First reading after a `HEARTBEAT_LOST` | `Laptop is reporting again. Battery {pct}%, {charging state}.` |
| `AC_RECONNECTED` | info | First reading with AC on after being off | `🔌 Charger connected. Battery {pct}%.` |
| `MT5_NOT_RUNNING` | warning | MT5 absent for > `mt5DebounceSec` (default 120 s) | `MT5 is not running on the laptop.` |
| `UNEXPECTED_SHUTDOWN` | critical | `unexpected_shutdown_detected` event on agent restart | `The laptop shut down unexpectedly (detected at next start).` |

### Default thresholds

| Setting | Default | Range / Notes |
|---------|---------|---------------|
| `thresholds` | `[50, 30, 20, 15]` | Percentage levels that trigger LOW_BATTERY |
| `criticalLevel` | `15` | Must be ≤ lowest threshold |
| `criticalRepeatMin` | `5` | Minutes between CRITICAL_BATTERY repeats |
| `offlineAfterSec` | `180` | Seconds before HEARTBEAT_LOST fires |
| `staleAfterSec` | `120` | Seconds before status turns STALE |
| `intervalSec` | `45` | Agent heartbeat interval (30–60 allowed) |
| `mt5DebounceSec` | `120` | MT5 absence debounce before MT5_NOT_RUNNING fires |

### Dedupe behaviour

Each alert carries a `dedupeKey`: `{deviceId}:{type}:{level}:{cycleId}`. A unique sparse index on this field prevents duplicate alerts even if the watcher or repeat job fires concurrently. The `currentCycleId` increments on each AC disconnect; `firedLevels` resets on AC reconnect, so each battery episode fires each threshold at most once.

When battery drops across multiple thresholds in a single reading (e.g. 52 % → 28 %), the engine fires **one** alert for the lowest crossed level (28 % → level 30) and marks all crossed thresholds as fired.

### Quiet hours

Quiet hours mute **info**, **warning**, and **high** alerts only. `CRITICAL_BATTERY` and `HEARTBEAT_LOST` are **never** muted regardless of quiet-hours settings.

</details>

---

## 4. Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **Agent** | Python 3.11 + psutil, pystray, Pillow, keyring | Native Windows battery/process access; system tray without admin rights |
| **Agent packaging** | PyInstaller (`build.bat`) | Single `.exe` for easy distribution to non-Python users |
| **Agent queue** | SQLite (`queue.py`) | Zero-dependency, no network needed, survives crashes |
| **Backend** | Node.js 20, Express 4, ES modules | Fast, lightweight, good ecosystem for REST + SSE |
| **Database** | MongoDB Atlas via Mongoose 8 | Flexible schema for readings; TTL indexes for automatic data expiry |
| **Auth** | JWT (jsonwebtoken) + argon2id (argon2) | Stateless sessions; best-practice password hashing |
| **Input validation** | Zod | Schema-first; errors are safe to return to clients |
| **Logging** | Pino + pino-http | Structured JSON logs; token redaction built-in |
| **Security middleware** | Helmet, express-rate-limit, CORS | Security headers, rate limiting, origin enforcement |
| **Web Push** | web-push (VAPID) | Standard push without a third-party service |
| **Dashboard** | HTML, Bootstrap 5, vanilla JS ES modules | No build step; works as a static Vercel deployment |
| **Charts** | Chart.js 4 + chartjs-adapter-date-fns + chartjs-plugin-zoom | Time-axis charts with pinch-to-zoom |
| **PWA** | Service Worker (`sw.js`) + Web App Manifest | Installable on iOS/Android; offline shell |
| **Dashboard hosting** | Vercel (static + `/api` rewrite) | Free CDN; HTTPS; same-origin cookies via rewrite |
| **Backend hosting** | Render (Docker) | Always-on Starter tier; GitHub auto-deploy |
| **CI** | GitHub Actions | Backend tests, agent tests, simulator end-to-end assertion |

---

## 5. Repository Structure

```
voltwatch/
├── agent/                      Python Windows tray agent
│   ├── voltwatch_agent/
│   │   ├── main.py             Orchestrator, sampling loop, doctor mode
│   │   ├── battery.py          Battery reading (psutil + PowerShell fallback)
│   │   ├── mt5.py              MT5 process detection
│   │   ├── client.py           HTTP client (heartbeat, batch, drift check)
│   │   ├── queue.py            SQLite offline queue + exponential back-off
│   │   ├── winevents.py        Sleep/resume detection, shutdown event log
│   │   ├── tray.py             pystray tray icon + menu
│   │   ├── pairing.py          Tkinter first-run setup dialog
│   │   ├── config.py           Load/save config, keyring token, autostart
│   │   ├── logging_setup.py    Rotating file log + token-redaction filter
│   │   └── version.py          VERSION + BUILD_DATE (stamped by build.bat)
│   ├── tests/                  Pure-function pytest tests (no Windows dependency)
│   ├── requirements.txt
│   ├── build.bat               PyInstaller packaging script
│   └── README.md
│
├── backend/                    Node 20 REST API
│   ├── src/
│   │   ├── config/             Environment variable loader
│   │   ├── models/             Mongoose schemas (User, Device, Reading, Alert, …)
│   │   ├── middleware/         Auth, CSRF, rate limiting, sanitize, error handler
│   │   ├── routes/             auth, devices, agent, alerts, settings, health, stream
│   │   ├── services/
│   │   │   ├── alertEngine.js            Pure evaluate() function
│   │   │   ├── alertEngineService.js     Applies effects to MongoDB
│   │   │   ├── offlineWatcher.js         Heartbeat-lost detector (30 s interval)
│   │   │   ├── criticalRepeatJob.js      Re-fires critical alerts
│   │   │   ├── rollupJob.js              Hourly reading aggregation
│   │   │   ├── statusService.js          Derived status + diagnosis
│   │   │   ├── insightsService.js        Aggregated stats
│   │   │   └── notifier/                 Registry + InAppNotifier + WebPushNotifier
│   │   ├── app.js              Express factory (no listen)
│   │   └── server.js           DB connect, owner bootstrap, jobs, listen
│   ├── scripts/
│   │   ├── hash-password.js    Generate argon2id hash
│   │   └── gen-vapid.js        Generate VAPID key pair
│   ├── tests/                  Jest test suites (mongodb-memory-server)
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
│
├── dashboard/                  Static PWA
│   ├── app.html                Single-page app shell
│   ├── landing.html            Public landing page
│   ├── js/                     ES module JS (app, api, router, poller, push, …)
│   ├── css/                    Design tokens, base, components, pages
│   ├── icons/                  PWA icons
│   ├── sw.js                   Service worker
│   ├── manifest.webmanifest
│   └── vercel.json             Rewrites, headers, caching rules
│
├── tools/
│   └── simulator/              CLI agent simulator
│       ├── simulate.js         Scenario runner + assertion mode
│       ├── seed.js             30-day history seeder
│       ├── scenarios.js        All scenario generators
│       ├── lib.js              Shared HTTP helpers, PRNG, UUID
│       └── README.md
│
├── docs/
│   ├── 01-master-spec.md       Source of truth — data models, API contract, alert rules
│   ├── openapi.yaml            Full OpenAPI 3 spec
│   ├── runbook.md              Step-by-step deployment guide
│   ├── security-review.md      OWASP-aligned security review
│   ├── test-plan.md            30-scenario manual + simulator test plan
│   ├── pre-travel-checklist.md Checklist to run before leaving the laptop unattended
│   └── screenshots/            README listing required screenshots
│
├── .github/workflows/ci.yml   GitHub Actions CI
├── package.json                Root npm scripts (sim, seed, backend:dev, backend:test)
├── LICENSE                     MIT
└── README.md                   ← you are here
```

---

## 6. Getting Started

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | https://nodejs.org |
| Python | ≥ 3.11 | https://python.org (Windows only for agent) |
| Git | any | https://git-scm.com |
| MongoDB Atlas account | — | https://cloud.mongodb.com |
| Render account (backend) | — | https://render.com |
| Vercel account (dashboard) | — | https://vercel.com |

Clone the repo:

```powershell
git clone https://github.com/ShimboJr/VoltWatch.git
cd VoltWatch
```

---

### 6a. Backend + MongoDB

**1. Create a MongoDB Atlas cluster** (free M0 tier is fine for personal use). Create a database user with `readWrite` access to the `voltwatch` database and copy the SRV connection string. See [`docs/runbook.md §2`](docs/runbook.md) for full steps.

**2. Install backend dependencies:**

```powershell
cd backend
npm install
```

**3. Copy and fill in the environment file:**

```powershell
Copy-Item .env.example .env
notepad .env
```

**4. Start in development mode** (auto-restarts on file changes):

```powershell
npm run dev
# or from the repo root:
npm run backend:dev
```

Verify it is healthy:

```powershell
Invoke-RestMethod http://localhost:3001/api/v1/health
# → { ok: True, db: 'connected', ... }
```

---

### 6b. Dashboard (local preview)

The dashboard is a plain static site — no build step. Open `dashboard/app.html` directly in a browser, or serve it with any static server:

```powershell
# Python built-in server (port 3000)
python -m http.server 3000 --directory dashboard
```

Navigate to `http://localhost:3000/app`.

> The dashboard calls `/api/*` via the Vercel rewrite in production. For local development, the backend URL is read from `dashboard/js/config.js` (`window.VOLTWATCH_API`). By default it points to `http://localhost:3001/api/v1`.

---

### 6c. Create the owner password hash and first device

**Generate a password hash** (argon2id):

```powershell
cd backend
npm run hash-password yourSecretPassword
# → $argon2id$v=19$m=65536,t=3,p=4$...
```

Set `OWNER_EMAIL` and `OWNER_PASSWORD_HASH` in `backend/.env`. The server upserts the owner account on first start.

**Generate a JWT secret** (48+ random bytes):

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Set this as `JWT_SECRET` in `.env`.

**Create the first device** via the dashboard UI (Settings → Devices → Add device) or via curl:

```bash
# Login
curl -s -c cookies.txt \
  -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"email":"owner@example.com","password":"yourSecretPassword"}' | jq

# Create device (token shown ONCE — save it)
curl -s -b cookies.txt \
  -X POST http://localhost:3001/api/v1/devices \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: voltwatch" \
  -d '{"name":"Trading Laptop"}' | jq
```

Save the returned `token` — it will not be shown again.

---

### 6d. Install and pair the Windows agent

**From source (development):**

```powershell
cd agent
pip install -r requirements.txt

# First run — supply URL and token to bootstrap config
python -m voltwatch_agent.main --api https://your-backend.com/api/v1 --token YOUR_DEVICE_TOKEN

# Subsequent runs — credentials are loaded from saved config
python -m voltwatch_agent.main

# Headless (no tray, useful for testing)
python -m voltwatch_agent.main --no-tray

# Doctor mode — checks everything
python -m voltwatch_agent.main --doctor
```

**Using the pre-built exe** (after `build.bat`):

```powershell
cd agent
build.bat
# Output: agent\dist\VoltWatchAgent.exe

# First run — pairing dialog appears if no config exists
.\dist\VoltWatchAgent.exe
# Or supply args to skip the dialog:
.\dist\VoltWatchAgent.exe --api https://your-backend.com/api/v1 --token YOUR_DEVICE_TOKEN
```

Credentials are saved to `%LOCALAPPDATA%\VoltWatch\config.json` and the token to Windows Credential Manager.

Enable **Start with Windows** from the tray menu to run the agent automatically at login.

---

### 6e. Run the simulator (no real laptop needed)

The simulator sends readings just like the real agent — useful for development, demos, and testing.

**From the repo root:**

```powershell
# Power-cut scenario at 60× speed
npm run sim -- --token YOUR_DEVICE_TOKEN --scenario power-cut --speed 60

# 30-day history seed (idempotent)
npm run seed -- --token YOUR_DEVICE_TOKEN

# Fast-drain with assertion (exits 0 on pass, 1 on fail)
npm run sim -- --token YOUR_DEVICE_TOKEN --scenario fast-drain --speed 120 --assert --owner-email owner@example.com --owner-password yourSecretPassword
```

**Available scenarios:**

| Scenario | What happens | Expected alerts |
|----------|-------------|-----------------|
| `normal` | Plugged in at 100%, steady heartbeats | None |
| `power-cut` | AC unplugged at 96%, drain to 5%, charger reconnected | `AC_DISCONNECTED`, `LOW_BATTERY` ×3, `CRITICAL_BATTERY`, `AC_RECONNECTED` |
| `fast-drain` | Jump 52 % → 28 % in one reading | `AC_DISCONNECTED`, `LOW_BATTERY` at 30 % only |
| `agent-crash` | Heartbeats stop at 41 % on battery | `AC_DISCONNECTED`, then `HEARTBEAT_LOST` |
| `internet-loss` | 10-min outage flushed via `/batch` | None (backfilled) |
| `planned-stop` | `agent_stopping_planned`, then silence | None within 15-min grace window |
| `sleep-resume` | Gap then `resumed_from_sleep` event | `AC_DISCONNECTED` |
| `mt5-stops` | MT5 flips false on battery | `AC_DISCONNECTED`, `MT5_NOT_RUNNING` |
| `shutdown-recovery` | Silent then `unexpected_shutdown_detected` | `UNEXPECTED_SHUTDOWN` |
| `full-day` | 24 h compressed with two power cuts | Multiple |

---

## 7. Configuration

### Backend environment variables

<details>
<summary>Click to expand the full backend env reference</summary>

| Variable | Required | Default | Description | Example |
|----------|----------|---------|-------------|---------|
| `PORT` | No | `3001` | HTTP port | `3001` |
| `NODE_ENV` | No | `development` | Runtime mode | `production` |
| `MONGODB_URI` | **Yes** | `mongodb://127.0.0.1:27017/voltwatch` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/voltwatch` |
| `JWT_SECRET` | **Yes** | *(insecure dev default)* | JWT signing secret (≥ 48 random bytes recommended) | `base64url string` |
| `OWNER_EMAIL` | **Yes** | — | Owner account email, seeded on first start | `you@example.com` |
| `OWNER_PASSWORD_HASH` | **Yes** | — | argon2id hash — generate with `npm run hash-password` | `$argon2id$v=19$...` |
| `APP_ORIGIN` | No | `http://localhost:3000` | Dashboard origin for CORS (no trailing slash) | `https://your-voltwatch.vercel.app` |
| `RETENTION_DAYS` | No | `30` | Raw reading TTL in days | `30` |
| `LOG_LEVEL` | No | `info` | Pino log level | `warn` |
| `VAPID_PUBLIC_KEY` | No | — | Web Push public key — generate with `npm run gen-vapid` | VAPID base64url string |
| `VAPID_PRIVATE_KEY` | No | — | Web Push private key (keep secret) | VAPID base64url string |
| `BREVO_API_KEY` | No | — | Brevo transactional email API key | `xkeysib-...` |
| `RESEND_API_KEY` | No | — | Resend transactional email API key (alternative to Brevo) | `re_...` |
| `APP_URL` | No | falls back to `APP_ORIGIN` | Full dashboard URL used in email links | `https://your-voltwatch.vercel.app` |
| `FROM_EMAIL` | No | `noreply@voltwatch-dashboard.vercel.app` | Sender address for email notifications | `noreply@yourdomain.com` |
| `FROM_NAME` | No | `VoltWatch` | Sender display name | `VoltWatch` |
| `DEAD_MAN_SEC` | No | `600` | Seconds without a reading before `/health` warns | `600` |

</details>

### Agent configuration

The agent reads `%LOCALAPPDATA%\VoltWatch\config.json`:

```json
{
  "apiUrl": "https://your-backend.com/api/v1",
  "deviceToken": "stored-in-credential-manager",
  "intervalSec": 45
}
```

`intervalSec` must be between 30 and 60. The backend's `intervalSec` response overrides this value in real time.

### Dashboard-configurable settings

These are set via Settings in the dashboard UI and stored in the owner's `User.settings` document:

| Setting | Default | Description |
|---------|---------|-------------|
| `thresholds` | `[50, 30, 20, 15]` | Battery % levels that trigger LOW_BATTERY alerts |
| `criticalLevel` | `15` | Level that triggers CRITICAL_BATTERY (must be ≤ min threshold) |
| `criticalRepeatMin` | `5` | Minutes between repeated critical alerts |
| `offlineAfterSec` | `180` | Seconds before HEARTBEAT_LOST fires |
| `staleAfterSec` | `120` | Seconds before status shows STALE |
| `intervalSec` | `45` | Agent heartbeat interval, sent in heartbeat response |
| `mt5Alert` | `true` | Enable / disable MT5_NOT_RUNNING alerts |
| `mt5DebounceSec` | `120` | MT5 absence debounce in seconds |
| `quietHours.enabled` | `false` | Enable quiet hours |
| `quietHours.from` | `"23:00"` | Quiet hours start (local time) |
| `quietHours.to` | `"06:00"` | Quiet hours end (local time) |
| `alarmSound` | `"siren"` | In-app critical alarm sound |
| `alarmVolume` | `0.8` | Alarm volume (0–1) |
| `vibrate` | `true` | Vibration on critical alert |
| `theme` | `"dark"` | Dashboard theme (`dark` / `light`) |
| `timeZone` | `"Africa/Lagos"` | IANA timezone for display and quiet hours |
| `retentionDays` | `30` | Reading retention (informational; TTL set via `RETENTION_DAYS` env var) |

---

## 8. Using VoltWatch

### Dashboard screens

| Screen | What it shows |
|--------|---------------|
| **Live** | Battery gauge, power state chip (CHARGING / PLUGGED_NOT_CHARGING / ON_BATTERY), MT5 status, runway prediction, 60-minute sparkline, offline diagnosis when the device is STALE or OFFLINE |
| **History** | Interactive battery % chart for 1 h / 6 h / 24 h / 7 d / 30 d, with AC shading bands and MT5/agent strip; pinch or scroll to zoom; annotated gap markers; CSV export |
| **Timeline** | Chronological feed of all power events (AC transitions, agent starts/stops, heartbeat lost/recovered, MT5 events); filterable by category; tap any event for detail |
| **Insights** | Aggregated stats for the selected range (24 h / 7 d / 30 d): time on battery, average battery %, number of power cuts, MT5 uptime percentage |
| **Alerts** | Inbox of active and past alerts; filter by severity; acknowledge or snooze individual alerts; alert-channel panel (in-app always active; Web Push toggle) |
| **Devices** | Manage registered devices; add a new device via the three-step wizard; rotate tokens |
| **Settings** | Alert thresholds, quiet hours, alarm, time zone, push notifications |

### Running the agent unattended

1. Enable **Start with Windows** from the tray menu (adds a HKCU Run registry key).
2. Keep the laptop plugged in and awake (see [Section 9](#9-pre-travel-checklist)).
3. Leave it — the agent runs silently in the system tray, reporting every 45 seconds.

### Planned stop vs killing the process

| Action | What the agent sends | Effect on alerts |
|--------|---------------------|-----------------|
| **Tray → Quit** | `agent_stopping_planned` event | Sets `plannedStopUntil = now + 15 min`; no HEARTBEAT_LOST within that window |
| **Tray → Pause Reporting** | `agent_stopping_planned` event | Same grace window; agent stays running but stops sending readings |
| **`taskkill /F`** or crash | Nothing — process is killed | HEARTBEAT_LOST fires after `offlineAfterSec` (default 3 min) |
| **Windows shutdown** | `system_shutdown` event (best-effort via `WM_QUERYENDSESSION`) | Sets `plannedStopUntil`; no false alert |

### Offline diagnosis

When the device is STALE or OFFLINE, the Live screen shows a **diagnosis card** with a likely cause and confidence level:

| Last known state | Heuristic | Likely cause |
|-----------------|-----------|-------------|
| On battery, percent ≤ 10 % | — | Battery exhausted |
| On battery, falling trend, gap < predicted time to empty | Linear regression | Likely battery exhausted |
| AC connected, healthy percent | — | Internet loss, sleep, or agent stopped |
| Last event `agent_stopping_planned` or `system_shutdown` | — | Stopped by owner |
| `resumed_from_sleep` shortly before silence | — | Sleep |

The diagnosis is always phrased as "likely" — it is a heuristic, not a certainty.

---

## 9. Pre-Travel Checklist

Run this at your trading desk before you leave. Full checklist: [`docs/pre-travel-checklist.md`](docs/pre-travel-checklist.md).

**Quick summary:**

- [ ] Charger plugged in, laptop showing charging.
- [ ] Windows **Sleep: Never** and **Hibernate: Never** (on battery and plugged in).
- [ ] Lid close action: **Do nothing** (on battery and plugged in).

  ```powershell
  # Fast path — run as admin in PowerShell:
  powercfg /change standby-timeout-dc 0
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-dc 0
  powercfg /change hibernate-timeout-ac 0
  ```

- [ ] Windows Update **active hours** set; restart policy set to "Notify to schedule restart".
- [ ] MT5 in **Windows Startup** (Task Manager → Startup tab); AutoTrading button green.
- [ ] VoltWatch agent running — tray icon visible; Live screen shows **green Online**.
- [ ] Dashboard Live screen on phone matches battery % and AC state visible on laptop.
- [ ] **Alarm armed** in Settings → Alarm; phone **not on silent**.
- [ ] Push notifications enabled and tested (Settings → Push → Send test push).
- [ ] **BIOS:** "Power on after AC restore" = **Power On** or **Last State** (laptop turns back on after a power cut and restore without you pressing the power button).

---

## 10. API Overview

| Group | Prefix | Auth | Description |
|-------|--------|------|-------------|
| Agent | `/api/v1/agent/` | Bearer device token | `POST /heartbeat`, `POST /batch` |
| Auth | `/api/v1/auth/` | — / cookie | Login, logout, me |
| Devices | `/api/v1/devices/` | Cookie session | CRUD, token rotation, status, readings, events, insights |
| Alerts | `/api/v1/alerts/` | Cookie session | List, ack, snooze, test |
| Settings | `/api/v1/settings` | Cookie session | Get / update owner settings |
| Stream | `/api/v1/stream` | Cookie session | Server-Sent Events (status, alert, event) |
| Health | `/api/v1/health` | Public | `{ ok, db, lastReadingAt, deadManWarning }` |
| Push | `/api/v1/push/` | Cookie session | Subscribe, list subscriptions, delete, test |

Full OpenAPI 3 specification: [`docs/openapi.yaml`](docs/openapi.yaml).

---

## 11. Deployment

Full step-by-step guide: [`docs/runbook.md`](docs/runbook.md).

### MongoDB Atlas (free M0)

1. Create a project and an M0 cluster.
2. Add a database user with `readWrite` on the `voltwatch` database.
3. Allow network access from your backend host (or `0.0.0.0/0` with auth as the defence).
4. Copy the SRV connection string into `MONGODB_URI`.

### Backend on Render

1. **New Web Service** → connect the GitHub repo → Root directory: `backend` → Runtime: Docker.
2. Instance type: **Starter ($7/month)** — the free tier sleeps and will miss heartbeats.
3. Set all environment variables from the [Configuration section](#7-configuration).
4. Health check path: `/api/v1/health`.
5. Set **Instances: 1** (background jobs must not run in parallel).

### Dashboard on Vercel

1. **New Project** → import the repo → Root directory: `dashboard` → Framework preset: Other → Build command: *(empty)* → Output directory: `.`.
2. Update `dashboard/vercel.json` — set the `destination` in the `/api/(.*)` rewrite to your Render backend URL.
3. Set `APP_ORIGIN` in Render to your Vercel dashboard URL.

---

## 12. Security

### How security works

| Mechanism | Implementation |
|-----------|---------------|
| **Device tokens** | 32 random bytes, base64url. Shown once, then discarded. Only the SHA-256 hex hash is stored. Compared in constant time. Rotatable from the dashboard in ~30 seconds. |
| **Sessions** | JWT signed with `JWT_SECRET`, stored in an `httpOnly`, `Secure`, `SameSite=Lax` cookie with a 14-day expiry. Not accessible to JavaScript. |
| **CSRF protection** | All state-changing dashboard requests must include `X-Requested-With: voltwatch`. Cookie `SameSite=Lax` prevents cross-site form submission. |
| **Rate limiting** | 20 login requests / 15 min per IP. 200 dashboard requests / min per IP. 10 agent requests / min per device token. |
| **Login lockout** | 5 failed attempts → account locked for 15 minutes. Constant-time delay on bad email to prevent user enumeration. |
| **Input validation** | All inputs validated with Zod. Body limit: 256 KB. `sanitizeBody` middleware strips `$`-prefixed and `.`-containing keys from all request bodies. |
| **Token logging** | The `Authorization` header is redacted in all Pino log output. Token hashing in the rate-limit key means the raw token never touches logs. |
| **Error leakage** | Stack traces are logged server-side only. Clients receive a generic error message in production. Zod validation messages (safe, structured) are returned for 400 errors. |
| **Transport** | HTTPS enforced in production. HSTS provided by Vercel and Render (custom domain). |
| **Dependency auditing** | `npm audit --audit-level=high` and `pip-audit` run in CI on every push. |

### Reporting a vulnerability

If you discover a security issue, please report it privately by emailing the author via the contact on [the portfolio](https://shimbojr-portfolio.vercel.app/) rather than opening a public issue. Include steps to reproduce and your assessment of severity. You will receive a response within 7 days.

---

## 13. Testing

### Backend tests (Jest + mongodb-memory-server)

```powershell
cd backend
npm test
# or from the repo root:
npm run backend:test
```

No external MongoDB required — tests spin up an in-memory instance. Test suites:

| File | Coverage |
|------|---------|
| `tests/auth.test.js` | Login, lockout, CSRF rejection, logout, `/me` |
| `tests/devices.test.js` | Create (token shown once, hash stored), rotate, cascade delete |
| `tests/agent.test.js` | Auth failures, idempotency, batch ordering and backfilling |
| `tests/readings.test.js` | Downsampling ≤ 300 points, gap detection |
| `tests/status.test.js` | ONLINE / STALE / OFFLINE at exact thresholds, power states |
| `tests/alertEngine.test.js` | Pure engine: AC transitions, threshold crossing, quiet hours, dedup |
| `tests/webPushNotifier.test.js` | Push subscription and notification dispatch |

### Agent tests (pytest)

```powershell
cd agent
python -m pytest tests/ -v
```

Tests are pure-function and run on any platform — no Windows, no battery, no network needed.

| File | Coverage |
|------|---------|
| `tests/test_battery_mt5.py` | Battery parsers, AC detection, MT5 |
| `tests/test_client_queue_winevents.py` | Payload builder, queue, back-off, sleep/shutdown |

### Simulator end-to-end assertion

```powershell
# Against a local backend:
npm run sim -- --token $TOKEN --scenario fast-drain --speed 120 --assert --owner-email owner@example.com --owner-password yourPassword
# Exit code 0 = PASSED, 1 = alerts not found
```

The CI pipeline runs this assertion automatically as the `simulator-e2e` job after the backend job passes.

### CI checks (GitHub Actions)

The `.github/workflows/ci.yml` runs three jobs on every push to `main` or `dev`:

1. **`backend`** — `npm ci`, `npm test`, `npm audit --audit-level=high`.
2. **`agent`** — `pip install`, `pip-audit`, `pytest`.
3. **`simulator-e2e`** — starts a real backend against a MongoDB Docker service, runs the `fast-drain --assert` scenario, verifies at least one alert was created.

---

## 14. Troubleshooting / FAQ

<details>
<summary>Click to expand all FAQs</summary>

### Agent tray icon is grey / no readings appear

The agent is either not running, cannot reach the backend, or the device token is invalid.

1. Open a terminal and run `python -m voltwatch_agent.main --doctor` (or `VoltWatchAgent.exe --doctor`). It will print the status of each check.
2. Verify the API URL: `Invoke-RestMethod https://your-backend.com/api/v1/health` should return `{ ok: true }`.
3. Check `%LOCALAPPDATA%\VoltWatch\logs\` for recent error messages.
4. If the token is invalid, rotate it from Settings → Devices → Rotate token and supply the new token to the agent.

### No alerts on a locked phone

In-app alerts only fire while the dashboard tab is open. On a locked phone, in-app alerts are not delivered.

Enable **Web Push**: Settings → Push notifications → Enable → grant permission. Then subscribe and run a test push to confirm delivery. With Web Push enabled, alerts arrive as OS notifications even on the lock screen.

### False HEARTBEAT_LOST alert (laptop was online)

Check the Windows power settings. If the laptop slept, the agent could not send heartbeats during sleep. Set **Sleep: Never** and **Hibernate: Never** in Power Options (or run the `powercfg` commands in [Section 9](#9-pre-travel-checklist)).

If the backend is on Render's free tier, it sleeps after 15 minutes of inactivity. Upgrade to the Starter tier ($7/month) to keep it always on.

### iPhone: login does not stick (session lost on next visit)

Safari on iOS applies aggressive ITP (Intelligent Tracking Prevention) to cookies from third-party origins. Make sure the dashboard and backend are on the same origin — i.e. the dashboard on Vercel is calling `/api/*` (which the `vercel.json` rewrite proxies to the backend), not calling the Render URL directly. This keeps the session cookie same-origin and exempt from ITP.

### MT5 not detected

The agent watches `terminal64.exe` and `terminal.exe`. If your MT5 installation uses a different executable name (rare), edit the process names in the tray menu or, from source, in `agent/voltwatch_agent/mt5.py`.

Also check that MT5 is not running as a different Windows user — process detection via `psutil` only sees processes owned by the same user.

### Windows sleep gaps in the history chart

The chart shows grey gap bands where readings were missing. This is expected if the laptop slept. To prevent it, set lid-close action and sleep timeouts to **Do nothing / Never** in Windows Power Options.

If sleep is unavoidable, the agent will send `resumed_from_sleep` when the laptop wakes and the queue will be flushed via `/batch` — the history is filled in but no live alert fires for the gap.

### Antivirus flags VoltWatchAgent.exe

This is a known false positive with PyInstaller one-file executables — they self-extract to a temp directory at startup, a technique also used by some malware.

To whitelist:
1. Open **Windows Security → Virus & threat protection → Exclusions → Add an exclusion → Folder**.
2. Add `%LOCALAPPDATA%\VoltWatch\`.

Alternatively, run the agent from source with `python -m voltwatch_agent.main` — no exe involved.

### Battery stuck at 80% and showing "plugged in, not charging"

This is Windows battery health management or a manufacturer charge-limit feature (common on Lenovo, Dell, Asus). The laptop reports `acConnected: true` but `charging: false`. VoltWatch will correctly show power state `PLUGGED_NOT_CHARGING` (not CHARGING) in the dashboard. No false alert will fire. You can lower the charge limit threshold in your laptop's battery management app.

### Clock drift warning in doctor mode

The agent compares its local clock to the server's `serverTime` response. A drift of more than a few seconds causes a warning. This usually means Windows time sync (W32tm) is not running.

```powershell
# Re-sync Windows clock:
w32tm /resync /force
```

Also check that `internet time sync` is enabled in Windows Date & Time settings.

### Web Push not arriving on iOS

Web Push on iOS requires iOS 16.4+ and the site to be **installed as a Home Screen app** (PWA). Open VoltWatch in Safari, tap the share icon, then "Add to Home Screen". Open the installed app, not the Safari tab, and re-enable push in Settings.

Also verify that iOS Settings → Notifications → VoltWatch has notifications allowed.

### Backend returns 403 on dashboard API calls

The CSRF middleware requires `X-Requested-With: voltwatch` on all non-GET requests from the dashboard. If you are calling the API from a custom script or Postman, add this header.

Also check that `APP_ORIGIN` in the backend environment matches the exact dashboard URL (no trailing slash, correct scheme).

</details>

---

## 15. Limitations

- **Cannot alert if the phone is locked and push is not enabled.** In-app alerts only fire while the dashboard tab is open. Enable Web Push and grant notification permission to receive alerts on the lock screen.
- **Cannot report while the laptop is asleep or off.** If Windows is in sleep or hibernate state, the Python process is suspended and cannot send heartbeats. Set sleep and hibernate to Never.
- **Cannot alert if the laptop loses power entirely before the agent can send a final event.** A hard power cut (no `WM_QUERYENDSESSION`) means the `system_shutdown` event may not be sent; HEARTBEAT_LOST will fire after the offline threshold instead.
- **Depends on the laptop's internet connection.** If both power and internet fail simultaneously, the agent queues readings locally, but no live alert reaches the dashboard until connectivity returns.
- **Single backend instance required.** Background jobs (offline watcher, critical repeat, rollup) run in the same process. Running multiple instances will fire duplicate alerts.
- **Single owner by design.** VoltWatch is a personal tool — there is no multi-user access control.
- **Agent only runs on Windows.** The tray, battery reading, and sleep/resume detection use Windows-specific APIs. The agent can run headless (`--no-tray`) on Linux for development, but battery readings will be unavailable.

---

## 16. Roadmap

The following items are confirmed as **not yet built**:

- [ ] Telegram notifier (the `Notifier` interface is ready; the implementation is not).
- [ ] Email alerts via Brevo (API key field exists in config; sending logic is not wired to the alert engine).
- [ ] Fingerprint check on device readings (detect fake heartbeats from a stolen token).
- [ ] "Sign out everywhere" — invalidate all active sessions from the dashboard.
- [ ] Windows Credential Manager as the default token store (currently optional; JSON file is the fallback).
- [ ] Full Credential Manager integration for the agent (tracked as SEC-05 in `docs/security-review.md`).

TODO: Confirm whether any of the above have been implemented since this README was written.

---

## 17. Contributing

VoltWatch is a personal project. If you find a bug or have a suggestion, open an issue on GitHub. For security issues, see [Reporting a vulnerability](#reporting-a-vulnerability) above.

If you want to add a new alert channel, see the **Adding a New Notifier** section in [`backend/README.md`](backend/README.md) — it takes about 10 lines of code.

Pull requests are welcome for bug fixes and well-scoped improvements. Please open an issue first for larger changes.

---

## 18. License

MIT — see [LICENSE](LICENSE).

---

## 19. Author

**ShimboJr**

- GitHub: [https://github.com/ShimboJr](https://github.com/ShimboJr)
- Portfolio: [https://shimbojr-portfolio.vercel.app/](https://shimbojr-portfolio.vercel.app/)
