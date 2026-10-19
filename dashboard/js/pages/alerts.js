/**
 * alerts.js — Alerts inbox page controller.
 *
 * Active / History tabs; severity + type filters; swipe-right to ack;
 * snooze dropdown; test alert; alert channels panel.
 */

import { store }   from '../store.js';
import { alerts as alertsApi } from '../api.js';
import { notify }  from '../notify.js';
import { sound }   from '../sound.js';
import { timeAgo, formatDateTime } from '../format.js';
import { S }       from '../strings.js';

// ── State ─────────────────────────────────────────────────────

let _tab      = 'active';       // 'active' | 'history'
let _severity = 'all';          // 'all' | 'critical' | 'high' | 'medium'
let _unsub    = null;
let _histPage = [];
let _initDone = false;

const SEVERITY_ICON = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      'ℹ️',
  info:     'ℹ️',
};

// ── Init ──────────────────────────────────────────────────────

export function initAlertsPage() {
  if (!_initDone) {
    _initDone = true;
    _wireTabs();
    _wireFilters();
    _wireTestAlert();
    _subscribeStore();
  }

  _renderTab();
  if (_tab === 'history') _loadHistory();
}

export function destroyAlertsPage() {
  if (_unsub) { _unsub(); _unsub = null; }
  _initDone = false;
}

// ── Wire tabs ─────────────────────────────────────────────────

function _wireTabs() {
  document.getElementById('alerts-tab-bar')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    _tab = btn.dataset.tab;
    document.querySelectorAll('#alerts-tab-bar [data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === _tab);
    });
    document.querySelectorAll('#page-alerts .tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.panel === _tab);
    });
    if (_tab === 'history') _loadHistory();
  });
}

// ── Wire severity filters ──────────────────────────────────────

function _wireFilters() {
  document.getElementById('alerts-filters')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-sev]');
    if (!btn) return;
    _severity = btn.dataset.sev;
    document.querySelectorAll('#alerts-filters [data-sev]').forEach(b => {
      b.classList.toggle('chip-active', b.dataset.sev === _severity);
      b.setAttribute('aria-pressed', b.dataset.sev === _severity ? 'true' : 'false');
    });
    _renderTab();
  });
}

// ── Store subscription ────────────────────────────────────────

function _subscribeStore() {
  _unsub = store.subscribe('alerts', () => {
    if (_tab === 'active') _renderActive();
    _updateBadge();
  });
}

// ── Render ────────────────────────────────────────────────────

function _renderTab() {
  if (_tab === 'active') _renderActive();
  else _renderHistory();
}

function _renderActive() {
  const container = document.getElementById('alerts-active-list');
  if (!container) return;

  let list = (store.get('alerts') || []).filter(a => !a.acknowledgedAt);
  if (_severity !== 'all') list = list.filter(a => a.severity === _severity);

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <h3>${S.noActiveAlerts}</h3>
        <p>Everything is looking good right now.</p>
      </div>`;
    return;
  }

  container.innerHTML = list.map(a => _alertCardHTML(a, true)).join('');
  _wireCardActions(container, true);
  _wireSwipe(container);
  _updateBadge();
}

async function _loadHistory() {
  const container = document.getElementById('alerts-history-list');
  if (!container) return;
  container.innerHTML = '<div class="skeleton" style="height:80px;margin-bottom:12px"></div>'.repeat(3);

  try {
    const res = await alertsApi.list({ state: 'all', limit: 50 });
    _histPage = (res?.alerts || res || []).filter(a => a.acknowledgedAt || a.resolvedAt);
    _renderHistory();
  } catch (err) {
    container.innerHTML = `<div class="error-state"><div class="error-icon">⚠️</div><h3>Failed to load</h3><p>${_esc(err.message)}</p></div>`;
  }
}

function _renderHistory() {
  const container = document.getElementById('alerts-history-list');
  if (!container) return;

  let list = _histPage;
  if (_severity !== 'all') list = list.filter(a => a.severity === _severity);

  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><h3>${S.noAlertsYet}</h3></div>`;
    return;
  }

  container.innerHTML = list.map(a => _alertCardHTML(a, false)).join('');
  _wireCardActions(container, false);
}

