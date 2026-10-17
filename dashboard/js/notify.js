/**
 * notify.js — Toast notifications and aria-live announcements.
 *
 * Usage:
 *   notify.toast({ title, message, severity, duration })
 *   notify.announce(text, assertive?)
 */

import { sound } from './sound.js';

const SEVERITIES = { critical: '🔴', warning: '⚠️', info: 'ℹ️', ok: '✅', unknown: '📡' };
const DEFAULT_DURATION = 5000;

let _container = null;

function _getContainer() {
  if (!_container) {
    _container = document.getElementById('toast-container');
  }
  return _container;
}

export const notify = {
  /**
   * Show a toast notification.
   *
   * @param {{ title, message, severity, duration, persistent }} opts
   */
  toast({ title, message, severity = 'info', duration = DEFAULT_DURATION, persistent = false } = {}) {
    const container = _getContainer();
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', severity === 'critical' ? 'assertive' : 'polite');
    el.setAttribute('data-severity', severity);

    el.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${SEVERITIES[severity] || 'ℹ️'}</span>
      <div class="toast-body">
        ${title ? `<div class="toast-title">${_esc(title)}</div>` : ''}
        ${message ? `<div class="toast-msg">${_esc(message)}</div>` : ''}
      </div>
      ${!persistent ? `<button class="toast-close" aria-label="Dismiss">✕</button>` : ''}
    `;

    const close = el.querySelector('.toast-close');
    const dismiss = () => _dismiss(el);
    if (close) close.addEventListener('click', dismiss);

    container.appendChild(el);

    // Play sound
    if (severity === 'warning' || severity === 'info') sound.playChime().catch(() => {});

    if (!persistent) {
      setTimeout(dismiss, duration);
    }

    // Announce to screen readers
    this.announce(
      `${title || ''}${message ? ': ' + message : ''}`,
      severity === 'critical',
    );

    return { dismiss };
  },

  /**
   * Announce text to screen readers via aria-live regions.
   *
   * @param {string}  text
   * @param {boolean} assertive  — use assertive region (default: polite)
   */
  announce(text, assertive = false) {
    const id = assertive ? 'aria-live-assertive' : 'aria-live-polite';
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    // Force re-read by toggling content
    requestAnimationFrame(() => { el.textContent = text; });
  },
};

function _dismiss(el) {
  el.classList.add('removing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  // Fallback in case animation doesn't fire
  setTimeout(() => el.remove(), 400);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
