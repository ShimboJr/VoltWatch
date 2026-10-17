/**
 * history.js — History chart page controller.
 *
 * Charts are created once and updated in place on range changes.
 * Pauses when the tab is hidden; resumes on visibilitychange.
 *
 * Requires: Chart.js 4.4 + chartjs-plugin-zoom (loaded via CDN in index.html)
 */

import { store }    from '../store.js';
import { readings as readingsApi } from '../api.js';
import { formatDateTime, formatDuration, formatPct } from '../format.js';

// ── State ─────────────────────────────────────────────────────

let _mainChart  = null;
let _stripChart = null;
let _rawData    = [];
let _range      = localStorage.getItem('vw-history-range') || '24h';
let _series     = { battery: true, ac: true, mt5: true, events: true };
let _tz         = Intl.DateTimeFormat().resolvedOptions().timeZone;
let _initDone   = false;

const RANGE_MS = {
  '1h':  1 * 3600e3,
  '6h':  6 * 3600e3,
  '24h': 24 * 3600e3,
  '7d':  7 * 86400e3,
  '30d': 30 * 86400e3,
};

// ── Colours (resolve from CSS variables) ─────────────────────

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function _colours() {
  return {
    ok:       cssVar('--c-ok')       || '#22c55e',
    warning:  cssVar('--c-warning')  || '#f59e0b',
    critical: cssVar('--c-critical') || '#ef4444',
    info:     cssVar('--c-info')     || '#3b82f6',
    charging: cssVar('--c-charging') || '#60a5fa',
    muted:    cssVar('--text-muted') || '#57606a',
    border:   cssVar('--border-subtle') || 'rgba(255,255,255,0.1)',
    surface:  cssVar('--bg-surface') || '#161b22',
    text:     cssVar('--text-secondary') || '#8d96a0',
  };
}

// ── Time axis format per range ────────────────────────────────

function _timeUnit(range) {
  switch (range) {
    case '1h':  return { unit: 'minute', stepSize: 10 };
    case '6h':  return { unit: 'hour',   stepSize: 1  };
    case '24h': return { unit: 'hour',   stepSize: 3  };
    case '7d':  return { unit: 'day',    stepSize: 1  };
    case '30d': return { unit: 'day',    stepSize: 5  };
    default:    return { unit: 'hour',   stepSize: 3  };
  }
}

function _timeFormat(range) {
  if (range === '1h' || range === '6h') return 'HH:mm';
  if (range === '24h') return 'HH:mm';
  return 'MMM d';
}

// ── Init ──────────────────────────────────────────────────────

export function initHistoryPage() {
  if (_initDone) {
    _setRangeChip(_range);
    return;
  }
  _initDone = true;

  _wireRangeChips();
  _wireSeriesChips();
  _wireExport();

  // Visibility — pause chart updates when hidden
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _load();
  });

  _setRangeChip(_range);
  _load();
}

export function destroyHistoryPage() {
  // Charts persist for instant re-entry; destroyed on navigate away only if memory pressure
}

// ── Wire controls ─────────────────────────────────────────────

function _wireRangeChips() {
  document.getElementById('history-range-chips')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    _range = btn.dataset.range;
    localStorage.setItem('vw-history-range', _range);
    _setRangeChip(_range);
    _load();
  });
}

function _setRangeChip(active) {
  document.querySelectorAll('#history-range-chips [data-range]').forEach(btn => {
    const on = btn.dataset.range === active;
    btn.classList.toggle('chip-info', on);
    btn.classList.toggle('chip-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function _wireSeriesChips() {
  document.getElementById('history-series-chips')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-series]');
    if (!btn) return;
    const key = btn.dataset.series;
    _series[key] = !_series[key];
    btn.setAttribute('aria-pressed', _series[key] ? 'true' : 'false');
    btn.classList.toggle('chip-active', _series[key]);
    _applySeries();
  });
}

function _applySeries() {
  if (!_mainChart) return;
  // Dataset indices: 0=battery, 1=AC-fills done via annotation, 2=events markers
  _mainChart.data.datasets.forEach((ds, i) => {
    if (ds._seriesKey) ds.hidden = !_series[ds._seriesKey];
  });
  _mainChart.update('none');

  if (_stripChart) {
    _stripChart.data.datasets.forEach(ds => {
      if (ds._seriesKey) ds.hidden = !_series[ds._seriesKey];
    });
    _stripChart.update('none');
  }
  document.getElementById('history-strip-card').style.display =
    _series.mt5 ? '' : 'none';
}

