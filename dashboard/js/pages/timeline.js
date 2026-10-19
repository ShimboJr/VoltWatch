/**
 * timeline.js — Event timeline page controller.
 *
 * Features:
 *  - Infinite scroll with `before` cursor pagination
 *  - Filter chips by event category
 *  - Grouped by day (Today / Yesterday / dates)
 *  - Duration chips between related events
 *  - Bottom sheet with full event detail
 *  - Live inserts at top from store's event stream
 *  - Keyboard accessible (Enter/Space opens sheet, Escape closes)
 */

import { store }  from '../store.js';
import { events as eventsApi } from '../api.js';
import { formatDateTime, formatDuration, timeAgo } from '../format.js';

// ── State ─────────────────────────────────────────────────────

let _items      = [];           // accumulated event objects
let _cursor     = null;         // ISO timestamp for pagination
let _filter     = 'all';        // current filter key
let _loading    = false;
let _exhausted  = false;        // no more pages
let _initDone   = false;
let _observer   = null;         // IntersectionObserver for scroll
let _liveUnsub  = null;

const PAGE_SIZE = 40;

// ── Event metadata ────────────────────────────────────────────

const EVENT_META = {
  // Maps lowercase(POWER_EVENT_TYPES) → display metadata
  ac_reconnected:           { icon: '⚡', label: 'AC connected',            type: 'power',   color: 'chip-ok'       },
  ac_disconnected:          { icon: '🔋', label: 'AC disconnected',          type: 'power',   color: 'chip-warning'  },
  low_battery:              { icon: '⚠️', label: 'Low battery',              type: 'alert',   color: 'chip-warning'  },
  heartbeat_lost:           { icon: '📡', label: 'Device went offline',      type: 'agent',   color: 'chip-critical' },
  heartbeat_recovered:      { icon: '🌐', label: 'Device back online',       type: 'agent',   color: 'chip-ok'       },
  agent_started:            { icon: '🟢', label: 'Agent started',            type: 'agent',   color: 'chip-ok'       },
  agent_stopped_planned:    { icon: '⏹️', label: 'Agent stopping (planned)', type: 'agent',   color: ''              },
  system_shutdown:          { icon: '💥', label: 'System shutdown',          type: 'agent',   color: 'chip-critical' },
  unexpected_shutdown:      { icon: '💥', label: 'Unexpected shutdown',      type: 'agent',   color: 'chip-critical' },
  resumed_from_sleep:       { icon: '😴', label: 'Resumed from sleep',       type: 'agent',   color: ''              },
  mt5_started:              { icon: '📈', label: 'MT5 started',              type: 'mt5',     color: 'chip-ok'       },
  mt5_stopped:              { icon: '📉', label: 'MT5 stopped',              type: 'mt5',     color: ''              },
};

// Maps filter chip key → actual lowercase PowerEvent type strings sent to the API
const FILTER_TYPES = {
  all:   null,
  power: ['ac_reconnected', 'ac_disconnected'],
  alert: ['low_battery'],
  mt5:   ['mt5_started', 'mt5_stopped'],
  agent: ['agent_started', 'agent_stopped_planned', 'system_shutdown', 'unexpected_shutdown', 'heartbeat_lost', 'heartbeat_recovered', 'resumed_from_sleep'],
};

// ── Init ──────────────────────────────────────────────────────

export function initTimelinePage() {
  _wireFilters();
  _wireSheet();
  _wireKeyboard();

  if (!_initDone) {
    _initDone = true;
    _setupInfiniteScroll();
    _subscribeToLive();
  }

  // Reset and load fresh
  _reset();
  _loadPage();
}

export function destroyTimelinePage() {
  if (_liveUnsub) { _liveUnsub(); _liveUnsub = null; }
  if (_observer)  { _observer.disconnect(); _observer = null; }
  _initDone = false;
}

// ── Filter chips ──────────────────────────────────────────────

function _wireFilters() {
  const bar = document.getElementById('timeline-filters');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    _filter = btn.dataset.filter;

    bar.querySelectorAll('[data-filter]').forEach(b => {
      const on = b.dataset.filter === _filter;
      b.classList.toggle('chip-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    _reset();
    _loadPage();
  });
}

// ── Infinite scroll ───────────────────────────────────────────

function _setupInfiniteScroll() {
  const sentinel = document.getElementById('timeline-sentinel');
  if (!sentinel || typeof IntersectionObserver === 'undefined') return;

  _observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !_loading && !_exhausted) {
      _loadPage();
    }
  }, { rootMargin: '200px' });

  _observer.observe(sentinel);
}

