/**
 * sparkline.js — 60-minute battery history sparkline.
 *
 * Renders a lightweight inline SVG sparkline with:
 *  - Battery % line
 *  - AC unplug/plug event markers
 *  - Hover tooltip
 *
 * No Chart.js dependency — keeps bundle small.
 */

export class Sparkline {
  constructor(container) {
    this._container = container;
    this._data = [];
    this._events = [];
    this._svg = null;
    this._tooltip = null;
    this._init();
  }

  _init() {
    this._container.innerHTML = '';
    this._container.style.position = 'relative';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 400 64');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width  = '100%';
    svg.style.height = '100%';
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '60-minute battery history');
    this._svg = svg;
    this._container.appendChild(svg);

    // Tooltip
    const tt = document.createElement('div');
    tt.className = 'sparkline-tooltip';
    tt.style.cssText = `
      position: absolute; display: none;
      background: var(--bg-elevated); border: 1px solid var(--border-default);
      border-radius: var(--radius-sm); padding: 4px 8px;
      font-size: var(--text-xs); color: var(--text-primary);
      pointer-events: none; white-space: nowrap;
      transform: translate(-50%, -110%);
    `;
    this._container.appendChild(tt);
    this._tooltip = tt;

    svg.addEventListener('mousemove', e => this._onHover(e));
    svg.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
    svg.addEventListener('touchend', () => { tt.style.display = 'none'; });
  }

  /**
   * Update the sparkline.
   * @param {Array<{deviceTime, percent, acConnected}>} readings
   * @param {Array<{deviceTime, event}>} events  — ac_connected / ac_disconnected
   */
  update(readings, events = []) {
    if (!readings || readings.length === 0) {
      this._renderEmpty();
      return;
    }
    this._data   = readings;
    this._events = events;
    this._render();
  }

  _render() {
    const { _data: data, _events: events, _svg: svg } = this;
    svg.innerHTML = '';

    const W = 400, H = 64;
    const PAD = 4;

    if (data.length < 2) { this._renderEmpty(); return; }

    const times = data.map(d => new Date(d.deviceTime).getTime());
    const tMin  = times[0], tMax = times[times.length - 1];
    const tRange = tMax - tMin || 1;

    function tx(ts) { return PAD + ((ts - tMin) / tRange) * (W - PAD * 2); }
    function ty(pct) { return H - PAD - ((pct / 100) * (H - PAD * 2)); }

    // Gradient fill under line
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="spk-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--c-ok)" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="var(--c-ok)" stop-opacity="0"/>
      </linearGradient>
    `;
    svg.appendChild(defs);

    // Area path
    let area  = `M ${tx(times[0]).toFixed(1)} ${H} `;
    let line  = `M ${tx(times[0]).toFixed(1)} ${ty(data[0].percent).toFixed(1)} `;
    for (let i = 0; i < data.length; i++) {
      const x = tx(times[i]).toFixed(1);
      const y = ty(data[i].percent).toFixed(1);
      if (i === 0) { area += `L ${x} ${y} `; }
      else { line += `L ${x} ${y} `; area += `L ${x} ${y} `; }
    }
    area += `L ${tx(times[times.length-1]).toFixed(1)} ${H} Z`;

    const areaEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    areaEl.setAttribute('d', area);
    areaEl.setAttribute('fill', 'url(#spk-grad)');
    svg.appendChild(areaEl);

    const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    lineEl.setAttribute('d', line);
    lineEl.setAttribute('fill', 'none');
    lineEl.setAttribute('stroke', 'var(--c-ok)');
    lineEl.setAttribute('stroke-width', '2');
    lineEl.setAttribute('stroke-linejoin', 'round');
    lineEl.setAttribute('stroke-linecap', 'round');
    svg.appendChild(lineEl);

    // Event markers
    events.forEach(ev => {
      const ts = new Date(ev.deviceTime).getTime();
      if (ts < tMin || ts > tMax) return;
      const x = tx(ts).toFixed(1);
      const isPlug = ev.event === 'ac_connected';

      const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line2.setAttribute('x1', x); line2.setAttribute('x2', x);
      line2.setAttribute('y1', PAD); line2.setAttribute('y2', H - PAD);
      line2.setAttribute('stroke', isPlug ? 'var(--c-ok)' : 'var(--c-warning)');
      line2.setAttribute('stroke-width', '1.5');
      line2.setAttribute('stroke-dasharray', '3 2');
      svg.appendChild(line2);

      // Small label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', PAD + 8);
      text.setAttribute('font-size', '8');
      text.setAttribute('fill', isPlug ? 'var(--c-ok)' : 'var(--c-warning)');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = isPlug ? '⚡' : '↓';
      svg.appendChild(text);
    });

    // Interaction overlay (invisible wide hit areas)
    this._hitData = data.map((d, i) => ({ x: tx(times[i]), y: ty(d.percent), d }));
  }

  _renderEmpty() {
    const { _svg: svg } = this;
    svg.innerHTML = `
      <text x="200" y="36" text-anchor="middle" font-size="11"
        fill="var(--text-muted)">No history yet</text>
    `;
    this._hitData = [];
  }

  _onHover(e) {
    if (!this._hitData?.length) return;
    const rect  = this._svg.getBoundingClientRect();
    const svgW  = rect.width;
    const mouseX = e.clientX - rect.left;
    const frac  = mouseX / svgW;
    const idx   = Math.round(frac * (this._hitData.length - 1));
    const hit   = this._hitData[Math.max(0, Math.min(idx, this._hitData.length - 1))];
    if (!hit) return;

    const t = new Date(hit.d.deviceTime);
    const timeStr = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    this._tooltip.textContent = `${timeStr} — ${Math.round(hit.d.percent)}%`;
    this._tooltip.style.display = 'block';
    this._tooltip.style.left = `${(mouseX / svgW * 100).toFixed(1)}%`;
    this._tooltip.style.top  = '0';
  }
}