// ── Load data ─────────────────────────────────────────────────

async function _load() {
  if (document.hidden) return;
  const deviceId = store.get('deviceId');
  if (!deviceId) return;

  _showLoading(true);

  const since = new Date(Date.now() - RANGE_MS[_range]).toISOString();
  try {
    const res = await readingsApi.list(deviceId, { since, limit: 2000 });
    _rawData = res?.readings || res || [];
    _buildOrUpdate();
    _renderSummary();
    _updateA11ySummary();
    _showLoading(false);
  } catch (err) {
    _showError(err.message);
  }
}

function _showLoading(loading) {
  const el = document.getElementById('history-chart-loading');
  if (el) el.style.display = loading ? 'flex' : 'none';
}

function _showError(msg) {
  _showLoading(false);
  const el = document.getElementById('history-chart-summary');
  if (el) { el.textContent = `Error: ${msg}`; el.classList.remove('visually-hidden'); }
}

// ── Build / update charts ──────────────────────────────────────

function _buildOrUpdate() {
  const pts  = _rawData;
  const c    = _colours();
  const { unit, stepSize } = _timeUnit(_range);

  const labels = pts.map(p => new Date(p.deviceTime));
  const pcts   = pts.map(p => p.percent ?? null);

  // Segment colouring: colour each point by severity
  function pointColour(ctx) {
    const pct = ctx.parsed?.y ?? 100;
    if (pct <= 15) return c.critical;
    if (pct <= 30) return c.warning;
    return c.ok;
  }

  if (!_mainChart) {
    _mainChart = _createMainChart(labels, pcts, pts, c, unit, stepSize, pointColour);
  } else {
    _mainChart.data.labels = labels;
    _mainChart.data.datasets[0].data = pcts;
    _mainChart.data.datasets[0].segment = { borderColor: pointColour, backgroundColor: _gradientFn };
    _syncAnnotations(_mainChart, pts, c);
    _mainChart.resetZoom();
    _mainChart.update();
  }

  // Strip chart
  const mt5Data  = pts.map(p => p.mt5Running  ? 1 : 0);
  const agentData = pts.map((_, i) => {
    if (i === 0) return 1;
    const gap = new Date(pts[i].deviceTime) - new Date(pts[i-1].deviceTime);
    return gap < 300_000 ? 1 : 0; // 5 min gap = offline
  });

  if (!_stripChart) {
    _stripChart = _createStripChart(labels, mt5Data, agentData, c, unit, stepSize);
  } else {
    _stripChart.data.labels = labels;
    _stripChart.data.datasets[0].data = mt5Data;
    _stripChart.data.datasets[1].data = agentData;
    _stripChart.update();
  }

  _applySeries();
}

let _gradientFn = null; // populated after canvas exists

function _createMainChart(labels, pcts, pts, c, unit, stepSize, segmentColour) {
  const canvas = document.getElementById('history-main-chart');
  if (!canvas) return null;

  const ctx = canvas.getContext('2d');

  // Build gradient fill
  function makeGradient() {
    const h = canvas.offsetHeight || 240;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0,   'rgba(34,197,94,0.25)');
    grad.addColorStop(0.6, 'rgba(245,158,11,0.1)');
    grad.addColorStop(1,   'rgba(239,68,68,0.05)');
    return grad;
  }

  _gradientFn = (ctx2) => makeGradient();

  // Build AC band annotations
  const annotations = _buildAnnotations(pts, c);

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        _seriesKey: 'battery',
        label: 'Battery %',
        data: pcts,
        borderColor: c.ok,
        borderWidth: 2,
        backgroundColor: makeGradient(),
        fill: true,
        tension: 0.3,
        pointRadius: pts.length > 300 ? 0 : 3,
        pointHoverRadius: 6,
        segment: { borderColor: segmentColour },
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          titleColor: c.text,
          bodyColor: c.text,
          padding: 10,
          callbacks: {
            title: (items) => {
              const d = new Date(items[0].label);
              return formatDateTime(d, _tz);
            },
            label: (item) => {
              const i = item.dataIndex;
              const pt = pts[i];
              if (!pt) return '';
              const state = pt.acConnected
                ? (pt.charging ? '⚡ Charging' : '🔌 AC on')
                : '🔋 On battery';
              const mt5  = pt.mt5Running ? '📈 MT5 running' : '';
              const evt  = pt.event ? `📍 ${pt.event}` : '';
              return [
                `${Math.round(pt.percent)}%  ${state}`,
                mt5, evt,
              ].filter(Boolean);
            },
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
          },
          pan: { enabled: true, mode: 'x' },
        },
        annotation: { annotations },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit, stepSize, displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
          ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 16 },
          grid: { color: c.border },
          adapters: { date: {} },
        },
        y: {
          min: 0, max: 100,
          ticks: {
            color: c.muted,
            callback: v => `${v}%`,
            stepSize: 20,
          },
          grid: { color: c.border },
        },
      },
      onDblClick: () => chart.resetZoom(),
    },
  });

  // Double-tap reset on touch
  let _lastTap = 0;
  canvas.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - _lastTap < 300) chart.resetZoom();
    _lastTap = now;
  });

  return chart;
}

