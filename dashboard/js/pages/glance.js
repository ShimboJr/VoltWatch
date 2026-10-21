/**
 * glance.js — Fullscreen glance mode page controller.
 *
 * Route: #/glance
 * Giant battery % on a solid colour background.
 * Screen Wake Lock, browser chrome hidden, tick counter.
 * Tap anywhere to exit.
 */

import { store }   from '../store.js';
import { router }  from '../router.js';
import { formatDuration } from '../format.js';
import { S }       from '../strings.js';

// ── State ─────────────────────────────────────────────────────

let _wakeLock   = null;
let _ticker     = null;
let _unsub      = null;
let _startTime  = Date.now();

// ── Colour map ────────────────────────────────────────────────

function _bgColour(pct, ac, charging) {
  if (charging)    return '#1d4ed8';   // blue charging
  if (ac)          return '#15803d';   // green plugged
  if (pct <= 15)   return '#991b1b';   // critical red
  if (pct <= 30)   return '#92400e';   // warning amber-dark
  return '#166534';                    // safe green
}

// ── Init ──────────────────────────────────────────────────────

export function initGlancePage() {
  const page = document.getElementById('page-glance');
  if (!page) return;

  page.classList.add('active');

  // Attempt fullscreen
  document.documentElement.requestFullscreen?.().catch(() => {});

  // Wake lock
  _requestWakeLock();

  // Tap to exit
  page.addEventListener('click', exitGlance, { once: true });
  document.addEventListener('keydown', _onKey);

  // Render immediately and subscribe
  _render(store.get('status'));
  _unsub = store.subscribe('status', _render);

  // 1-second tick for last-report counter
  _ticker = setInterval(_tick, 1000);
  _startTime = Date.now();
}

export function exitGlance() {
  const page = document.getElementById('page-glance');
  if (!page) return;
  page.classList.remove('active');
  page.removeEventListener('click', exitGlance);
  document.removeEventListener('keydown', _onKey);

  if (_unsub) { _unsub(); _unsub = null; }
  if (_ticker) { clearInterval(_ticker); _ticker = null; }
  _releaseWakeLock();

  document.exitFullscreen?.().catch(() => {});
  router.go('#/live');
}

function _onKey(e) {
  if (e.key === 'Escape' || e.key === 'q') exitGlance();
}

// ── Render ────────────────────────────────────────────────────

function _render(status) {
  const page = document.getElementById('page-glance');
  if (!page || !page.classList.contains('active')) return;

  const r       = status?.latestReading || {};
  const pct     = r.percent != null ? Math.round(r.percent) : null;
  const ac      = r.acConnected ?? true;
  const charging = r.charging   ?? false;
  // The backend never emits 'online'; healthy states are 'ok', 'low_battery',
  // 'critical_battery'. Treat the device as online unless it's explicitly
  // marked offline/stale/never-connected (matching the logic in live.js).
  const online   = status != null &&
                   status.deviceStatus !== 'offline' &&
                   status.deviceStatus !== 'stale' &&
                   status.deviceStatus !== 'planned_stop' &&
                   status.deviceStatus !== 'never_connected';

  const bg = pct != null
    ? _bgColour(pct, ac, charging)
    : '#374151'; // grey for no data / offline

  page.style.background = bg;

  const pctEl    = document.getElementById('glance-pct');
  const iconEl   = document.getElementById('glance-icon');
  const stateEl  = document.getElementById('glance-state');
  const reportEl = document.getElementById('glance-last-report');
  const timerEl  = document.getElementById('glance-offline-timer');

  if (pctEl) {
    pctEl.textContent = pct != null ? `${pct}%` : (online ? '—' : S.glanceOffline);
  }

  if (iconEl) {
    iconEl.textContent = charging ? '⚡' : ac ? '🔌' : '🔋';
  }

  if (stateEl) {
    if (!online) {
      stateEl.textContent = 'Offline';
    } else if (charging) {
      stateEl.textContent = 'Charging';
    } else if (ac) {
      stateEl.textContent = 'Plugged in';
    } else {
      stateEl.textContent = 'On battery';
    }
  }

  if (timerEl) {
    timerEl.style.display = online ? 'none' : '';
  }

  // Update last-report text
  _tick();
}

function _tick() {
  const status   = store.get('status');
  const lastSeen = status?.lastSeenAt;
  const reportEl = document.getElementById('glance-last-report');
  const timerEl  = document.getElementById('glance-offline-timer');

  if (reportEl && lastSeen) {
    const secs = Math.round((Date.now() - new Date(lastSeen).getTime()) / 1000);
    reportEl.textContent = `${S.glanceLastReport}: ${formatDuration(secs)} ago`;
  }

  if (timerEl) {
    const silentSec = status?.silentForSec;
    if (silentSec != null) {
      const elapsed = silentSec + Math.round((Date.now() - _startTime) / 1000);
      timerEl.textContent = `${S.glanceSilentFor} ${formatDuration(elapsed)}`;
    }
  }
}

// ── Wake lock ─────────────────────────────────────────────────

async function _requestWakeLock() {
  try {
    _wakeLock = await navigator.wakeLock?.request('screen');
    _wakeLock?.addEventListener('release', () => { _wakeLock = null; });
  } catch { /* not supported or denied */ }
}

function _releaseWakeLock() {
  _wakeLock?.release().catch(() => {});
  _wakeLock = null;
}
