/**
 * ring-gauge.js — Animated SVG battery ring gauge component.
 *
 * Usage:
 *   const gauge = new RingGauge(containerEl);
 *   gauge.update({ percent: 72, acConnected: false, charging: false });
 */

import { gaugeColour, gaugeSeverity, powerState } from '../format.js';

const R      = 90;          // radius
const CX     = 110;         // centre x
const CY     = 110;         // centre y
const SW     = 14;          // stroke width
const CIRC   = 2 * Math.PI * R;

// Threshold angles (degrees, 0 = top)
const THRESHOLDS = [15, 20, 30, 50];

function pctToOffset(pct) {
  // Full circle = CIRC; 0% = CIRC (nothing drawn); 100% = 0
  return CIRC - (pct / 100) * CIRC;
}

function pctToAngle(pct) {
  // 0% = -90deg, 100% = 270deg
  return -90 + (pct / 100) * 360;
}

function polarToXY(angleDeg, radius) {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return {
    x: CX + radius * Math.cos(rad),
    y: CY + radius * Math.sin(rad),
  };
}

function makeTick(pct) {
  const inner = polarToXY(pctToAngle(pct), R - SW / 2 - 1);
  const outer = polarToXY(pctToAngle(pct), R + SW / 2 + 1);
  return `<line class="ring-tick" x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" />`;
}

export class RingGauge {
  constructor(container) {
    this._container = container;
    this._pct = 0;
    this._render();
  }

  _render() {
    const svgNs = 'http://www.w3.org/2000/svg';
    const wrapper = document.createElement('div');
    wrapper.className = 'hero-gauge-wrap';

    // SVG
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${CX * 2} ${CY * 2}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Battery level gauge');
    svg.classList.add('ring-gauge-svg');

    // Track
    const track = document.createElementNS(svgNs, 'circle');
    track.setAttribute('cx', CX); track.setAttribute('cy', CY); track.setAttribute('r', R);
    track.classList.add('ring-track');
    svg.appendChild(track);

    // Value arc
    const arc = document.createElementNS(svgNs, 'circle');
    arc.setAttribute('cx', CX); arc.setAttribute('cy', CY); arc.setAttribute('r', R);
    arc.setAttribute('stroke-dasharray', CIRC.toFixed(2));
    arc.setAttribute('stroke-dashoffset', CIRC.toFixed(2));
    arc.classList.add('ring-value');
    svg.appendChild(arc);

    // Threshold ticks
    THRESHOLDS.forEach(t => {
      const g = document.createElementNS(svgNs, 'g');
      g.innerHTML = makeTick(t);
      svg.appendChild(g);
    });

    this._arc = arc;
    this._svg = svg;
    wrapper.appendChild(svg);

    // Centre text
    const centre = document.createElement('div');
    centre.className = 'gauge-centre';
    centre.innerHTML = `
      <div class="gauge-pct tabnum" aria-live="polite" aria-atomic="true">—</div>
      <div class="gauge-state-text">—</div>
    `;
    this._pctEl   = centre.querySelector('.gauge-pct');
    this._stateEl = centre.querySelector('.gauge-state-text');
    wrapper.appendChild(centre);

    this._container.innerHTML = '';
    this._container.appendChild(wrapper);
  }

  /**
   * Update the gauge.
   * @param {{ percent, acConnected, charging }} reading
   */
  update({ percent, acConnected, charging }) {
    const pct    = Math.round(Math.max(0, Math.min(100, percent)));
    const colour = gaugeColour(pct, acConnected, charging);
    const sev    = gaugeSeverity(pct, acConnected, charging);
    const { text } = powerState({ percent: pct, acConnected, charging });

    // Animate arc
    this._arc.style.setProperty('stroke', colour);
    this._arc.style.setProperty('stroke-dashoffset', pctToOffset(pct).toFixed(2));
    this._svg.style.setProperty('--gauge-colour', colour);

    // Update text
    this._pctEl.textContent   = `${pct}%`;
    this._stateEl.textContent = text;

    // Card severity tint (bubble up to parent card)
    const card = this._container.closest('[data-severity]') || this._container.parentElement;
    if (card) card.setAttribute('data-severity', sev);

    this._pct = pct;
  }

  /** Show skeleton state */
  skeleton() {
    this._pctEl.textContent   = '—';
    this._stateEl.textContent = 'Loading';
    this._arc.style.setProperty('stroke-dashoffset', CIRC.toFixed(2));
  }
}