// ── Live inserts ──────────────────────────────────────────────

function _subscribeToLive() {
  _liveUnsub = store.subscribe('status', (status) => {
    if (!status?.latestEvent) return;
    const ev = status.latestEvent;

    // Avoid duplicates
    if (_items.some(i => i._id === ev._id)) return;

    _items.unshift(ev);
    const list = document.getElementById('timeline-list');
    if (!list) return;

    // Insert at top with animation
    const html = _itemHTML(ev, null);
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const el = temp.firstElementChild;
    if (el) {
      el.style.animation = 'none';
      list.insertBefore(el, list.firstChild);
      requestAnimationFrame(() => {
        el.style.animation = '';
      });
    }
  });
}

// ── Load page ─────────────────────────────────────────────────

async function _reset() {
  _items    = [];
  _cursor   = null;
  _exhausted = false;
  const list = document.getElementById('timeline-list');
  if (list) { list.innerHTML = ''; list.setAttribute('aria-busy', 'true'); }
}

async function _loadPage() {
  if (_loading || _exhausted) return;
  const deviceId = store.get('deviceId');
  if (!deviceId) return;

  _loading = true;
  _showLoading(true);

  try {
    const typeList = _filter !== 'all' ? FILTER_TYPES[_filter] : null;
    const types = typeList?.length ? typeList.join(',') : undefined;

    const res = await eventsApi.list(deviceId, {
      before: _cursor,
      limit:  PAGE_SIZE,
      types,
    });

    const page = res?.events || res || [];
    if (page.length < PAGE_SIZE) _exhausted = true;
    if (page.length === 0) {
      if (_items.length === 0) _renderEmpty();
      _showLoading(false);
      _loading = false;
      return;
    }

    if (page.length > 0) {
      _cursor = page[page.length - 1].deviceTime;
    }

    _items.push(...page);
    _renderPage(page);
    _showLoading(false);
  } catch (err) {
    _renderError(err.message);
  } finally {
    _loading = false;
    document.getElementById('timeline-list')?.setAttribute('aria-busy', 'false');
  }
}

// ── Render ────────────────────────────────────────────────────

function _renderPage(newItems) {
  const list = document.getElementById('timeline-list');
  if (!list) return;

  // Group new items by calendar day
  const groups = _groupByDay(newItems);

  groups.forEach(({ label, items }) => {
    // Check if a group for this day already exists
    let groupEl = list.querySelector(`[data-day="${label}"]`);
    if (!groupEl) {
      groupEl = document.createElement('div');
      groupEl.className = 'timeline-day-group';
      groupEl.setAttribute('data-day', label);
      groupEl.innerHTML = `<div class="timeline-day-label">${_esc(label)}</div>`;
      list.appendChild(groupEl);
    }

    items.forEach((ev, idx) => {
      const nextEv = items[idx + 1] || null;
      const html   = _itemHTML(ev, nextEv);
      const temp   = document.createElement('template');
      temp.innerHTML = html;
      groupEl.appendChild(temp.content.firstElementChild);
    });
  });
}

function _groupByDay(items) {
  const today     = _dayKey(new Date());
  const yesterday = _dayKey(new Date(Date.now() - 86400_000));
  const map = new Map();

  items.forEach(ev => {
    const d   = new Date(ev.deviceTime || ev.firedAt);
    const key = _dayKey(d);
    const label = key === today ? 'Today'
                : key === yesterday ? 'Yesterday'
                : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(ev);
  });

  return [...map.entries()].map(([label, items]) => ({ label, items }));
}

function _dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function _itemHTML(ev, nextEv) {
  const meta  = EVENT_META[ev.event] || { icon: '📋', label: ev.event, type: 'agent', color: '' };
  const isLast = !nextEv;
  const dot  = `<div class="tl-dot" data-type="${meta.type}">${meta.icon}</div>`;
  const line  = isLast ? '' : '<div class="tl-line"></div>';

  const ts    = ev.deviceTime || ev.firedAt;
  const time  = ts ? formatDateTime(new Date(ts)) : '';
  const pct   = ev.percent != null ? `${Math.round(ev.percent)}%` : '';

  // Duration chip between related events
  let dur = '';
  if (nextEv && ts && nextEv.deviceTime) {
    const diff = Math.abs(new Date(nextEv.deviceTime) - new Date(ts));
    if (diff > 60_000) {
      dur = `<span class="tl-dur">${formatDuration(diff / 1000)}</span>`;
    }
  }

  const id = ev._id || ev.readingId || ts;

  return `
    <div class="timeline-item"
         role="article"
         tabindex="0"
         data-id="${_esc(String(id))}"
         aria-label="${_esc(meta.label)} at ${_esc(time)}${pct ? ', ' + pct : ''}">
      <div class="tl-spine">${dot}${line}</div>
      <div class="tl-body">
        <div class="tl-title">${_esc(meta.label)}</div>
        <div class="tl-meta">
          <span class="tl-time">${_esc(time)}</span>
          ${pct ? `<span class="tl-pct">${_esc(pct)}</span>` : ''}
          ${ev.mt5Running !== undefined ? `<span class="tl-dur">${ev.mt5Running ? '📈 MT5 on' : '📉 MT5 off'}</span>` : ''}
          ${dur}
        </div>
      </div>
    </div>
  `;
}

