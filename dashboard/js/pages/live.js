/**
 * live.js — Live screen controller (the most important screen).
 *
 * Manages:
 *  - Hero ring gauge
 *  - Status banner
 *  - Chips row (AC, MT5, Agent online)
 *  - Runway card (trend, windows estimate, predicted shutdown)
 *  - 60-minute sparkline
 *  - Active alerts strip with ack/snooze
 *  - Offline diagnosis card
 *  - Critical alert takeover
 *  - Quick actions (wake lock, glance mode, test alarm)
 *  - Pull-to-refresh
 *  - Time-ago ticking
 */

import { store }    from '../store.js';
import { api, alerts as alertsApi } from '../api.js';
import { router }   from '../router.js';
import { notify }   from '../notify.js';
import { sound }    from '../sound.js';
import { RingGauge }  from '../components/ring-gauge.js';
import { Sparkline }  from '../components/sparkline.js';
import {
  timeAgo, startTimeTicker, formatDuration, shutdownTime,
  powerState, statusBanner, formatDrainInfo, gaugeColour,
} from '../format.js';

let _gauge     = null;
let _sparkline = null;
let _tickerCleanup = null;
let _wakeLock  = null;
let _glanceActive = false;
let _takeoverActive = false;
let _prevCritical = false;
let _titleInterval = null;

// ─── Init ─────────────────────────────────────────────────────

export function initLivePage() {
  _buildGauge();
  _buildSparkline();
  _wireQuickActions();
  _wirePullToRefresh();
  _wireArmSound();
  _wireGlanceMode();
  _wireCriticalTakeover();

  // Re-render on store updates
  store.subscribe('status', _render);
  store.subscribe('alerts', _renderAlerts);

  // Tick time-ago every second
  _tickerCleanup = startTimeTicker(_tickTimeAgo);
}

export function destroyLivePage() {
  if (_tickerCleanup) { _tickerCleanup(); _tickerCleanup = null; }
  _releaseWakeLock();
}

// ─── Gauge ────────────────────────────────────────────────────

function _buildGauge() {
  const wrap = document.getElementById('gauge-wrap');
  if (!wrap) return;
  _gauge = new RingGauge(wrap);
  _gauge.skeleton();
}

// ─── Sparkline ────────────────────────────────────────────────

function _buildSparkline() {
  const wrap = document.getElementById('sparkline-wrap');
  if (!wrap) return;
  _sparkline = new Sparkline(wrap);
}

// ─── Main render ──────────────────────────────────────────────

function _render(status) {
  if (!status) return;

  const r = status.latestReading || {};
  const pct     = Math.round(r.percent ?? 0);
  const ac      = r.acConnected ?? true;
  const charging = r.charging   ?? false;
  const mt5     = r.mt5Running  ?? false;
  const lastSeen = status.lastSeenAt;

  // 1 — Ring gauge
  if (_gauge) _gauge.update({ percent: pct, acConnected: ac, charging });

  // 2 — Status banner
  const banner = statusBanner(status);
  const bannerEl = document.getElementById('status-banner');
  if (bannerEl) {
    bannerEl.textContent = banner.text;
    bannerEl.setAttribute('data-state', banner.state);
  }

  // 3 — Chips
  _renderChips({ ac, charging, mt5, lastSeen, agentVersion: r.agentVersion });

  // 4 — Runway card
  _renderRunway(status);

  // 5 — Sparkline (fetched separately)
  _loadSparkline(status.deviceId);

  // 6 — Diagnosis card
  _renderDiagnosis(status);

  // 7 — Glance mode sync
  if (_glanceActive) _syncGlance(pct, ac, charging);

  // 8 — Document title
  document.title = `${pct}% — VoltWatch`;
}

// ─── Chips ───────────────────────────────────────────────────