function _createStripChart(labels, mt5Data, agentData, c, unit, stepSize) {
  const canvas = document.getElementById('history-strip-chart');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');

  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          _seriesKey: 'mt5',
          label: 'MT5',
          data: mt5Data,
          backgroundColor: mt5Data.map(v => v ? 'rgba(34,197,94,0.6)' : 'transparent'),
          borderWidth: 0,
          barPercentage: 1,
          categoryPercentage: 0.5,
        },
        {
          _seriesKey: 'agent',
          label: 'Agent',
          data: agentData,
          backgroundColor: agentData.map(v => v ? 'rgba(59,130,246,0.4)' : 'rgba(239,68,68,0.3)'),
          borderWidth: 0,
          barPercentage: 1,
          categoryPercentage: 0.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) =>
              item.datasetIndex === 0
                ? `MT5: ${item.raw ? 'running' : 'stopped'}`
                : `Agent: ${item.raw ? 'online' : 'gap'}`,
          },
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          pan: { enabled: true, mode: 'x' },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit, stepSize },
          ticks: { display: false },
          grid:  { display: false },
        },
        y: { display: false, min: -0.1, max: 1.1 },
      },
    },
  });
}

// ── Annotations (AC bands, threshold lines, event markers) ────

function _buildAnnotations(pts, c) {
  const annotations = {};

  // Threshold horizontal lines
  const thresholds = [
    { pct: 50, color: c.info },
    { pct: 30, color: c.warning },
    { pct: 20, color: c.warning },
    { pct: 15, color: c.critical },
  ];

  thresholds.forEach(({ pct, color }) => {
    annotations[`thr-${pct}`] = {
      type: 'line', yMin: pct, yMax: pct,
      borderColor: color + '80',
      borderWidth: 1,
      borderDash: [4, 4],
      label: { display: true, content: `${pct}%`, position: 'end',
        backgroundColor: 'transparent', color, font: { size: 10 } },
    };
  });

  // AC-connected vertical bands
  let acStart = null;
  pts.forEach((p, i) => {
    const t = new Date(p.deviceTime).getTime();
    if (p.acConnected && acStart === null) acStart = t;
    if (!p.acConnected && acStart !== null) {
      annotations[`ac-${i}`] = {
        type: 'box',
        xMin: acStart, xMax: t,
        backgroundColor: 'rgba(59,130,246,0.06)',
        borderWidth: 0,
      };
      acStart = null;
    }
  });
  if (acStart !== null) {
    const last = new Date(pts[pts.length - 1].deviceTime).getTime();
    annotations[`ac-last`] = {
      type: 'box', xMin: acStart, xMax: last,
      backgroundColor: 'rgba(59,130,246,0.06)', borderWidth: 0,
    };
  }

  // Gap bands (no-data hatching)
  let prevT = null;
  pts.forEach((p, i) => {
    const t = new Date(p.deviceTime).getTime();
    if (prevT && (t - prevT) > 300_000) { // > 5 min gap
      annotations[`gap-${i}`] = {
        type: 'box', xMin: prevT, xMax: t,
        backgroundColor: 'rgba(239,68,68,0.06)',
        borderColor: 'rgba(239,68,68,0.2)',
        borderWidth: 1,
        borderDash: [4, 4],
      };
    }
    prevT = t;
  });

  // Event markers (plug/unplug)
  if (_series.events) {
    pts.filter(p => p.event).forEach((p, i) => {
      const icon = { ac_connected: '⚡', ac_disconnected: '🔋',
                     low_battery: '⚠', critical_battery: '🔴' }[p.event] || '📍';
      annotations[`ev-${i}`] = {
        type: 'line',
        xMin: new Date(p.deviceTime).getTime(),
        xMax: new Date(p.deviceTime).getTime(),
        borderColor: c.info + '80', borderWidth: 1, borderDash: [3, 3],
        label: { display: true, content: icon, position: 'start',
          backgroundColor: 'transparent', font: { size: 14 } },
      };
    });
  }

  return annotations;
}