function _renderEmpty() {
  const list = document.getElementById('timeline-list');
  if (!list) return;
  list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <h3>No events yet</h3>
      <p>${_filter !== 'all' ? 'No events match this filter.' : 'Events will appear here as your device reports them.'}</p>
    </div>`;
}

function _renderError(msg) {
  const list = document.getElementById('timeline-list');
  if (!list) return;
  list.innerHTML = `
    <div class="error-state">
      <div class="error-icon">⚠️</div>
      <h3>Failed to load events</h3>
      <p>${_esc(msg)}</p>
      <button class="btn btn-ghost btn-sm" onclick="window.__vw?.timeline?.reload()">Retry</button>
    </div>`;
}

function _showLoading(show) {
  const el = document.getElementById('timeline-loading');
  if (el) el.style.display = show ? 'block' : 'none';
}

// ── Bottom sheet ──────────────────────────────────────────────

function _wireSheet() {
  const backdrop = document.getElementById('timeline-sheet-backdrop');
  backdrop?.addEventListener('click', _closeSheet);
}

function _wireKeyboard() {
  const list = document.getElementById('timeline-list');
  if (!list) return;

  list.addEventListener('click', e => {
    const item = e.target.closest('.timeline-item');
    if (item) _openSheet(item.dataset.id);
  });

  list.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const item = e.target.closest('.timeline-item');
      if (item) { e.preventDefault(); _openSheet(item.dataset.id); }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _closeSheet();
  });
}

function _openSheet(id) {
  const ev = _items.find(i => (i._id || i.readingId || i.deviceTime) === id);
  if (!ev) return;

  const meta   = EVENT_META[ev.event] || { icon: '📋', label: ev.event };
  const sheet  = document.getElementById('timeline-sheet');
  const content = document.getElementById('sheet-content');
  const backdrop = document.getElementById('timeline-sheet-backdrop');

  const rows = [
    ['Event',    meta.label],
    ['Time',     formatDateTime(new Date(ev.deviceTime || ev.firedAt))],
    ['Battery',  ev.percent != null ? `${Math.round(ev.percent)}%` : '—'],
    ['AC',       ev.acConnected != null ? (ev.acConnected ? 'Connected' : 'Disconnected') : '—'],
    ['MT5',      ev.mt5Running != null ? (ev.mt5Running ? 'Running' : 'Stopped') : '—'],
    ['Agent v',  ev.agentVersion || '—'],
  ].filter(([, v]) => v !== '—');

  if (content) {
    content.innerHTML = `
      <h2 id="sheet-title" style="font-size:var(--text-xl);margin-bottom:var(--space-4)">
        ${meta.icon} ${_esc(meta.label)}
      </h2>
      ${rows.map(([k, v]) => `
        <div class="runway-row">
          <span class="label">${_esc(k)}</span>
          <span class="value">${_esc(v)}</span>
        </div>`).join('')}
      ${ev.meta ? `<pre style="margin-top:var(--space-3);font-size:var(--text-xs);color:var(--text-muted);overflow-x:auto">${JSON.stringify(ev.meta, null, 2)}</pre>` : ''}
    `;
  }

  sheet?.setAttribute('aria-hidden', 'false');
  sheet?.classList.add('open');
  backdrop?.classList.add('visible');
  sheet?.querySelector('h2')?.focus();
}

function _closeSheet() {
  document.getElementById('timeline-sheet')?.classList.remove('open');
  document.getElementById('timeline-sheet')?.setAttribute('aria-hidden', 'true');
  document.getElementById('timeline-sheet-backdrop')?.classList.remove('visible');
}

// ── Public ────────────────────────────────────────────────────

window.__vw = window.__vw || {};
window.__vw.timeline = { reload: () => { _reset(); _loadPage(); } };

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