function _renderChips({ ac, charging, mt5, lastSeen, agentVersion }) {
  const row = document.getElementById('chips-row');
  if (!row) return;

  const agentTimeAgo = timeAgo(lastSeen);
  const agentOnline  = _isRecent(lastSeen, 300); // within 5 min

  row.innerHTML = `
    <span class="chip ${ac ? 'chip-ok' : 'chip-warning'}">
      ${ac ? '🔌' : '🔋'} ${ac ? (charging ? 'Charging' : 'AC on') : 'Battery'}
    </span>
    <span class="chip ${mt5 ? 'chip-ok' : 'chip-warning'}">
      📈 MT5 ${mt5 ? 'running' : 'not running'}
    </span>
    <span class="chip ${agentOnline ? 'chip-ok' : 'chip-warning'}" title="Last heartbeat">
      <span class="dot" style="animation: ${agentOnline ? 'pulse-dot 2s infinite' : 'none'}"></span>
      ${agentTimeAgo}
    </span>
    ${agentVersion ? `<span class="chip">v${agentVersion}</span>` : ''}
  `;
}

// ─── Runway ──────────────────────────────────────────────────

function _renderRunway(status) {
  const card = document.getElementById('runway-card');
  if (!card) return;

  const r  = status.latestReading  || {};
  const pr = status.prediction     || {};
  const dr = status.drainRate      || {};

  if (r.acConnected) {
    // Charging / plugged in
    const fullIn = pr.secsToFull ? formatDuration(pr.secsToFull) : null;
    card.innerHTML = `
      <div class="card-header"><div class="card-title">Battery</div></div>
      <div class="runway-main">
        <span class="runway-time">${r.charging ? (fullIn ? `Full in ${fullIn}` : 'Charging') : 'Plugged in'}</span>
      </div>
      <div class="runway-row">
        <span class="label">Status</span>
        <span class="value">${r.charging ? 'Charging' : 'Not charging'}</span>
      </div>
    `;
    return;
  }

  const trendStr  = pr.secsLeft   ? `About ${formatDuration(pr.secsLeft)}`  : '—';
  const winStr    = r.secsLeft     ? formatDuration(r.secsLeft)               : '—';
  const shutTime  = pr.secsLeft    ? shutdownTime(pr.secsLeft)                : null;
  const drainInfo = formatDrainInfo(dr);

  card.innerHTML = `
    <div class="card-header"><div class="card-title">Runway</div></div>
    <div class="runway-main">
      <span class="runway-time">${trendStr}</span>
      <span class="runway-label">remaining (trend)</span>
    </div>
    ${shutTime ? `<div class="runway-row"><span class="label">Predicted shutdown</span><span class="value">${shutTime}</span></div>` : ''}
    ${winStr !== '—' ? `<div class="runway-row"><span class="label">Windows estimate</span><span class="value">${winStr}</span></div>` : ''}
    ${drainInfo ? `<div class="runway-row" style="font-size:var(--text-xs);color:var(--text-muted)">${drainInfo}</div>` : ''}
  `;
}

// ─── Sparkline data ───────────────────────────────────────────

async function _loadSparkline(deviceId) {
  if (!_sparkline || !deviceId) return;
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const data  = await api.get(`/readings?deviceId=${deviceId}&since=${since}&limit=200`);
    const readings = data?.readings || [];
    const events   = readings.filter(r => r.event === 'ac_connected' || r.event === 'ac_disconnected');
    _sparkline.update(readings, events);
  } catch { /* silent */ }
}

// ─── Diagnosis card ───────────────────────────────────────────

