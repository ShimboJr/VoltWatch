# VoltWatch Push Notifications — Manual Test Guide

This guide covers verifying Web Push end-to-end on all supported platforms.

## Prerequisites

1. Backend running with valid VAPID keys (`node scripts/gen-vapid.js` and add to `.env`).
2. Dashboard deployed over **HTTPS** (required for service workers and push).
   - For local testing use `ngrok` or Chrome's `--unsafely-treat-insecure-origin-as-secure` flag.
3. Simulator running (`node tools/simulator/simulate.js --scenario power-cut --speed 60`).

---

## 1. Generate VAPID keys (first time only)

```sh
cd backend
node scripts/gen-vapid.js
# Copy output → backend/.env
```

Commit the **public key** only. The private key must stay in `.env` (never in git).

---

## 2. Android Chrome (primary test path)

| Step | Expected result |
|------|----------------|
| Open dashboard in Chrome for Android | Manifest prompt appears in address bar |
| Tap **⋮ → Add to Home Screen** or wait for install banner | App installs |
| Open installed VoltWatch from launcher | Displays in standalone mode (no browser chrome) |
| Go to **Settings → Push notifications → Enable push** | Chrome permission prompt appears |
| Tap **Allow** | Status pill turns green "Active (1)" |
| Tap **🔔 Send test push** | Notification appears within ~2 s |
| Notification: tap **✓ Acknowledge** action | Alert acknowledged; notification dismissed |
| Notification: tap **⏸ Snooze 10m** action | Alert snoozed; notification dismissed |
| Close the VoltWatch tab entirely | Tab is closed |
| Run simulator: `--scenario power-cut --speed 60` | Push notifications arrive at each threshold (50→30→20→15%) |
| At 15% (critical) | Notification has **requireInteraction** (persists until tapped) |
| Let critical repeat fire (per `criticalRepeatMin`) | Second push arrives with same tag (replaces old notification) |
| Acknowledge from notification | Repeat stops |
| Go to **Settings → Push → Registered browsers → Remove** | No more pushes from that browser |

---

## 3. iPhone / iPad (iOS 16.4+ required)

> Push is only available in installed PWAs on iOS. Safari must be used.

| Step | Expected result |
|------|----------------|
| Open dashboard URL in **Safari** | Page loads normally |
| Tap **Share (⬆) → Add to Home Screen → Add** | App icon appears on Home Screen |
| Open VoltWatch from Home Screen | Runs in standalone mode |
| Go to **Settings → Push notifications** | Status shows "Not installed" if opened in browser; or **Enable push** if opened from Home Screen |
| Tap **Enable push** | iOS permission dialog appears |
| Allow | Status pill turns green |
| Tap **Send test push** | Notification arrives on lock screen |
| Close app (swipe home) | App closed |
| Run simulator power-cut | Notifications arrive on lock screen / notification centre |
| Tap notification | VoltWatch opens to Alerts page |

**If "Not installed" shows:** Open the guide via **How to install →** button and follow the steps.

---

## 4. Desktop (Chrome / Edge)

| Step | Expected result |
|------|----------------|
| Visit dashboard | Install icon appears in address bar (Chromium) |
| Settings → Push → Enable | Permission prompt; grant it |
| Send test push | OS notification appears bottom-right (Windows) / top-right (macOS) |
| Close browser | Push still arrives (browser process runs in background) |

---

## 5. Expired subscription cleanup

```sh
# Manually mark a subscription as dead
mongosh voltwatch --eval 'db.pushsubscriptions.updateMany({}, { $set: { dead: true } })'

# Restart backend — dead subs are cleaned on boot:
npm start
# Expect log: "WebPush: dead subscriptions cleaned" with count
```

---

## 6. Common issues

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| "Web Push not configured" | VAPID keys missing | Run `gen-vapid.js`, add to `.env`, restart backend |
| No notification arrives | Browser permission denied | Open browser settings → Notifications → find site → Allow |
| iOS push not working | App opened in Safari (not installed PWA) | Add to Home Screen first |
| Test push returns `failed: 1` | Subscription expired | Remove in Settings, re-subscribe |
| Notification never repeats | `criticalRepeatMin: 0` | Set to ≥ 1 in Settings → Battery alerts |
| Badge count not updating | Browser doesn't support `setAppBadge` | Normal — feature is progressive enhancement |

---

## 7. Verifying no push after unsubscribe

1. Settings → Push → Remove the subscription.
2. Run simulator.
3. No push arrives (in-app alert still fires while tab is open).

---

## 8. Quiet hours override test

1. Set quiet hours to a window that includes the current time.
2. Run simulator with `--scenario power-cut`.
3. **High/medium alerts → no push.** Critical (≤15%) → push arrives regardless.
