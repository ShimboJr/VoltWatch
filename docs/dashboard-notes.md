# VoltWatch Dashboard — Developer Notes

## Architecture overview

```
dashboard/
  index.html               Single app shell, all pages rendered inside
  css/
    tokens.css             Design system: variables for all themes
    base.css               Reset, layout, skeleton, aria-live regions
    components.css         Cards, buttons, toasts, status banners, chips...
    pages.css              Per-page styles (login, live, gauge, runway...)
  js/
    app.js                 Entry point: boot, auth guard, routing, device switcher
    api.js                 Fetch wrapper with timeout, retry, 401 redirect
    store.js               Tiny pub/sub reactive store
    router.js              Hash router with guard and active-class sync
    poller.js              SSE → polling fallback with visibility awareness
    format.js              Pure formatting utilities (timeAgo, duration, etc.)
    sound.js               Web Audio synthesiser (alarm + chime)
    notify.js              Toast notifications + aria-live announcements
    components/
      ring-gauge.js        Animated SVG battery ring gauge
      sparkline.js         Inline SVG 60-minute history sparkline
    pages/
      login.js             Login form controller
      live.js              Live screen controller (main page)
```

---

## Data flow

```
Backend (SSE or poll)
      │
      ▼
  poller.js
      │   store.set('status', ...)
      │   store.set('alerts', ...)
      ▼
  store.js (pub/sub)
      │   subscribe('status', fn)
      ▼
  live.js
      │   _render(status)
      ├── RingGauge.update()
      ├── _renderChips()
      ├── _renderRunway()
      ├── _renderAlerts()     → critical takeover if level=critical
      ├── _renderDiagnosis()  → shown when stale/offline
      └── _loadSparkline()    → separate API call for 60-min history
```

---

## Component reference

### `RingGauge` (`js/components/ring-gauge.js`)

| Method | Description |
|--------|-------------|
| `new RingGauge(container)` | Renders SVG into `container` |
| `.update({ percent, acConnected, charging })` | Animates arc, updates colour and centre text |
| `.skeleton()` | Shows loading state |

Threshold tick marks are rendered at **15, 20, 30, 50%** using `<line>` elements at the corresponding polar angles. Colour logic:

| State | Colour |
|-------|--------|
| Charging | `--c-charging` (blue) |
| AC on, not charging | `--c-ok` (green) |
| On battery, > 30% | `--c-ok` (green) |
| On battery, ≤ 30% | `--c-warning` (amber) |
| On battery, ≤ 15% | `--c-critical` (red) |

---

### `Sparkline` (`js/components/sparkline.js`)

Renders a lightweight SVG (no Chart.js). Accepts:
- `readings`: array of `{ deviceTime, percent, acConnected }` (last 60 min)
- `events`: filtered subset where `event === 'ac_connected' | 'ac_disconnected'`

Event markers appear as dashed vertical lines with emoji labels (⚡ = plug in, ↓ = unplug).

Hover tooltip shows time + percent. No external dependencies.

---

## Store keys

| Key | Type | Description |
|-----|------|-------------|
| `user` | object | Logged-in user |
| `deviceId` | string | Active device ID |
| `devices` | array | All user devices |
| `status` | object | Enriched status (from `/status/:id`) |
| `alerts` | array | Active alerts (from `/alerts?state=active`) |
| `unreadAlerts` | number | Count for tab badge |
| `connection` | `'live'|'polling'|'offline'` | Connection state |
| `clockOffsetMs` | number | `serverTime - clientTime` in ms |
| `settings` | object | Theme, volume, etc. |
| `soundArmed` | boolean | Whether user has unlocked Web Audio |
| `criticalActive` | boolean | Whether takeover is showing |

---

## Poller strategy

1. **SSE** (`EventSource` on `/api/v1/stream`) — preferred. Server pushes `status` and `alert` events.
2. **Polling** — fallback after 3 consecutive SSE errors. Polls `/status/:id` + `/alerts` every 5s.
3. **Pause** — stops when `document.hidden`, resumes on `visibilitychange`.
4. **Backoff** — on poll failure: 1s → 2s → 4s … cap 30s.
5. **Browser offline** — adds `is-offline` to `body`, shows banner with last-seen time.

---

## Critical alert experience