function _renderDiagnosis(status) {
  const card = document.getElementById('diagnosis-card');
  if (!card) return;

  const isStale   = status.deviceStatus === 'stale';
  const isOffline = status.deviceStatus === 'offline';

  if (!isStale && !isOffline) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  const d = status.diagnosis || {};
  const silentSec = status.silentForSec || 0;

  const reasons = (d.reasons || []).map(r => `<li>${_esc(r)}</li>`).join('');
  const checks = [
    'Check home power / circuit breaker',
    'Check home Wi-Fi router',
    'Check if the laptop screen is on',
    'Check if the laptop went to sleep (battery still OK?)',
    'Try pinging the backend from another device',
  ].map(c => `<li>${_esc(c)}</li>`).join('');

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title">⚠ Offline Diagnosis</div>
    </div>
    <div class="silent-counter" aria-live="polite">${formatDuration(silentSec)}</div>
    <div class="offline-since">Silent since ${timeAgo(status.lastSeenAt)}</div>

    ${d.cause ? `
      <div class="cause-badge" style="margin-top:var(--space-3)">
        ${_esc(d.cause)} ${d.confidence ? `(${Math.round(d.confidence * 100)}% confidence)` : ''}
      </div>
    ` : ''}

    ${reasons ? `
      <div style="margin-top:var(--space-2);font-size:var(--text-sm);font-weight:600;color:var(--text-secondary)">Signals:</div>
      <ul class="reasons-list">${reasons}</ul>
    ` : ''}

    <div style="margin-top:var(--space-3);font-size:var(--text-sm);font-weight:600;color:var(--text-secondary)">What to try:</div>
    <ul class="try-list">${checks}</ul>
  `;
}

// ─── Alerts strip ─────────────────────────────────────────────

function _renderAlerts(alertsList) {
  const strip = document.getElementById('alerts-strip');
  if (!strip) return;

  const active = (alertsList || []).filter(a => !a.acknowledgedAt);

  if (!active.length) {
    strip.style.display = 'none';
    _handleCriticalTakeover(false);
    return;
  }

  strip.style.display = 'block';
  strip.innerHTML = `
    <div class="active-alerts-strip-title">🚨 Active alerts (${active.length})</div>
    ${active.map(a => _alertItemHTML(a)).join('')}
  `;

  // Wire ack / snooze buttons
  strip.querySelectorAll('[data-ack]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await alertsApi.acknowledge(btn.dataset.ack); } catch(e) { notify.toast({ title: 'Error', message: e.message, severity: 'warning' }); }
    });
  });

  strip.querySelectorAll('[data-snooze]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await alertsApi.snooze(btn.dataset.snooze, 10); } catch(e) { notify.toast({ title: 'Error', message: e.message, severity: 'warning' }); }
    });
  });

  // Critical takeover check
  const hasCritical = active.some(a => a.level === 'critical');
  _handleCriticalTakeover(hasCritical, active.find(a => a.level === 'critical'));

  // Badge
  const badge = document.querySelectorAll('.alert-badge');
  badge.forEach(b => { b.textContent = active.length; b.style.display = active.length ? '' : 'none'; });
}

function _alertItemHTML(a) {
  const sev = a.level === 'critical' ? 'critical' : a.level === 'high' ? 'warning' : 'info';
  const icon = sev === 'critical' ? '🔴' : sev === 'warning' ? '⚠️' : 'ℹ️';
  return `
    <div class="alert-item" data-severity="${sev}">
      <span class="alert-item-icon">${icon}</span>
      <div class="alert-item-body">
        <div class="alert-item-msg">${_esc(a.message || a.type)}</div>
        <div class="alert-item-time">${timeAgo(a.firedAt)}</div>
        <div class="alert-item-actions">
          <button class="btn btn-sm btn-ghost" data-ack="${a._id}">Acknowledge</button>
          <button class="btn btn-sm btn-ghost" data-snooze="${a._id}">Snooze 10m</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Critical takeover ─────────────────────────────────────────

function _wireCriticalTakeover() {
  const to = document.getElementById('critical-takeover');
  if (!to) return;

  to.querySelector('#to-ack')?.addEventListener('click', async () => {
    const alerts = store.get('alerts') || [];
    const crit   = alerts.find(a => a.level === 'critical' && !a.acknowledgedAt);
    if (crit) try { await alertsApi.acknowledge(crit._id); } catch { /* ignore */ }
    _dismissTakeover();
  });

  to.querySelector('#to-snooze')?.addEventListener('click', async () => {
    const alerts = store.get('alerts') || [];
    const crit   = alerts.find(a => a.level === 'critical' && !a.acknowledgedAt);
    if (crit) try { await alertsApi.snooze(crit._id, 10); } catch { /* ignore */ }
    _dismissTakeover();
  });
}

function _handleCriticalTakeover(hasCritical, alert) {
  if (hasCritical && !_takeoverActive) {
    _showTakeover(alert);
  } else if (!hasCritical && _takeoverActive) {
    _dismissTakeover();
  }
}

function _showTakeover(alert) {
  _takeoverActive = true;
  const to = document.getElementById('critical-takeover');
  if (!to) return;

  const status = store.get('status') || {};
  const r  = status.latestReading || {};
  const pct = Math.round(r.percent ?? 0);
  const pr  = status.prediction  || {};
  const shutdownT = pr.secsLeft ? shutdownTime(pr.secsLeft) : null;

  to.querySelector('.takeover-pct').textContent   = `${pct}%`;
  to.querySelector('.takeover-label').textContent = alert?.message || 'Critical battery!';
  to.querySelector('.takeover-subtext').textContent =
    shutdownT ? `Predicted shutdown at ${shutdownT}` : 'Connect charger immediately';

  to.classList.add('active', 'flashing');
  sound.playAlarm();

  // Flash document title
  let _flip = false;
  _titleInterval = setInterval(() => {
    document.title = _flip ? `🔴 CRITICAL ${pct}% — VoltWatch` : `⚠ ${pct}% LOW BATTERY`;
    _flip = !_flip;
  }, 800);

  // Show arm-sound prompt if not armed
  if (!sound.isArmed()) {
    document.getElementById('arm-sound-prompt')?.classList.add('visible');
  }
}

function _dismissTakeover() {
  _takeoverActive = false;
  const to = document.getElementById('critical-takeover');
  if (to) to.classList.remove('active', 'flashing');
  sound.stopAlarm();
  if (_titleInterval) { clearInterval(_titleInterval); _titleInterval = null; }
  document.title = 'VoltWatch';
}

// ─── Arm sound prompt ─────────────────────────────────────────

function _wireArmSound() {
  const prompt = document.getElementById('arm-sound-prompt');
  if (!prompt) return;
  prompt.addEventListener('click', () => {
    sound.arm();
    prompt.classList.remove('visible');
    if (_takeoverActive) sound.playAlarm();
    notify.toast({ title: 'Alarm armed', message: 'Sound will play for critical alerts.', severity: 'ok', duration: 3000 });
  });
}

// ─── Quick actions ────────────────────────────────────────────

function _wireQuickActions() {
  // Screen wake lock
  document.getElementById('btn-wake-lock')?.addEventListener('click', async () => {
    await _toggleWakeLock();
  });

  // Glance mode
  document.getElementById('btn-glance')?.addEventListener('click', () => {
    _enterGlance();
  });

  // Test alarm
  document.getElementById('btn-test-alarm')?.addEventListener('click', async () => {
    if (!sound.isArmed()) {
      notify.toast({ title: 'Arm sound first', message: 'Tap the arm prompt to unlock audio.', severity: 'info', duration: 3000 });
      return;
    }
    await sound.playAlarm();
    setTimeout(() => sound.stopAlarm(), 2000);
  });

  // Manual refresh
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    const { poller } = window.__vw || {};
    if (poller) poller.refresh();
  });
}

