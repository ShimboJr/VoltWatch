/**
 * poller.js — Visibility-aware live data poller.
 *
 * Strategy:
 *  1. Try SSE (/api/v1/stream) first.
 *  2. On SSE failure, fall back to polling every 5s while visible.
 *  3. Pause when page is hidden; resume immediately on visibilitychange.
 *  4. Exponential backoff on failures (1s → 2s → 4s … max 30s).
 *  5. Expose connection state: 'live' | 'polling' | 'offline'
 *     to the store.
 *
 * Usage:
 *   poller.start(deviceId, onData)
 *   poller.stop()
 *   poller.refresh()   — immediate refresh
 */

import { store } from './store.js';
import { status, alerts, streamUrl } from './api.js';

const POLL_INTERVAL_MS   = 5_000;
const BACKOFF_MAX_MS     = 30_000;
const SSE_RETRY_DELAY_MS = 3_000;

let _deviceId    = null;
let _onData      = null;
let _sse         = null;
let _pollTimer   = null;
let _backoff     = 1000;
let _mode        = 'offline'; // 'live' | 'polling' | 'offline'
let _stopped     = false;
let _failCount   = 0;
const MAX_FAILS  = 3;

function _setMode(mode) {
  if (_mode === mode) return;
  _mode = mode;
  store.set('connection', mode);
  _updatePill(mode);
}

function _updatePill(mode) {
  const pill = document.getElementById('connection-pill');
  if (!pill) return;
  pill.setAttribute('data-state', mode);
  pill.querySelector('.conn-text').textContent =
    mode === 'live' ? 'Live' : mode === 'polling' ? 'Polling' : 'Offline';
}

// ── SSE ───────────────────────────────────────────────────────

function _startSSE() {
  if (_sse) { _sse.close(); _sse = null; }

  const url = streamUrl(_deviceId);
  try {
    _sse = new EventSource(url, { withCredentials: true });
  } catch {
    _fallbackToPoll();
    return;
  }

  _sse.addEventListener('open', () => {
    _setMode('live');
    _backoff = 1000;
    _failCount = 0;
  });

  _sse.addEventListener('status', (e) => {
    try {
      const data = JSON.parse(e.data);
      _handleData(data);
    } catch (err) {
      console.warn('[poller] SSE parse error', err);
    }
  });

  _sse.addEventListener('alert', (e) => {
    try {
      const data = JSON.parse(e.data);
      _handleAlert(data);
    } catch { /* ignore */ }
  });

  _sse.addEventListener('error', () => {
    _failCount++;
    if (_failCount >= MAX_FAILS) {
      _sse.close(); _sse = null;
      _fallbackToPoll();
    } else {
      // SSE will auto-reconnect — just reflect degraded state
      _setMode('polling');
    }
  });
}

function _fallbackToPoll() {
  if (_stopped) return;
  _setMode('polling');
  _schedulePoll(0);
}

// ── Polling ───────────────────────────────────────────────────

function _schedulePoll(delay = POLL_INTERVAL_MS) {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  if (_stopped) return;
  _pollTimer = setTimeout(_doPoll, delay);
}

async function _doPoll() {
  if (_stopped || document.hidden || !_deviceId) return;
  try {
    const [statusData, alertsData] = await Promise.all([
      status.get(_deviceId),
      alerts.list({ state: 'active', limit: 20 }),
    ]);
    _handleData({ status: statusData, alerts: alertsData?.alerts ?? [] });
    _backoff = 1000;
    _failCount = 0;
    _setMode('polling');
    _schedulePoll(POLL_INTERVAL_MS);
  } catch {
    _failCount++;
    _setMode('offline');
    _backoff = Math.min(_backoff * 2, BACKOFF_MAX_MS);
    _schedulePoll(_backoff);
  }
}

// ── Data handlers ─────────────────────────────────────────────

function _handleData({ status: s, alerts: a }) {
  if (s) {
    store.set('status', s);
    // Compute server clock offset
    if (s.serverTime) {
      store.set('clockOffsetMs', new Date(s.serverTime).getTime() - Date.now());
    }
  }
  if (a !== undefined) {
    store.set('alerts', a);
    const unread = a.filter(al => !al.acknowledgedAt).length;
    store.set('unreadAlerts', unread);
  }
  if (_onData) _onData({ status: s, alerts: a });
}

function _handleAlert(alertData) {
  const current = store.get('alerts') || [];
  // Upsert
  const idx = current.findIndex(a => a._id === alertData._id);
  const updated = idx >= 0
    ? current.map((a, i) => i === idx ? alertData : a)
    : [alertData, ...current];
  store.set('alerts', updated.filter(a => !a.acknowledgedAt || a.active));
  store.set('unreadAlerts', updated.filter(a => !a.acknowledgedAt).length);
}

// ── Visibility handling ───────────────────────────────────────

document.addEventListener('visibilitychange', () => {
  if (_stopped) return;
  if (!document.hidden) {
    // Immediately refresh on tab focus
    if (_mode === 'live' && !_sse) _startSSE();
    else _doPoll();
  } else {
    // Pause polling when hidden
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  }
});

// ── Offline detection (browser itself) ───────────────────────

window.addEventListener('online', () => {
  document.body.classList.remove('is-offline');
  if (_stopped) return;
  if (_sse === null) _startSSE();
  else _doPoll();
});

window.addEventListener('offline', () => {
  document.body.classList.add('is-offline');
  const banner = document.getElementById('offline-banner');
  if (banner) {
    const t = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    banner.textContent = `⚠ You're offline. Showing data from ${t}.`;
  }
  _setMode('offline');
});

// ── Public API ────────────────────────────────────────────────

export const poller = {
  start(deviceId, onData) {
    _deviceId = deviceId;
    _onData   = onData;
    _stopped  = false;
    _failCount = 0;

    // Fire an immediate poll so the live page renders data right away
    // regardless of how long SSE takes to establish on the server.
    _doPoll();

    if (typeof EventSource !== 'undefined') {
      _startSSE();
    } else {
      _fallbackToPoll();
    }
    return this;
  },

  stop() {
    _stopped = true;
    if (_sse) { _sse.close(); _sse = null; }
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    _setMode('offline');
  },

  refresh() {
    if (_mode === 'live' && _sse) return; // SSE handles updates
    _schedulePoll(0);
  },

  mode() { return _mode; },
};