1. A critical alert arrives via SSE or poll.
2. `_renderAlerts()` detects `level === 'critical'`.
3. `#critical-takeover` overlay is shown (full-screen red).
4. `sound.playAlarm()` starts looping alarm bursts (if armed).
5. Document title flashes between `🔴 CRITICAL X%` and `⚠ LOW BATTERY`.
6. Vibration pattern plays if `navigator.vibrate` is available.
7. User taps **Acknowledge** → `POST /alerts/:id/ack` → alert resolves → takeover auto-dismisses.
8. Takeover auto-dismisses when the alert is no longer in the active list.

### Alarm arming (autoplay policy)
Mobile browsers block audio until a user gesture. The `#arm-sound-prompt` bar appears persistently until the user taps it. `sound.arm()` creates and starts a silent AudioContext, unlocking it for future use.

---

## Themes

Three themes toggled via `data-theme` on `<html>`:

| Theme | Selector | Character |
|-------|----------|-----------|
| Dark (default) | `:root` | Dark navy surfaces |
| Light | `[data-theme="light"]` | Off-white surfaces |
| AMOLED | `[data-theme="amoled"]` | True black `#000` |

Theme is persisted in `localStorage('vw-theme')` and applied before any render.

---

## Accessibility

- `aria-live="polite"` on status banner, chips row, ring gauge centre text
- `aria-live="assertive"` on critical takeover, alarm, login error
- `aria-labelledby` on all `<section>` pages
- All interactive elements ≥ 44px touch target
- `:focus-visible` ring on all focusable elements
- `prefers-reduced-motion` disables all CSS animations
- `role="alertdialog"` on critical takeover with `aria-modal="true"`
- Status colour always paired with icon + text (never colour alone)

---

## Adding a new page

1. Add a `<section id="page-{name}" class="page">` in `index.html`
2. Add tab-bar and sidebar nav items with `data-route="#/{name}"`
3. Add `router.on('#/{name}', ...)` in `app.js`
4. Create `js/pages/{name}.js` with `initXxxPage()` function
5. Import and call it from `app.js`

---

## Prompt 07 additions — History, Timeline, Insights

### New files

| File | Purpose |
|------|---------|
| `css/pages2.css` | Summary tiles, bottom sheet, timeline, insight cards, heatmap, radial gauge |
| `js/pages/history.js` | History chart page |
| `js/pages/timeline.js` | Event timeline with infinite scroll |
| `js/pages/insights.js` | Insights dashboard |

### History page (`#/history`)

**Charts:** Created once with `new Chart()` and updated via `.data.datasets[n].data = ...` plus `.update()` — never re-created on range change. Paused when `document.hidden`.

| Control | Behaviour |
|---------|-----------|
| Range chips 1h/6h/24h/7d/30d | Fetches readings; saved in `localStorage` |
| Series toggles | `dataset.hidden` toggled — no re-render |
| Zoom | chartjs-plugin-zoom wheel + pinch; double-tap resets |
| Export CSV | Client-side Blob download |
| Copy summary | `navigator.clipboard.writeText` |

**Annotations:** threshold lines (15/20/30/50%), blue AC bands, red gap hatching, plug/unplug event markers.

**A11y:** `#history-chart-summary` (visually-hidden, `aria-live="polite"`) holds min/max/avg/cuts text.

### Timeline page (`#/timeline`)

Paginated via `GET /devices/:id/events?before=<ISO>&limit=40`. IntersectionObserver on `#timeline-sentinel` loads next page. Filter chips narrow event types. Live inserts prepend new events with CSS animation. Bottom sheet (`role="dialog"`) shows full detail; keyboard accessible (Enter/Space/Escape).

### Insights page (`#/insights`)

Six cards from `GET /devices/:id/insights?range=`. All visualisations are pure SVG/CSS — no Chart.js on this page. Heatmap uses `role="grid"` with text alternative. Weekly summary is generated client-side from API data.

---

## Prompt 08 additions — Alerts, Devices, Settings, Onboarding, Glance

### New files

| File | Size | Purpose |
|------|------|---------|
| `js/strings.js` | 8 KB | All user-facing UI strings in one place |
| `css/pages3.css` | 15 KB | Tabs, alert cards, device cards, wizard, settings rows, onboarding, glance |
| `js/pages/alerts.js` | 13 KB | Alerts inbox — Active/History tabs, swipe-to-ack, snooze, filters |
| `js/pages/devices.js` | 18 KB | Devices list, add-device 3-step wizard, rename/pause/rotate/delete |
| `js/pages/settings.js` | 32 KB | 8 grouped sections, auto-saving, threshold chips, change-password modal |
| `js/pages/onboarding.js` | 6 KB | 5-step checklist card, auto-checks from store, store subscriber |
| `js/pages/glance.js` | 5 KB | Fullscreen glance mode, Screen Wake Lock, 1s tick, tap/Esc to exit |