// Wake lock
async function _toggleWakeLock() {
  const btn = document.getElementById('btn-wake-lock');
  if (_wakeLock) {
    await _releaseWakeLock();
    btn && (btn.textContent = '☀ Keep awake');
    notify.toast({ title: 'Wake lock released', severity: 'info', duration: 2000 });
  } else {
    try {
      _wakeLock = await navigator.wakeLock?.request('screen');
      btn && (btn.textContent = '🔆 Screen awake');
      notify.toast({ title: 'Screen will stay on', severity: 'ok', duration: 2000 });
      _wakeLock.addEventListener('release', () => {
        _wakeLock = null;
        btn && (btn.textContent = '☀ Keep awake');
      });
    } catch {
      notify.toast({ title: 'Wake lock unavailable', severity: 'warning', duration: 3000 });
    }
  }
}

async function _releaseWakeLock() {
  if (_wakeLock) { await _wakeLock.release().catch(() => {}); _wakeLock = null; }
}

// ─── Glance mode ──────────────────────────────────────────────

function _wireGlanceMode() {
  const glance = document.getElementById('glance-mode');
  if (!glance) return;
  glance.addEventListener('click', _exitGlance);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _exitGlance(); });
}

function _enterGlance() {
  const status = store.get('status') || {};
  const r = status.latestReading || {};
  _syncGlance(Math.round(r.percent || 0), r.acConnected, r.charging);
  const glance = document.getElementById('glance-mode');
  if (glance) glance.classList.add('active');
  _glanceActive = true;
}

