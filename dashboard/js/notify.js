/**
 * notify.js — Toast notifications and aria-live announcements.
 *
 * Usage:
 *   notify.toast({ title, message, severity, duration, persistent, actions })
 *   notify.announce(text, assertive?)
 *
 * actions: Array of { label, onClick } rendered as buttons inside the toast.
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
   * @param {{ title, message, severity, duration, persistent, actions }} opts
   *   actions — optional array of { label: string, onClick: fn } action buttons
   */
  toast({ title, message, severity = 'info', duration = DEFAULT_DURATION, persistent = false, actions = [] } = {}) {
    const container = _getContainer();
    if (!container) return;

    const hasActions = Array.isArray(actions) && actions.length > 0;
    // Toasts with action buttons stay until the user acts or dismisses them
    const isPersistent = persistent || hasActions;

    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', severity === 'critical' ? 'assertive' : 'polite');
    el.setAttribute('data-severity', severity);

    const actionsHTML = hasActions
      ? `<div class="toast-actions">${actions.map((a, i) =>
          `<button class="btn btn-ghost btn-sm toast-action-btn" data-action-idx="${i}">${_esc(a.label)}</button>`
        ).join('')}</div>`
      : '';

    el.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${SEVERITIES[severity] || 'ℹ️'}</span>
      <div class="toast-body">
        ${title   ? `<div class="toast-title">${_esc(title)}</div>`   : ''}
        ${message ? `<div class="toast-msg">${_esc(message)}</div>` : ''}
        ${actionsHTML}
      </div>
      <button class="toast-close" aria-label="Dismiss">✕</button>
    `;

    const dismiss = () => _dismiss(el);

    // Wire close button
    el.querySelector('.toast-close')?.addEventListener('click', dismiss);

    // Wire action buttons
    if (hasActions) {
      el.querySelectorAll('.toast-action-btn').forEach(btn => {
        const idx = parseInt(btn.dataset.actionIdx, 10);
        btn.addEventListener('click', () => {
          dismiss();
          actions[idx]?.onClick?.();
        });
      });
    }

    container.appendChild(el);

    // Play sound
    if (severity === 'warning' || severity === 'info') sound.playChime().catch(() => {});

    if (!isPersistent) {
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