### strings.js

Single source of truth for all copy. Import `{ S }` and use `S.fieldName`. Add new strings here — no grep required.

### Alerts page (`#/alerts`)

- **Active tab**: renders from `store.get('alerts')`, re-renders on `store.subscribe('alerts')`.
- **History tab**: fetches `GET /alerts?state=all&limit=50` on first open.
- **Swipe right**: `touchstart`/`touchmove`/`touchend` translate the card; threshold > 80px triggers `alerts.acknowledge()`.
- **Snooze dropdown**: custom dropdown div positioned with `position:absolute` (no Bootstrap deps).
- **Test alert**: `POST /alerts/test` → triggers the same alarm path as a real alert.
- **Badge**: `#alerts-tab-count` + `.alert-badge` elements updated by `_updateBadge()`.
- **Alert channels panel**: static HTML — in-app always active; push shows status set by Prompt 09.

### Devices page (`#/devices`)

**Add-device wizard** (3-step bottom sheet):

| Step | Action |
|------|--------|
| 1 — Name | `POST /devices` → stores `{ _id, token }` in `_wizardDevice` |
| 2 — Token | Displays token; copy/download; `token` cleared from memory on Next |
| 3 — Wait | `setInterval` polls `GET /devices/:id` every 3 s; success when `lastSeenAt` is set |

Token is shown only once, then the DOM node is overwritten with `••••••••` and the JS variable is nulled.

**Per-device actions** use a reusable `_confirmDestructive()` modal that requires typing the device name for deletes.

**`_deviceCardHTML(d)`** reads `d.latestReading` for the snapshot grid.

### Settings page (`#/settings`)

Settings are built entirely in JS via `_buildSections()` (injected into `#settings-content`). No HTML to maintain.

Auto-save pattern:
```js
// Debounced save for sliders/text inputs
_onChangeDebounced('setting-heartbeat', v => _patchSettings({ heartbeatIntervalSec: parseInt(v) }));

// Immediate save for toggles
document.getElementById('setting-mt5-alert').addEventListener('change', e =>
  _patchSettings({ mt5AlertEnabled: e.target.checked }));
```

Feedback (`save-feedback` div) shows "Saved" / "Error" for 3 s then clears.

Timezone `<select>` is populated from `Intl.supportedValuesOf('timeZone')` (with a static fallback for older browsers).

### Onboarding (`js/pages/onboarding.js`)

Steps auto-check from live store data:

| Step | Check |
|------|-------|
| Create device | `store.get('devices').length > 0` |
| Install agent | any device has `agentVersion` set |
| First heartbeat | any device has `lastSeenAt` set |
| Test alarm | `localStorage['vw-alarm-tested'] === '1'` |
| Set thresholds | `localStorage['vw-thresholds-set'] === '1'` |

Dismissed with `localStorage['vw-onboard-dismissed'] = '1'`. Card reappears on next device until dismissed.

### Glance mode (`#/glance`)

- Background colour computed from `(pct, acConnected, charging)` → 6 distinct solid colours.
- `navigator.wakeLock.request('screen')` called on init; released on exit.
- `document.documentElement.requestFullscreen()` on init; `exitFullscreen()` on exit.
- 1-second `setInterval` tick updates the last-report counter.
- Exit: tap anywhere, press `Escape` or `q`, or `router.go('#/live')`.
- The `#page-glance` section uses `position:fixed` to overlay — `showPage()` is NOT called for this route.

### API additions (`api.js`)

```js
auth.changePassword(currentPw, newPw)
auth.signOutAll()
alerts.delete(id)
alerts.test()
devices.update(id, body)
devices.rotateToken(id)
settings.save(body)       // alias for PATCH /settings
settings.deleteHistory()  // DELETE /history
```

### Acceptance checklist

- [ ] Add-device wizard: name → token shown once → agent reports → success tick
- [ ] Rotate token invalidates old agent; new token shown once
- [ ] Delete device requires typing the device name; removes all data
- [ ] Swipe right on an alert card acknowledges it with animation
- [ ] Test alert fires sound + takeover; Ack stops it
- [ ] Settings auto-save; threshold chips add/remove; quiet-hours preview correct
- [ ] Glance mode: screen stays on (Wake Lock), readable at 2 m, tap exits
- [ ] Onboarding checklist auto-advances as steps complete; dismissable