function _exitGlance() {
  document.getElementById('glance-mode')?.classList.remove('active');
  _glanceActive = false;
}

function _syncGlance(pct, ac, charging) {
  const glance = document.getElementById('glance-mode');
  if (!glance || !_glanceActive) return;
  const colour = gaugeColour(pct, ac, charging);
  glance.style.background = colour.replace('var(--', '').replace(')', '');
  // Use raw css var ref
  glance.style.backgroundColor = `${colour.includes('var') ? '' : colour}`;
  glance.style.setProperty('background', colour);
  glance.querySelector('.glance-pct').textContent  = `${pct}%`;
  const { text } = powerState({ percent: pct, acConnected: ac, charging });
  glance.querySelector('.glance-state').textContent = text;
}

// ─── Pull to refresh ──────────────────────────────────────────

function _wirePullToRefresh() {
  const main = document.getElementById('main-content');
  if (!main) return;

  let startY = 0, pulling = false;
  const indicator = document.getElementById('ptr-indicator');

  main.addEventListener('touchstart', e => {
    if (main.scrollTop === 0) { startY = e.touches[0].pageY; pulling = true; }
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].pageY - startY;
    if (dy > 40 && indicator) indicator.classList.add('visible');
  }, { passive: true });

  main.addEventListener('touchend', () => {
    if (pulling && indicator?.classList.contains('visible')) {
      window.__vw?.poller?.refresh();
      setTimeout(() => indicator.classList.remove('visible'), 600);
    }
    pulling = false;
  });
}

// ─── Time ticker ──────────────────────────────────────────────

function _tickTimeAgo() {
  const status = store.get('status');
  if (!status) return;

  // Diagnosis card silent counter
  const counter = document.querySelector('.silent-counter');
  if (counter && status.silentForSec != null) {
    const elapsed = status.silentForSec + Math.round((Date.now() - _renderTime) / 1000);
    counter.textContent = formatDuration(elapsed);
  }

  // Agent chip last report time
  const chipRow = document.getElementById('chips-row');
  if (chipRow) {
    const span = chipRow.querySelector('[title="Last heartbeat"]');
    if (span && status.lastSeenAt) {
      const dot = span.querySelector('.dot');
      span.textContent = timeAgo(status.lastSeenAt);
      if (dot) span.prepend(dot);
    }
  }
}

let _renderTime = Date.now();

// ─── Helpers ──────────────────────────────────────────────────

function _isRecent(ts, thresholdSec) {
  if (!ts) return false;
  return (Date.now() - new Date(ts).getTime()) < thresholdSec * 1000;
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
