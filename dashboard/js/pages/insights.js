/**
 * insights.js — Insights page controller.
 *
 * Renders cards from GET /devices/:id/insights.
 * Cards: runway, power cuts, discharge rate, reliability gauges,
 *        when-cuts-happen heatmap, weekly summary.
 * All computed client-side from the insights API response.
 */

import { store }   from '../store.js';
import { insights as insightsApi } from '../api.js';
import { formatDuration, formatPct, formatDateTime } from '../format.js';

// ── State ─────────────────────────────────────────────────────

let _range    = localStorage.getItem('vw-insights-range') || '7d';
let _data     = null;
let _initDone = false;

// ── Init ──────────────────────────────────────────────────────

export function initInsightsPage() {
  if (!_initDone) {
    _initDone = true;
    _wireRange();
  }
  _setRangeChip(_range);
  _load();
}

export function destroyInsightsPage() { /* charts are SVG, no cleanup needed */ }

// ── Range chips ───────────────────────────────────────────────

function _wireRange() {
  document.getElementById('insights-range')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-ins-range]');
    if (!btn) return;
    _range = btn.dataset.insRange;
    localStorage.setItem('vw-insights-range', _range);
    _setRangeChip(_range);
    _load();
  });
}

function _setRangeChip(active) {
  document.querySelectorAll('[data-ins-range]').forEach(btn => {
    const on = btn.dataset.insRange === active;
    btn.classList.toggle('chip-info', on);
    btn.classList.toggle('chip-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// ── Load ──────────────────────────────────────────────────────

async function _load() {
  const deviceId = store.get('deviceId');
  if (!deviceId) return;

  const grid = document.getElementById('insights-grid');
  if (!grid) return;

  grid.innerHTML = [1, 2, 3, 4, 5, 6].map(() =>
    '<div class="skeleton" style="height:140px;margin-bottom:var(--space-3)"></div>'
  ).join('');

  try {
    const res = await insightsApi.get(deviceId, _range);
    // API returns { insights: { ... } } — unwrap before rendering
    _data = res?.insights ?? res;
    _render(_data);
  } catch (err) {
    // Safely extract a displayable message — err.message may be undefined
    const msg = typeof err?.message === 'string' && err.message
      ? err.message
      : (typeof err === 'string' ? err : 'Unknown error');
    grid.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <h3>Insights unavailable</h3>
        <p>${_esc(msg)}</p>
        <button class="btn btn-ghost btn-sm" onclick="initInsightsPage()">Retry</button>
      </div>`;
  }
}

// ── Render all cards ──────────────────────────────────────────

function _render(d) {
  const grid = document.getElementById('insights-grid');
  if (!grid) return;

  grid.innerHTML = '';

  grid.appendChild(_runwayCard(d));
  grid.appendChild(_powerCutsCard(d));
  grid.appendChild(_dischargeCard(d));
  grid.appendChild(_reliabilityCard(d));
  grid.appendChild(_heatmapCard(d));
  grid.appendChild(_summaryCard(d));
}

// ── 1. Runway card ────────────────────────────────────────────

function _runwayCard(d) {
  const runway = d?.runway;
  const noData = !runway;

  const el = _card('⚡ Battery runway now',
    'If power is cut right now, estimated time remaining.',
    noData ? _emptyHtml('Need a recent reading') : `
      <div class="insight-big">${_fmt(formatDuration(runway?.secsLeft), '—')}</div>
      <div class="insight-sub">${_fmt(runway?.note, '')}</div>
      ${runway?.mt5Note ? `<div class="insight-sub" style="margin-top:var(--space-1);color:var(--c-warning)">${_esc(runway.mt5Note)}</div>` : ''}
      ${runway?.percent != null ? `<div style="margin-top:var(--space-2);font-size:var(--text-xs);color:var(--text-muted)">Current: ${Math.round(runway.percent)}%</div>` : ''}
    `
  );
  return el;
}

// ── 2. Power cuts card ────────────────────────────────────────

function _powerCutsCard(d) {
  const pc = d?.powerCuts;
  const noData = !pc || pc.count === 0;

  const barHtml = noData ? '' : _miniBarChart(
    (pc.byDay || []).map(b => ({ value: b.count, label: b.date, tip: `${b.date}: ${b.count} cut(s)` })),
    'cuts per day',
  );

  return _card('⚡ Power cuts', `Summary over last ${_range}.`,
    noData ? _emptyHtml('No power cuts detected') : `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3)">
        <div>
          <div class="insight-big">${pc.count}</div>
          <div class="insight-sub">total cuts</div>
        </div>
        <div>
          <div class="insight-big">${formatDuration(pc.totalBatterySec)}</div>
          <div class="insight-sub">total on battery</div>
        </div>
        <div>
          <div class="insight-big">${formatDuration(pc.longestOutageSec)}</div>
          <div class="insight-sub">longest outage</div>
        </div>
        <div>
          <div class="insight-big">${pc.count > 0 ? formatDuration(pc.totalBatterySec / pc.count) : '—'}</div>
          <div class="insight-sub">avg per cut</div>
        </div>
      </div>
      ${barHtml}
    `
  );
}

// ── 3. Discharge rate card ────────────────────────────────────

function _dischargeCard(d) {
  const dr = d?.dischargeRate;
  const noData = !dr;

  const sparkHtml = dr?.perOutage?.length
    ? _miniSparkline(dr.perOutage.map(o => o.pctPerHour), 'Drain rate per outage')
    : '';

  return _card('📉 Discharge rate', 'How fast the battery drains when on battery.',
    noData ? _emptyHtml('Need battery-on-battery readings') : `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-3)">
        <div>
          <div class="insight-big">${dr.avg != null ? `${dr.avg.toFixed(1)}%/h` : '—'}</div>
          <div class="insight-sub">average</div>
        </div>
        <div>
          <div class="insight-big">${dr.median != null ? `${dr.median.toFixed(1)}%/h` : '—'}</div>
          <div class="insight-sub">median</div>
        </div>
      </div>
      ${sparkHtml}
    `
  );
}

// ── 4. Reliability card ───────────────────────────────────────

function _reliabilityCard(d) {
  const rel = d?.reliability;
  const noData = !rel;

  return _card('🛡 Reliability', 'Agent and MT5 availability.',
    noData ? _emptyHtml('Collecting data…') : `
      <div class="radial-gauges">
        ${_radialGauge(rel.agentAvailability ?? 0, 'Agent uptime')}
        ${_radialGauge(rel.mt5Uptime ?? 0, 'MT5 uptime', 'var(--c-ok)')}
      </div>
      ${rel.longestSilentGapSec ? `
        <div style="margin-top:var(--space-3);font-size:var(--text-sm);color:var(--text-secondary)">
          Longest silent gap: <strong>${formatDuration(rel.longestSilentGapSec)}</strong>
        </div>` : ''}
    `
  );
}

// ── 5. Heatmap card ───────────────────────────────────────────

function _heatmapCard(d) {
  const hm = d?.heatmap; // { hourOfDay: [[0..23], counts per DOW], byHour: [], byDow: [] }
  const noData = !hm;

  return _card('🗓 When do cuts happen', 'Hour of day × day of week.',
    noData ? _emptyHtml('Need more data for patterns') : `
      ${_heatmapGrid(hm)}
      <div class="insight-sub" style="margin-top:var(--space-3)" aria-live="polite" id="heatmap-a11y">
        ${_heatmapA11y(hm)}
      </div>
    `
  );
}

// ── 6. Weekly summary card ────────────────────────────────────

function _summaryCard(d) {
  const text = _generateSummary(d);
  return _card('📝 Summary', `Generated for the last ${_range}.`,
    `<div class="weekly-summary">${_esc(text)}</div>`
  );
}

// ── Helpers ───────────────────────────────────────────────────

function _card(title, tooltip, bodyHtml) {
  const el = document.createElement('div');
  el.className = 'insight-card';
  el.innerHTML = `
    <div class="insight-card-title">
      ${_esc(title)}
      <button class="insight-tooltip-btn" title="${_esc(tooltip)}" aria-label="${_esc(tooltip)}">?</button>
    </div>
    ${bodyHtml}
  `;
  return el;
}

function _emptyHtml(msg) {
  return `<div class="insight-empty"><div class="ie-icon">📊</div><p>${_esc(msg)}</p></div>`;
}

function _fmt(val, fallback = '—') {
  return val != null ? _esc(String(val)) : fallback;
}

// ── Mini bar chart (SVG) ──────────────────────────────────────

function _miniBarChart(data, ariaLabel) {
  if (!data.length) return '';
  const max = Math.max(...data.map(d => d.value), 1);

  const bars = data.map(d => {
    const h = Math.round((d.value / max) * 100);
    return `<div class="mini-bar ${d.value > 0 ? 'has-cuts' : ''}"
                 style="height:${h}%"
                 title="${_esc(d.tip || d.label)}"
                 data-tip="${_esc(d.tip || d.label)}"
                 role="img" aria-label="${_esc(d.tip || d.label)}"></div>`;
  }).join('');

  return `<div class="mini-bars" role="img" aria-label="${_esc(ariaLabel)}">${bars}</div>`;
}

// ── Mini sparkline (inline SVG) ───────────────────────────────

function _miniSparkline(values, ariaLabel) {
  if (!values.length) return '';
  const max = Math.max(...values, 0.1);
  const W = 100, H = 40;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - (v / max) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:40px" role="img" aria-label="${_esc(ariaLabel)}">
      <polyline points="${pts}" fill="none" stroke="var(--c-info)" stroke-width="2" stroke-linejoin="round"/>
    </svg>
    <div style="font-size:10px;color:var(--text-muted);text-align:center">${_esc(ariaLabel)}</div>
  `;
}

// ── Radial gauge (SVG) ────────────────────────────────────────

function _radialGauge(pct, label, colour = 'var(--c-info)') {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 28, cx = 36, cy = 36;
  const circ = 2 * Math.PI * r;
  const offset = circ - (clamped / 100) * circ;

  return `
    <div class="radial-gauge-wrap">
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-elevated)" stroke-width="8"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colour}" stroke-width="8"
                stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
                stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle"
              font-family="var(--font-num)" font-size="12" font-weight="700"
              fill="var(--text-primary)">${Math.round(clamped)}%</text>
      </svg>
      <div class="radial-label">${_esc(label)}</div>
    </div>
  `;
}

// ── Heatmap grid ──────────────────────────────────────────────

const DOW  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_LABELS = ['0', '', '', '3', '', '', '6', '', '', '9', '', '', '12', '', '', '15', '', '', '18', '', '', '21', '', ''];

function _heatmapGrid(hm) {
  // hm.matrix: 7 rows (DOW 0=Mon) × 24 cols (hour 0-23)
  const matrix = hm.matrix || Array.from({ length: 7 }, () => Array(24).fill(0));
  const max = Math.max(...matrix.flat(), 1);

  let html = `<div class="heatmap" role="grid" aria-label="Power cut heatmap by hour and day">`;

  // Hour header row
  html += `<div class="heatmap-row-label"></div>`;
  HOUR_LABELS.forEach((h, i) => {
    html += `<div style="text-align:center;color:var(--text-muted);font-size:10px;padding:0 1px">${h}</div>`;
  });

  // Data rows
  DOW.forEach((day, di) => {
    html += `<div class="heatmap-row-label" role="rowheader">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const v    = (matrix[di] || [])[h] || 0;
      const alpha = max > 0 ? (v / max * 0.8 + (v > 0 ? 0.1 : 0)) : 0;
      const tip  = `${day} ${h}:00 — ${v} cut(s)`;
      html += `<div class="heatmap-cell"
                    style="background:rgba(239,68,68,${alpha.toFixed(2)})"
                    title="${_esc(tip)}"
                    role="gridcell"
                    aria-label="${_esc(tip)}"></div>`;
    }
  });

  html += '</div>';
  return html;
}

function _heatmapA11y(hm) {
  const matrix = hm?.matrix;
  if (!matrix) return 'No data available.';
  // Find peak hour
  let maxH = 0, maxV = 0;
  for (let h = 0; h < 24; h++) {
    const sum = matrix.reduce((a, row) => a + (row[h] || 0), 0);
    if (sum > maxV) { maxV = sum; maxH = h; }
  }
  if (maxV === 0) return 'No power cuts recorded in this period.';
  return `Peak cuts occur around ${maxH}:00–${maxH+1}:00 (${maxV} total at that hour across days).`;
}

// ── Weekly summary text generator ────────────────────────────

function _generateSummary(d) {
  const parts = [];

  const pc = d?.powerCuts;
  if (pc?.count != null) {
    if (pc.count === 0) {
      parts.push(`No power cuts in the last ${_range}.`);
    } else {
      parts.push(`${pc.count} power cut(s) in the last ${_range}.`);
      if (pc.longestOutageSec) parts.push(`Longest outage: ${formatDuration(pc.longestOutageSec)}.`);
    }
  }

  const rel = d?.reliability;
  if (rel?.agentAvailability != null) {
    parts.push(`Agent available ${Math.round(rel.agentAvailability)}% of the time.`);
  }

  const runway = d?.runway;
  if (runway?.secsLeft) {
    parts.push(`Current runway: about ${formatDuration(runway.secsLeft)}.`);
  }

  const dr = d?.dischargeRate;
  if (dr?.avg) {
    parts.push(`Average discharge rate: ${dr.avg.toFixed(1)}%/h.`);
  }

  return parts.length ? parts.join(' ') : `No significant events in the last ${_range}. All looks good! 🎉`;
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