function _alertCardHTML(a, isActive) {
  const sev  = a.severity || 'info';
  const icon = SEVERITY_ICON[sev] || 'ℹ️';
  const ts   = a.firedAt || a.createdAt;
  const deviceName = store.get('devices')?.find(d => d._id === a.deviceId)?.name || S.unknown;

  const snoozeMenu = isActive ? `
    <div class="dropdown" style="position:relative">
      <button class="btn btn-ghost btn-sm" data-snooze-toggle="${a._id}" aria-haspopup="true" aria-expanded="false">
        ${S.snooze} ▾
      </button>
      <div class="dropdown-menu" id="snooze-menu-${a._id}" style="display:none;position:absolute;top:100%;left:0;z-index:200;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-md);min-width:140px;box-shadow:var(--shadow-md)">
        <button class="dropdown-item" data-snooze="${a._id}" data-mins="10" style="display:block;width:100%;padding:10px 14px;background:none;border:none;text-align:left;font-size:var(--text-sm);cursor:pointer;color:var(--text-primary)">${S.snooze10}</button>
        <button class="dropdown-item" data-snooze="${a._id}" data-mins="30" style="display:block;width:100%;padding:10px 14px;background:none;border:none;text-align:left;font-size:var(--text-sm);cursor:pointer;color:var(--text-primary)">${S.snooze30}</button>
        <button class="dropdown-item" data-snooze="${a._id}" data-mins="60" style="display:block;width:100%;padding:10px 14px;background:none;border:none;text-align:left;font-size:var(--text-sm);cursor:pointer;color:var(--text-primary)">${S.snooze60}</button>
      </div>
    </div>` : '';

  const deleteBtn = !isActive
    ? `<button class="btn btn-ghost btn-sm" data-delete-alert="${a._id}" style="color:var(--c-critical)">${S.deleteAlert}</button>`
    : '';

  return `
    <div class="alert-card" data-severity="${sev}" data-alert-id="${a._id}" role="article" aria-label="${_esc(sev)} alert: ${_esc(a.message || a.type)}">
      <div class="swipe-ack-overlay" aria-hidden="true">✓ ${S.acknowledge}</div>
      <div class="alert-card-stripe"></div>
      <div class="alert-card-body">
        <div class="alert-card-header">
          <span class="alert-card-icon" aria-hidden="true">${icon}</span>
          <div class="alert-card-info">
            <div class="alert-card-msg">${_esc(a.message || a.type)}</div>
            <div class="alert-card-device">📟 ${_esc(deviceName)}</div>
          </div>
          <span class="pill ${sev === 'critical' ? 'pill-critical' : sev === 'high' ? 'pill-warning' : 'pill-info'}">${_esc(sev)}</span>
        </div>
        <div class="alert-card-times">
          <span>🕐 ${timeAgo(ts)}</span>
          <span>${formatDateTime(new Date(ts))}</span>
          ${a.acknowledgedAt ? `<span style="color:var(--c-ok)">✓ Acked ${timeAgo(a.acknowledgedAt)}</span>` : ''}
        </div>
        <div class="alert-card-actions">
          ${isActive ? `<button class="btn btn-sm btn-ghost" data-ack="${a._id}">${S.acknowledge}</button>` : ''}
          ${snoozeMenu}
          ${deleteBtn}
        </div>
      </div>
    </div>
  `;
}

// ── Card action wiring ────────────────────────────────────────

function _wireCardActions(container, isActive) {
  // Acknowledge
  container.querySelectorAll('[data-ack]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('loading');
      try {
        await alertsApi.acknowledge(btn.dataset.ack);
        notify.toast({ title: 'Alert acknowledged', severity: 'ok', duration: 2000 });
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      } finally {
        btn.classList.remove('loading');
      }
    });
  });

  // Snooze dropdown toggle
  container.querySelectorAll('[data-snooze-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = btn.dataset.snoozeToggle;
      const menu = document.getElementById(`snooze-menu-${id}`);
      if (!menu) return;
      const open = menu.style.display !== 'none';
      document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
      menu.style.display = open ? 'none' : 'block';
      btn.setAttribute('aria-expanded', !open);
    });
  });

  // Snooze items
  container.querySelectorAll('[data-snooze][data-mins]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.snooze;
      const mins = parseInt(btn.dataset.mins);
      document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
      try {
        await alertsApi.snooze(id, mins);
        notify.toast({ title: `Snoozed for ${mins}m`, severity: 'info', duration: 2000 });
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });

  // Delete from history
  container.querySelectorAll('[data-delete-alert]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this alert from history?')) return;
      try {
        await alertsApi.delete(btn.dataset.deleteAlert);
        _histPage = _histPage.filter(a => a._id !== btn.dataset.deleteAlert);
        _renderHistory();
        notify.toast({ title: 'Deleted', severity: 'ok', duration: 2000 });
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
  }, { once: true });
}

// ── Swipe to acknowledge ──────────────────────────────────────

function _wireSwipe(container) {
  container.querySelectorAll('.alert-card').forEach(card => {
    let startX = 0, dx = 0;
    const overlay = card.querySelector('.swipe-ack-overlay');

    card.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      dx = 0;
    }, { passive: true });

    card.addEventListener('touchmove', e => {
      dx = e.touches[0].clientX - startX;
      if (dx > 0 && dx < 120) {
        card.style.transform = `translateX(${dx}px)`;
        if (overlay) overlay.style.opacity = String(dx / 80);
      }
    }, { passive: true });

    card.addEventListener('touchend', async () => {
      if (dx > 80) {
        // Trigger ack
        const id = card.dataset.alertId;
        card.style.transform = 'translateX(100%)';
        card.style.opacity   = '0';
        card.style.transition = 'all 0.3s ease';
        try {
          await alertsApi.acknowledge(id);
          setTimeout(() => card.remove(), 300);
          notify.toast({ title: 'Alert acknowledged', severity: 'ok', duration: 2000 });
        } catch (e) {
          card.style.transform = '';
          card.style.opacity   = '';
          notify.toast({ title: S.error, message: e.message, severity: 'warning' });
        }
      } else {
        card.style.transform = '';
        if (overlay) overlay.style.opacity = '0';
      }
    });
  });
}

// ── Test alert ────────────────────────────────────────────────

function _wireTestAlert() {
  document.getElementById('btn-test-alert-page')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-alert-page');
    btn.classList.add('loading');
    try {
      await alertsApi.test();
      notify.toast({ title: S.testAlertDone, message: 'Check sound, vibration and takeover.', severity: 'info', duration: 4000 });
    } catch (e) {
      notify.toast({ title: S.error, message: e.message, severity: 'warning' });
    } finally {
      btn.classList.remove('loading');
    }
  });
}

// ── Badge ─────────────────────────────────────────────────────

function _updateBadge() {
  const count = (store.get('alerts') || []).filter(a => !a.acknowledgedAt).length;
  document.querySelectorAll('.alert-badge').forEach(b => {
    b.textContent  = count;
    b.style.display = count ? '' : 'none';
  });
  const tabCount = document.getElementById('alerts-tab-count');
  if (tabCount) {
    tabCount.textContent  = count;
    tabCount.style.display = count ? '' : 'none';
  }
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
