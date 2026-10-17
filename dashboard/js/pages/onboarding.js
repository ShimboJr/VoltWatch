/**
 * onboarding.js — First-login guided setup flow.
 *
 * Shows a checklist card when the owner has no device.
 * Each step links to the correct screen / action.
 * Progress is persisted in localStorage so they can resume.
 * Dismissable after all steps complete.
 */

import { store }  from '../store.js';
import { router } from '../router.js';
import { S }      from '../strings.js';

const STORAGE_KEY = 'vw-onboard-progress';

const STEPS = [
  {
    id:      'create_device',
    title:   S.onboardStep1Title,
    hint:    'Head to Devices → Add device to get your token.',
    action:  () => router.go('#/devices'),
    actionLabel: 'Go to Devices →',
    check:   () => (store.get('devices') || []).length > 0,
  },
  {
    id:      'install_agent',
    title:   S.onboardStep2Title,
    hint:    'Install the agent on your Windows trading laptop and paste your token.',
    action:  null,
    actionLabel: null,
    check:   () => {
      const devs = store.get('devices') || [];
      return devs.some(d => d.agentVersion);
    },
  },
  {
    id:      'first_heartbeat',
    title:   S.onboardStep3Title,
    hint:    'Run the agent — a green tick will appear here within 30 seconds.',
    action:  null,
    actionLabel: null,
    check:   () => {
      const devs = store.get('devices') || [];
      return devs.some(d => d.lastSeenAt);
    },
  },
  {
    id:      'test_alarm',
    title:   S.onboardStep4Title,
    hint:    'Go to Alerts → Test alarm to verify sound, vibration and takeover.',
    action:  () => router.go('#/alerts'),
    actionLabel: 'Test alarm →',
    check:   () => localStorage.getItem('vw-alarm-tested') === '1',
  },
  {
    id:      'set_thresholds',
    title:   S.onboardStep5Title,
    hint:    'Go to Settings → Battery alerts to configure when you want to be notified.',
    action:  () => router.go('#/settings'),
    actionLabel: 'Open Settings →',
    check:   () => localStorage.getItem('vw-thresholds-set') === '1',
  },
];

// ── Public API ────────────────────────────────────────────────

export function shouldShowOnboarding() {
  if (localStorage.getItem('vw-onboard-dismissed') === '1') return false;
  // Show if any step is not yet complete
  return STEPS.some(s => !s.check());
}

export function renderOnboardingCard(container) {
  if (!container) return;
  if (!shouldShowOnboarding()) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  container.innerHTML = _buildCard();
  _wireCard(container);
}

export function refreshOnboardingCard(container) {
  if (!container) return;
  if (!shouldShowOnboarding()) {
    container.style.display = 'none';
    return;
  }
  renderOnboardingCard(container);
}

// ── Build HTML ────────────────────────────────────────────────

function _buildCard() {
  const steps = STEPS.map((s, i) => {
    const done    = s.check();
    const current = !done && STEPS.slice(0, i).every(prev => prev.check());
    const cls     = done ? 'done' : current ? 'current' : '';
    const num     = done ? '✓' : String(i + 1);

    return `
      <li class="onboard-step ${cls}" role="listitem">
        <div class="onboard-step-num" aria-hidden="true">${num}</div>
        <div style="flex:1">
          <div class="onboard-step-title">${_esc(s.title)}</div>
          ${!done ? `<div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px">${_esc(s.hint)}</div>` : ''}
          ${current && s.action ? `<button class="btn btn-ghost btn-sm" style="margin-top:var(--space-2)" data-onboard-action="${i}">${_esc(s.actionLabel)}</button>` : ''}
        </div>
      </li>
    `;
  }).join('');

  const allDone = STEPS.every(s => s.check());

  return `
    <div class="onboard-card" role="region" aria-label="Setup checklist">
      <div class="onboard-brand">⚡ VoltWatch</div>
      <div style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--space-2)">
        ${allDone ? '🎉 All set! Your trading laptop is monitored.' : S.onboardingSubtitle}
      </div>
      <ul class="onboard-steps" role="list">
        ${steps}
      </ul>
      <div style="display:flex;justify-content:flex-end;margin-top:var(--space-3)">
        <button class="btn btn-ghost btn-sm" id="onboard-dismiss">${allDone ? '✓ ' : ''}${S.onboardDismiss}</button>
      </div>
    </div>
  `;
}

// ── Wire ──────────────────────────────────────────────────────

function _wireCard(container) {
  container.querySelector('#onboard-dismiss')?.addEventListener('click', () => {
    localStorage.setItem('vw-onboard-dismissed', '1');
    container.style.display = 'none';
  });

  container.querySelectorAll('[data-onboard-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.onboardAction);
      STEPS[idx]?.action?.();
    });
  });
}

// ── Refresh on store changes ──────────────────────────────────

export function subscribeOnboarding(container) {
  store.subscribe('devices', () => refreshOnboardingCard(container));
  store.subscribe('status',  () => refreshOnboardingCard(container));
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
