# VoltWatch Runbook

> **Audience:** You or a trusted person deploying VoltWatch from scratch.
> **Goal:** A stranger following only this document can get the whole system running.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [MongoDB Atlas](#2-mongodb-atlas)
3. [Backend on Render (recommended)](#3-backend-on-render)
4. [Dashboard on Vercel](#4-dashboard-on-vercel)
5. [Domain and HTTPS](#5-domain-and-https)
6. [Windows agent](#6-windows-agent)
7. [Environment variables reference](#7-environment-variables-reference)
8. [First-run checklist](#8-first-run-checklist)
9. [Ongoing operations](#9-ongoing-operations)

---

## 1. Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | https://nodejs.org |
| Git | any | https://git-scm.com |
| A GitHub account | — | https://github.com |
| A Render account | — | https://render.com |
| A Vercel account | — | https://vercel.com |
| A MongoDB Atlas account | — | https://cloud.mongodb.com |

---

## 2. MongoDB Atlas

### 2a. Create cluster

1. Sign in → **Create a New Project** → name it `voltwatch`.
2. **Build a Database** → **M0 Free** (or M2 $9/month for dedicated IOPS).
3. **Cloud provider:** AWS or GCP, closest region to your backend host.
4. Cluster name: `Cluster0`.

### 2b. Database user (least privilege)

1. **Database Access** → **Add New Database User**.
2. Authentication: **Password**.
3. Username: `voltwatch_app`; generate a strong password (store it now).
4. **Database User Privileges** → **Built-in Role**: `readWrite` on database `voltwatch` only.
   - Expand "Restrict Access to Specific Clusters" if you want extra isolation.
5. Click **Add User**.

### 2c. Network access

1. **Network Access** → **Add IP Address**.
2. For Render: Render does not provide a static outbound IP on the free/starter tier.
   - Add `0.0.0.0/0` (Allow from Anywhere) **and** enable Atlas's built-in auth as the defence layer.
   - Or upgrade to Render's **Static Outbound IP** add-on ($3/month) and use a specific CIDR.

### 2d. Connection string

1. **Clusters** → **Connect** → **Drivers** → Node.js 5.x+.
2. Copy the SRV connection string — it looks like:
   ```
   mongodb+srv://voltwatch_app:<password>@cluster0.xxxxx.mongodb.net/voltwatch?retryWrites=true&w=majority
   ```
3. Replace `<password>` with the password from step 2b.
4. Store this as `MONGODB_URI` in your secrets manager or Render's environment variables.

### 2e. Confirm TTL indexes

After the first document is written, verify TTL indexes exist:

```js
// In Atlas shell or mongosh
use voltwatch
db.readings.getIndexes()     // should have { expireAfterSeconds: <N> } on deviceTime
db.alerts.getIndexes()       // similar
```

If missing (first run), the server creates them automatically via Mongoose schema options.

---

## 3. Backend on Render (recommended)

### Why Render?

| Platform | Free tier | Paid always-on | Price | Notes |
|----------|-----------|---------------|-------|-------|
| **Render** | Spins down after 15 min inactivity | ✅ Starter ($7/mo) | **$7/mo** | Simple GitHub deploy, no CLI needed, built-in health checks |
| Railway | $5 credit/mo, then pay-per-use | ✅ (no sleep on paid) | ~$5-10/mo | Good DX, Dockerfile support, but credit model can surprise |
| Fly.io | 3 shared VMs free but can sleep | ✅ ($1.94/mo/machine) | ~$2-5/mo | Most flexible but requires `flyctl` CLI, more ops overhead |

**Recommendation: Render Starter ($7/month).** VoltWatch needs an always-on backend — a sleeping instance will miss agent heartbeats and fire false `HEARTBEAT_LOST` alerts. Render Starter is the cheapest fully-managed option with zero cold starts, GitHub auto-deploy, and a simple UI.

### 3a. Deploy from GitHub

1. **New Web Service** → connect your GitHub repo.
2. **Root directory:** `backend`
3. **Runtime:** **Docker** (uses the `Dockerfile` at `backend/Dockerfile`).
4. **Region:** closest to your MongoDB Atlas cluster.
5. **Instance type:** `Starter` ($7/month).
6. **Health check path:** `/api/v1/health`

### 3b. Environment variables (Render → Environment tab)

| Variable | How to generate |
|----------|----------------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `MONGODB_URI` | From Atlas section 2d |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `OWNER_EMAIL` | Your email address |
| `OWNER_PASSWORD_HASH` | `cd backend && npm run hash-password yourpassword` |
| `APP_ORIGIN` | `https://your-voltwatch.vercel.app` (fill after step 4) |
| `RETENTION_DAYS` | `30` |
| `VAPID_PUBLIC_KEY` | `npm run gen-vapid` (see Prompt 09) |
| `VAPID_PRIVATE_KEY` | Same command — keep secret |
| `LOG_LEVEL` | `warn` |
| `DEAD_MAN_SEC` | `600` (10 min; adjust to taste) |

> **Never commit secrets to git.** Use Render's secret environment variable UI.

### 3c. Graceful shutdown

The `Dockerfile` sets `STOPSIGNAL SIGTERM` and `server.js` handles `SIGTERM` by closing the HTTP server and disconnecting MongoDB before exiting. Render sends `SIGTERM` 30 seconds before force-killing — this is sufficient.

### 3d. Single-instance note

VoltWatch runs all background jobs (offline watcher, critical repeat, rollup) in the same process. **Do not run multiple instances** — they will fire duplicate alerts. Use Render's **"Instances: 1"** setting (default for Starter).

### 3e. Verify deployment

```bash
curl https://voltwatch-69ie.onrender.com/api/v1/health
# → {"ok":true,"db":"connected","lastReadingAt":null,...}
```

---

## 4. Dashboard on Vercel

### 4a. Deploy

1. **New Project** → import the same GitHub repo.
2. **Framework preset:** Other (it's a static site).
3. **Root directory:** `dashboard`
4. **Build command:** *(leave empty — no build step)*
5. **Output directory:** `.` (current directory)
6. **Install command:** *(leave empty)*

### 4b. vercel.json (already committed)

The `dashboard/vercel.json` handles:
- `/api/(.*)` → rewrite to the Render backend URL (update `destination` before deploying).
- SPA fallback → `index.html`.
- `sw.js` served with `no-cache` + `Service-Worker-Allowed: /`.
- Static assets with `immutable` caching.
- Security headers.

**Update the rewrite destination:**
```json
{ "source": "/api/(.*)", "destination": "https://voltwatch-69ie.onrender.com/api/$1" }
```

### 4c. Content Security Policy

Add to `vercel.json` headers for `/(.*)`  (the default rule already sets security headers; add CSP):

```json
{
  "key": "Content-Security-Policy",
  "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://voltwatch-69ie.onrender.com; img-src 'self' data:; frame-ancestors 'none'; upgrade-insecure-requests"
}
```

Adjust `connect-src` to your actual backend URL.

### 4d. Domain (optional)

Vercel assigns `your-voltwatch.vercel.app` automatically. To use a custom domain:
- **Project → Settings → Domains → Add** your domain.
- Point your DNS `CNAME` to `cname.vercel-dns.com`.
- Vercel provisions the TLS certificate automatically.

---

## 5. Domain and HTTPS

- The agent's `--api` URL should point to:
  - **Option A (recommended):** The Vercel dashboard URL `https://your-voltwatch.vercel.app/api/v1` — Vercel proxies to the backend, so you only expose one domain.
  - **Option B:** The Render backend directly `https://voltwatch-69ie.onrender.com/api/v1`.
- HTTPS is mandatory for the service worker and Web Push (PWA prompt 09).
- Never run the backend on plain HTTP in production.

---

## 6. Windows agent

Full instructions are in `agent/README.md`. Quick steps:

```powershell
cd agent
pip install -r requirements.txt

# First run — supply API URL and token to skip the GUI pairing dialog:
python voltwatch_agent.py --api https://your-voltwatch.vercel.app/api/v1 --token YOUR_DEVICE_TOKEN

# Equivalent package form (same result):
python -m voltwatch_agent.main --api https://your-voltwatch.vercel.app/api/v1 --token YOUR_DEVICE_TOKEN
```

> **Note:** `--api` and `--token` are only needed the **first time** to bootstrap the saved config.
> On subsequent runs, simply run `python voltwatch_agent.py` (or launch `VoltWatchAgent.exe`).
> The credentials are saved to `%LOCALAPPDATA%\VoltWatch\config.json` and Windows Credential Manager.

The device token is shown once when you create a device in Settings → Devices.

**Autostart:** Use the system-tray menu → **Start with Windows** to toggle autostart (no admin required).

---

## 7. Environment variables reference

```
# Required
NODE_ENV=production
PORT=3001
MONGODB_URI=...
JWT_SECRET=...              # 48+ random bytes, base64url
OWNER_EMAIL=...
OWNER_PASSWORD_HASH=...     # argon2id hash

# Application
APP_ORIGIN=...              # Vercel dashboard URL (no trailing slash)
RETENTION_DAYS=30

# Web Push (optional, Prompt 09)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

# Monitoring
LOG_LEVEL=warn
DEAD_MAN_SEC=600            # seconds before /health warns no readings seen
```

---

## 8. First-run checklist

- [ ] Atlas cluster created, `voltwatch_app` user exists, connection string tested
- [ ] Render service deployed, health check green
- [ ] `OWNER_EMAIL` and `OWNER_PASSWORD_HASH` set in Render; first login succeeds
- [ ] Vercel dashboard deployed, rewrite points to Render backend
- [ ] HTTPS works on both services
- [ ] Create first device in Settings → Devices; note the token
- [ ] Start agent on the trading laptop with the device token
- [ ] First heartbeat appears on the Live screen within 60 seconds
- [ ] Test alarm: Settings → Alerts → "Test alert" → sound and takeover appear
- [ ] (Optional) Enable push notifications in Settings → Push notifications

---

## 9. Ongoing operations

### Rotate device token

Settings → Devices → select device → Rotate token → copy new token → update agent `--token` argument.

### Backup

MongoDB Atlas M0/M2 includes daily automated snapshots. For the free tier, enable **Continuous Cloud Backup** under Cluster → Backup.

### Updating

```bash
git pull
# Render: auto-deploys on push to main if GitHub integration is connected
# Vercel: same
```

### Emergency: backend down

If the backend itself is unreachable (check `APP_ORIGIN/api/v1/health`):
1. Check Render dashboard for error logs.
2. Check MongoDB Atlas Network Access — your Render IP may have changed.
3. Redeploy via Render dashboard → **Manual Deploy**.

### Log access

Render: Dashboard → Service → Logs (real-time streaming).
