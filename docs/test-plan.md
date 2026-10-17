# VoltWatch End-to-End Test Plan

**Version:** 1.0 | **Date:** 2026-10-17

> **How to use:** For each row, run the exact steps described and check the expected result. Mark P (pass) or F (fail) in the Result column. Failures should include a brief note.

| # | Scenario | Steps | Expected alert(s) | Expected dashboard state | Result | Notes |
|---|----------|-------|-------------------|--------------------------|--------|-------|
| **T01** | Charger unplugged | 1. Laptop on AC, agent running, dashboard on Live. 2. Physically unplug charger cable. | None immediately (below threshold) | AC indicator turns from ⚡ to 🔋 within 60 s | | |
| **T02** | Charger re-plugged | 1. After T01. 2. Plug charger back in. | None | AC indicator returns to ⚡ within 60 s | | |
| **T03** | Low-battery threshold — 50% | 1. Start simulator: `--scenario power-cut --speed 120`. | `LOW_BATTERY` at 50% | Alert card in Alerts inbox; badge count increases | | |
| **T04** | Low-battery threshold — 30% | 2. (Simulator continuing from T03) | `LOW_BATTERY` at 30% | Second alert card; ring gauge shows 30%, yellow | | |
| **T05** | Low-battery threshold — 20% | 3. (Simulator continuing) | `LOW_BATTERY` at 20% | Third alert; gauge orange | | |
| **T06** | Critical level — 15% | 4. (Simulator continuing to 15%) | `CRITICAL_BATTERY` at 15% | Red takeover screen; alarm sound; push notification if enabled | | |
| **T07** | Critical alert repeats | 5. Do not acknowledge T06 alert. Wait `criticalRepeatMin` (default 5 min). | Second `CRITICAL_BATTERY` push or in-app repeat | Alert count increments or existing card updates | | |
| **T08** | Acknowledge stops repeat | 6. Tap "Acknowledge" on the critical alert (in-app or from push notification). | No further repeats | Alert marked Acknowledged; takeover dismissed; repeat job stops | | |
| **T09** | Fast drain (large jump) | 1. `--scenario fast-drain --speed 120`. Battery drops 52% → 28% in one reading. | `LOW_BATTERY` (possibly at 30% threshold crossing mid-jump) | History chart shows steep drop; gap-detection logic notes the rapid change | | |
| **T10** | Kill agent process | 1. Agent running normally. 2. `taskkill /F /IM python.exe` or close terminal. | `HEARTBEAT_LOST` after `offlineThresholdSec` (default 3 min) | Device goes grey "Offline"; push if enabled; no further readings | | |
| **T11** | Planned agent stop from tray | 1. Right-click tray icon → Stop. | No alert (agent sends `agent_stopping_planned` event before exit) | Event logged in Timeline; no `HEARTBEAT_LOST` for 10 minutes | | |
| **T12** | Wi-Fi disconnected (10 min) | 1. Disable Wi-Fi on laptop. Wait 10 min. | `HEARTBEAT_LOST` after offline threshold | Device offline; when Wi-Fi re-enables, device comes back online, `HEARTBEAT_LOST` auto-acknowledged | | |
| **T13** | Wi-Fi reconnects | 2. Re-enable Wi-Fi. Agent resumes heartbeats. | No new alert | Device goes green; Live screen updates; "Agent reconnected" event in Timeline | | |
| **T14** | Lid close (sleep) | 1. Lid close action = **Do nothing** in Windows settings. 2. Close lid. | No alert (heartbeats continue) | Readings continue; no gap in History chart | | |
| **T15** | Lid close (sleep enabled) | 1. Lid close action = **Sleep**. 2. Close lid for 2 min. 3. Open lid. | `HEARTBEAT_LOST` (if sleep > threshold) | Gap in History chart; `resumed_from_sleep` event logged on resume | | |
| **T16** | Laptop shutdown | 1. Agent running. 2. `shutdown /s /t 0`. | No `HEARTBEAT_LOST` immediately (agent sends `system_shutdown` before process ends) | `system_shutdown` event in Timeline; after threshold, device shown offline | | |
| **T17** | Laptop restart | 2. After restart, agent starts (manually or autostart). | No alert (agent sends `agent_started` event) | Device comes back online; `agent_started` event in Timeline | | |
| **T18** | MT5 closed on battery | 1. MT5 open, battery not charging. 2. Close MT5. | `MT5_CLOSED_ON_BATTERY` alert (if mt5AlertEnabled) after `mt5DebounceSec` | Alert card with MT5 icon; push if enabled | | |
| **T19** | MT5 reopened | 3. Reopen MT5. | No new alert; existing MT5 alert auto-acknowledged | Dashboard shows MT5 running indicator | | |
| **T20** | Phone offline then online | 1. Enable airplane mode on phone (dashboard tab open). 2. Wait 30 s. 3. Disable airplane mode. | None (network, not power event) | Offline banner appears; when back online, banner disappears; Live auto-refreshes | | |
| **T21** | Two phones logged in | 1. Open dashboard on Phone A and Phone B. 2. Trigger a critical alert (simulator). | One `CRITICAL_BATTERY` alert | Both phones show takeover; both receive push (if subscribed); ACK on one removes alert on both (within next poll) | | |
| **T22** | Rotate device token | 1. Settings → Devices → Rotate token. 2. Copy new token. 3. Note old agent is still running. | None | Old agent gets 401, stops sending (logs error). Update agent with new token → readings resume | | |
| **T23** | Dashboard while backend restarts | 1. Navigate to Live screen. 2. Restart Render service (manual deploy). 3. Observe dashboard during restart (~30 s). | None | Offline banner or "connecting…" indicator; when backend returns, dashboard reconnects and updates without page reload | | |
| **T24** | Clock skew on laptop | 1. Set laptop clock 10 min in the future. 2. Send readings. | None (readings should be rejected if outside skew window) | Backend logs `CLOCK_SKEW` rejection; no readings stored with future timestamps; Live screen shows last known reading | | |
| **T25** | Push notification — test | 1. Settings → Push → Enable → grant permission. 2. Tap "Send test push". | None (test, not an alert) | OS notification appears on phone within ~5 s; tapping it opens VoltWatch at Alerts screen | | |
| **T26** | Push on locked phone — power-cut | 1. Phone locked. 2. Simulator `--scenario power-cut --speed 60`. | Push at each threshold (50%, 30%, 20%, 15% critical) | Notifications on lock screen; critical has "Acknowledge" action button | | |
| **T27** | ACK from notification | 3. Tap "Acknowledge" on critical notification. | Alert acknowledged | Dashboard shows Acknowledged; push repeats stop | | |
| **T28** | PWA offline open | 1. Load VoltWatch while online. 2. Kill internet. 3. Close and reopen from Home Screen icon. | None | App opens from cache; "Showing saved data from hh:mm" banner visible; Live screen shows last known state | | |
| **T29** | PWA update | 1. Deploy a new version. 2. Open installed PWA. | None | "New version available, tap to refresh" toast appears within 60 s | | |
| **T30** | Remove push subscription | 1. Settings → Push → Registered browsers → Remove. 2. Trigger alert. | Alert fires in-app only | No push notification on the removed browser | | |

---

## Pre-test setup

```
1. Backend running and healthy: GET /api/v1/health → {"ok":true}
2. Agent running on trading laptop: Live screen shows green
3. At least one active device with thresholds: 50, 30, 20, 15
4. Phone with VoltWatch dashboard open and push enabled (for T20–T30)
5. Simulator available: cd tools/simulator && node simulate.js --help
```

## Simulator commands used in tests

```sh
# T03–T08: Power cut scenario at 120x speed
node simulate.js --api http://localhost:3001/api/v1 --token TOKEN --scenario power-cut --speed 120

# T09: Fast drain
node simulate.js --api http://localhost:3001/api/v1 --token TOKEN --scenario fast-drain --speed 120

# CI assertion
node simulate.js --api http://localhost:3001/api/v1 --token TOKEN --scenario fast-drain --speed 120 --assert
```