function _syncAnnotations(chart, pts, c) {
  if (!chart.options.plugins.annotation) return;
  chart.options.plugins.annotation.annotations = _buildAnnotations(pts, c);
}

// ── Summary tiles ─────────────────────────────────────────────

function _renderSummary() {
  const pts = _rawData;
  const container = document.getElementById('history-summary');
  if (!container || !pts.length) return;

  const battery    = pts.filter(p => !p.acConnected);
  const pcts       = pts.map(p => p.percent);
  const minPct     = Math.round(Math.min(...pcts));
  const maxPct     = Math.round(Math.max(...pcts));
  const avgPct     = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const batteryMs  = battery.reduce((acc, p, i) => {
    if (i === 0) return 0;
    return acc + (new Date(p.deviceTime) - new Date(battery[i-1].deviceTime));
  }, 0);
  const powerCuts  = _countPowerCuts(pts);
  const longestGap = _longestGap(pts);

  const tiles = [
    { label: 'Min / Avg / Max',  value: `${minPct}% / ${avgPct}% / ${maxPct}%` },
    { label: 'Time on battery',  value: formatDuration(batteryMs / 1000) },
    { label: 'Power cuts',       value: String(powerCuts) },
    { label: 'Longest gap',      value: longestGap ? formatDuration(longestGap / 1000) : '—' },
    { label: 'Readings',         value: String(pts.length) },
    { label: 'Range',            value: _range },
  ];

  container.innerHTML = tiles.map(t => `
    <div class="summary-tile">
      <span class="tile-value">${_esc(t.value)}</span>
      <span class="tile-label">${_esc(t.label)}</span>
    </div>
  `).join('');
}

function _countPowerCuts(pts) {
  let cuts = 0, wasAC = true;
  for (const p of pts) {
    if (wasAC && !p.acConnected) cuts++;
    wasAC = p.acConnected;
  }
  return cuts;
}

function _longestGap(pts) {
  let longest = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = new Date(pts[i].deviceTime) - new Date(pts[i-1].deviceTime);
    if (gap > 300_000 && gap > longest) longest = gap;
  }
  return longest > 0 ? longest : null;
}

// ── Accessibility text summary ─────────────────────────────────

function _updateA11ySummary() {
  const pts = _rawData;
  if (!pts.length) return;
  const pcts = pts.map(p => p.percent);
  const min  = Math.round(Math.min(...pcts));
  const max  = Math.round(Math.max(...pcts));
  const avg  = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const cuts = _countPowerCuts(pts);
  const el   = document.getElementById('history-chart-summary');
  if (el) {
    el.textContent = `Battery history for last ${_range}. Range: ${min}% to ${max}%, average ${avg}%. ${cuts} power cut(s) detected.`;
  }
  const strip = document.getElementById('history-strip-summary');
  if (strip) {
    const mt5On = _rawData.filter(p => p.mt5Running).length;
    strip.textContent = `MT5 was running for ${Math.round(100 * mt5On / pts.length)}% of the period.`;
  }
}

// ── Export ────────────────────────────────────────────────────

function _wireExport() {
  document.getElementById('btn-export-csv')?.addEventListener('click', _exportCSV);
  document.getElementById('btn-copy-summary')?.addEventListener('click', _copySummary);
}

function _exportCSV() {
  const header = 'time,percent,acConnected,charging,mt5Running,event\n';
  const rows = _rawData.map(p => [
    p.deviceTime,
    Math.round(p.percent),
    p.acConnected ? 1 : 0,
    p.charging    ? 1 : 0,
    p.mt5Running  ? 1 : 0,
    p.event || '',
  ].join(',')).join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `voltwatch-${_range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function _copySummary() {
  const pts  = _rawData;
  if (!pts.length) return;
  const pcts = pts.map(p => p.percent);
  const min  = Math.round(Math.min(...pcts));
  const max  = Math.round(Math.max(...pcts));
  const avg  = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const cuts = _countPowerCuts(pts);
  const text = `VoltWatch ${_range} summary: Battery ${min}%–${max}%, avg ${avg}%. ${cuts} power cut(s). Generated ${new Date().toLocaleString()}.`;
  navigator.clipboard?.writeText(text).then(() => {
    document.getElementById('btn-copy-summary').textContent = '✓ Copied';
    setTimeout(() => { document.getElementById('btn-copy-summary').textContent = '⎘ Summary'; }, 2000);
  });
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
