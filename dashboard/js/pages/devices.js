/**
 * devices.js — Devices page controller.
 *
 * Lists all devices; add-device 3-step wizard;
 * per-device: rename, pause/resume alerts, rotate token, delete.
 */

import { store }   from '../store.js';
import { devices as devicesApi, auth } from '../api.js';
import { notify }  from '../notify.js';
import { timeAgo, formatDateTime } from '../format.js';
import { S }       from '../strings.js';

// ── State ─────────────────────────────────────────────────────

let _wizardOpen   = false;
let _wizardStep   = 1;          // 1 = name, 2 = token, 3 = waiting
let _wizardDevice = null;       // { _id, name, token }
let _heartbeatPoll = null;
let _initDone     = false;

// ── Init ──────────────────────────────────────────────────────

export function initDevicesPage() {
  if (!_initDone) {
    _initDone = true;
    _wireAddButton();
    _wireWizard();
  }
  _loadDevices();
}

export function destroyDevicesPage() {
  _stopHeartbeatPoll();
  _initDone = false;
}

// ── Load & render devices ─────────────────────────────────────

async function _loadDevices() {
  const container = document.getElementById('devices-main-list');
  if (!container) return;

  container.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:12px"></div>'.repeat(2);

  try {
    const res   = await devicesApi.list();
    const list  = res?.devices || res || [];
    store.set('devices', list);
    _renderDevices(list);

    // Update switcher in topbar
    const sel = document.getElementById('device-select');
    if (sel) {
      const active = store.get('deviceId');
      sel.innerHTML = list.map(d =>
        `<option value="${d._id}" ${d._id === active ? 'selected' : ''}>${_esc(d.name || d._id)}</option>`
      ).join('');
      sel.closest('#device-switcher-wrap')?.style && (sel.closest('#device-switcher-wrap').style.display = list.length > 1 ? '' : 'none');
    }

    // Onboarding: if no devices, show add wizard automatically
    if (!list.length) {
      _showOnboardingHint();
    }
  } catch (err) {
    container.innerHTML = `<div class="error-state"><div class="error-icon">⚠️</div><h3>Failed to load</h3><p>${_esc(err.message)}</p></div>`;
  }
}

function _renderDevices(list) {
  const container = document.getElementById('devices-main-list');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💻</div>
        <h3>${S.noDevices}</h3>
        <p>${S.noDevicesHint}</p>
      </div>`;
    return;
  }

  container.innerHTML = list.map(d => _deviceCardHTML(d)).join('');
  _wireDeviceActions(container, list);
  _renderInstallInstructions();
}

function _deviceCardHTML(d) {
  const r   = d.latestReading || {};
  const online = d.online || d.deviceStatus === 'online';
  const statusColor = online ? 'var(--c-ok)' : 'var(--c-unknown)';
  const statusLabel = online ? 'Online' : d.deviceStatus === 'stale' ? 'Stale' : 'Offline';
  const pct  = r.percent != null ? `${Math.round(r.percent)}%` : '—';
  const ac   = r.acConnected != null ? (r.acConnected ? '🔌 AC' : '🔋 Battery') : '—';
  const mt5  = r.mt5Running != null ? (r.mt5Running ? '📈 On' : '📉 Off') : '—';

  const agentVer   = d.agentVersion || '—';
  const latestVer  = store.get('latestAgentVersion');
  const needsUpdate = latestVer && agentVer !== '—' && agentVer !== latestVer;

  const paused = d.alertsPaused;

  return `
    <div class="device-detail-card" data-device-id="${d._id}">
      <div class="device-detail-header">
        <span class="device-status-dot" style="background:${statusColor}"></span>
        <div>
          <div class="device-detail-name">${_esc(d.name || d._id)}</div>
          <div class="device-detail-meta">
            ${_esc(d.hostname || '')}
            ${d.windowsVersion ? ` · Windows ${_esc(d.windowsVersion)}` : ''}
            · Agent ${_esc(agentVer)}
            ${needsUpdate ? `<span class="pill pill-warning" style="margin-left:4px">${S.updateAvailable}</span>` : ''}
            ${paused ? `<span class="pill pill-critical" style="margin-left:4px">Alerts paused</span>` : ''}
          </div>
        </div>
        <span class="pill ${online ? 'pill-ok' : 'pill-unknown'}" style="margin-left:auto">${statusLabel}</span>
      </div>

      <div class="device-snapshot">
        <div class="device-snap-item">
          <div class="device-snap-val tabnum">${pct}</div>
          <div class="device-snap-lbl">Battery</div>
        </div>
        <div class="device-snap-item">
          <div class="device-snap-val">${ac}</div>
          <div class="device-snap-lbl">Power</div>
        </div>
        <div class="device-snap-item">
          <div class="device-snap-val">${mt5}</div>
          <div class="device-snap-lbl">MT5</div>
        </div>
        <div class="device-snap-item">
          <div class="device-snap-val" style="font-size:var(--text-sm)">${d.lastSeenAt ? timeAgo(d.lastSeenAt) : '—'}</div>
          <div class="device-snap-lbl">Last seen</div>
        </div>
      </div>

      <div class="device-actions">
        <button class="btn btn-ghost btn-sm" data-rename="${d._id}" data-name="${_esc(d.name || '')}">✏ Rename</button>
        <button class="btn btn-ghost btn-sm" data-pause="${d._id}" data-paused="${paused ? '1' : '0'}">
          ${paused ? `▶ ${S.resumeAlerts}` : `⏸ ${S.pauseAlerts}`}
        </button>
        <button class="btn btn-ghost btn-sm" data-rotate="${d._id}">🔑 Rotate token</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--c-critical)" data-delete-device="${d._id}" data-name="${_esc(d.name || '')}">🗑 Delete</button>
      </div>
    </div>
  `;
}

// ── Device actions ────────────────────────────────────────────

function _wireDeviceActions(container, list) {
  // Rename
  container.querySelectorAll('[data-rename]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.rename;
      const name = prompt(S.renameDevice + ':', btn.dataset.name);
      if (!name?.trim()) return;
      try {
        await devicesApi.update(id, { name: name.trim() });
        notify.toast({ title: 'Device renamed', severity: 'ok', duration: 2000 });
        _loadDevices();
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });

  // Pause / Resume alerts
  container.querySelectorAll('[data-pause]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id     = btn.dataset.pause;
      const paused = btn.dataset.paused === '1';
      const action = paused ? 'resume' : 'pause';

      if (!paused && !confirm(`${S.pauseAlerts} for this device? Alerts will not fire until resumed.`)) return;

      try {
        await devicesApi.update(id, { alertsPaused: !paused });
        document.body.classList.toggle('alerts-paused', !paused);
        notify.toast({ title: paused ? 'Alerts resumed' : 'Alerts paused', severity: 'info', duration: 3000 });
        _loadDevices();
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });

  // Rotate token
  container.querySelectorAll('[data-rotate]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(S.rotateConfirm)) return;
      try {
        const res = await devicesApi.rotateToken(btn.dataset.rotate);
        _showTokenOnce(res.token, S.rotateWarning);
        _loadDevices();
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });

  // Delete device
  container.querySelectorAll('[data-delete-device]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id   = btn.dataset.deleteDevice;
      const name = btn.dataset.name;
      _confirmDestructive({
        title:    S.deleteDevice,
        desc:     S.deleteDeviceWarn,
        confirmText: name,
        confirmHint: S.deleteDeviceConfirm,
        danger:   true,
        onConfirm: async () => {
          try {
            await devicesApi.delete(id);
            notify.toast({ title: 'Device deleted', severity: 'ok', duration: 3000 });
            _loadDevices();
          } catch (e) {
            notify.toast({ title: S.error, message: e.message, severity: 'warning' });
          }
        },
      });
    });
  });
}

// ── Show token once ───────────────────────────────────────────

function _showTokenOnce(token, headingText = S.stepTokenWarning) {
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.innerHTML = `
    <div class="confirm-modal-box">
      <div class="confirm-modal-title">${S.stepToken}</div>
      <div class="token-warning">⚠️ ${headingText}</div>
      <div class="token-display" id="token-once-display">${_esc(token)}</div>
      <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-4)">
        <button class="btn btn-ghost btn-sm" id="token-once-copy">${S.stepTokenCopy}</button>
        <button class="btn btn-ghost btn-sm" id="token-once-dl">${S.stepConfigDl}</button>
      </div>
      <div class="confirm-modal-actions">
        <button class="btn btn-primary" id="token-once-close">${S.stepTokenNext}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#token-once-copy')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(token);
    modal.querySelector('#token-once-copy').textContent = S.copied;
  });

  modal.querySelector('#token-once-dl')?.addEventListener('click', () => {
    _downloadConfig(token);
  });

  modal.querySelector('#token-once-close')?.addEventListener('click', () => {
    modal.remove();
  });
}

function _downloadConfig(token) {
  const config = {
    apiUrl: window.VOLTWATCH_API || '/api/v1',
    token,
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'voltwatch-config.json';
  a.click();
}

// ── Add device wizard ─────────────────────────────────────────

function _wireAddButton() {
  document.getElementById('btn-add-device')?.addEventListener('click', _openWizard);
}

function _wireWizard() {
  document.getElementById('wizard-cancel')?.addEventListener('click', _closeWizard);
  document.getElementById('wizard-step1-submit')?.addEventListener('click', _wizardStep1);
  document.getElementById('wizard-step2-next')?.addEventListener('click', _wizardStep2Next);
  document.getElementById('wizard-step2-copy')?.addEventListener('click', () => {
    if (_wizardDevice?.token) {
      navigator.clipboard?.writeText(_wizardDevice.token);
      document.getElementById('wizard-step2-copy').textContent = S.copied;
      setTimeout(() => { document.getElementById('wizard-step2-copy').textContent = S.stepTokenCopy; }, 2000);
    }
  });
  document.getElementById('wizard-step2-dl')?.addEventListener('click', () => {
    if (_wizardDevice?.token) _downloadConfig(_wizardDevice.token);
  });
  document.getElementById('wizard-step3-done')?.addEventListener('click', _closeWizard);
  document.getElementById('wizard-step3-goLive')?.addEventListener('click', () => {
    _closeWizard();
    window.location.hash = '#/live';
  });
}

function _openWizard() {
  _wizardStep = 1;
  _wizardDevice = null;
  _stopHeartbeatPoll();
  document.getElementById('devices-wizard')?.classList.add('open');
  document.getElementById('devices-wizard-backdrop')?.classList.add('visible');
  const nameInput = document.getElementById('wizard-name-input');
  if (nameInput) nameInput.value = '';
  document.getElementById('wizard-name-error')?.replaceChildren();
  _showWizardStep(1);
}

function _closeWizard() {
  _stopHeartbeatPoll();
  document.getElementById('devices-wizard')?.classList.remove('open');
  document.getElementById('devices-wizard-backdrop')?.classList.remove('visible');
}

function _showWizardStep(n) {
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById(`wizard-step-${i}`);
    if (!el) continue;
    const show = i === n;
    el.style.display = show ? '' : 'none';
    el.classList.toggle('active', show);
  }
  // Step indicator dots
  document.querySelectorAll('.wizard-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i + 1 === n);
    dot.classList.toggle('done', i + 1 < n);
  });
}

async function _wizardStep1() {
  const name = document.getElementById('wizard-name-input')?.value.trim();
  if (!name) {
    document.getElementById('wizard-name-error').textContent = 'Please enter a name.';
    return;
  }
  document.getElementById('wizard-name-error').textContent = '';
  const btn = document.getElementById('wizard-step1-submit');
  btn.classList.add('loading');

  try {
    const res = await devicesApi.create({ name });
    _wizardDevice = res.device || res;

    // Show token once in step 2
    document.getElementById('wizard-token-display').textContent = _wizardDevice.token || '(not returned)';
    _wizardStep = 2;
    _showWizardStep(2);
  } catch (e) {
    document.getElementById('wizard-name-error').textContent = e.message || S.error;
  } finally {
    btn.classList.remove('loading');
  }
}

function _wizardStep2Next() {
  // Clear token from DOM after user confirms they've saved it
  document.getElementById('wizard-token-display').textContent = '••••••••••••••';
  _wizardDevice = { ..._wizardDevice, token: null }; // clear from memory
  _wizardStep = 3;
  _showWizardStep(3);
  _startHeartbeatPoll();
}

// Poll until first heartbeat
function _startHeartbeatPoll() {
  const deviceId = _wizardDevice?._id;
  if (!deviceId) return;

  const indicator = document.getElementById('wizard-waiting-indicator');

  _heartbeatPoll = setInterval(async () => {
    try {
      const res = await devicesApi.get(deviceId);
      if (res?.lastSeenAt) {
        _stopHeartbeatPoll();
        // Success!
        if (indicator) {
          indicator.innerHTML = `
            <div class="spinner-ring success">✅</div>
            <div style="font-weight:700;color:var(--c-ok);font-size:var(--text-lg)">${S.stepSuccess}</div>
            <div style="color:var(--text-muted);font-size:var(--text-sm)">${S.stepSuccessHint}</div>
          `;
        }
        document.getElementById('wizard-step3-done').style.display = '';
        document.getElementById('wizard-step3-goLive').style.display = '';
        notify.toast({ title: 'Device connected!', message: 'First heartbeat received.', severity: 'ok', duration: 4000 });
        _loadDevices();
      }
    } catch { /* keep polling */ }
  }, 3000);
}

function _stopHeartbeatPoll() {
  if (_heartbeatPoll) { clearInterval(_heartbeatPoll); _heartbeatPoll = null; }
}

// ── Install instructions ──────────────────────────────────────

function _renderInstallInstructions() {
  const el = document.getElementById('install-instructions-card');
  if (!el) return;
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:var(--space-3)">${S.installInstructions}</div>
    <div class="install-card">
      ${[S.installStep1, S.installStep2, S.installStep3, S.installStep4, S.installStep5].map(s => `
        <div class="install-step">
          <span style="flex-shrink:0">📌</span>
          <span>${_esc(s)}</span>
        </div>`).join('')}
      <div class="install-step" style="color:var(--c-info)">
        <span>💡</span><span>${_esc(S.installStopNote)}</span>
      </div>
    </div>
  `;
}

// ── Destructive confirm modal ─────────────────────────────────

function _confirmDestructive({ title, desc, confirmText, confirmHint, danger, onConfirm }) {
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'cmodal-title');

  const needsTyping = !!confirmText;

  modal.innerHTML = `
    <div class="confirm-modal-box">
      <div class="confirm-modal-title" id="cmodal-title">${_esc(title)}</div>
      <div class="confirm-modal-desc">${_esc(desc)}</div>
      ${needsTyping ? `
        <div style="margin-bottom:var(--space-4)">
          <div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-2)">${_esc(confirmHint || 'Type to confirm:')}</div>
          <input class="form-control" id="cmodal-confirm-input" placeholder="${_esc(confirmText)}" autocomplete="off" />
        </div>
      ` : ''}
      <div class="confirm-modal-actions">
        <button class="btn btn-ghost" id="cmodal-cancel">${S.cancel}</button>
        <button class="btn" id="cmodal-ok"
          style="${danger ? 'background:var(--c-critical);color:#fff' : ''}"
          ${needsTyping ? 'disabled' : ''}
        >${danger ? '⚠️ ' : ''}${S.confirm}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const input  = modal.querySelector('#cmodal-confirm-input');
  const okBtn  = modal.querySelector('#cmodal-ok');
  const cancel = modal.querySelector('#cmodal-cancel');

  if (input && needsTyping) {
    input.addEventListener('input', () => {
      okBtn.disabled = input.value !== confirmText;
    });
    input.focus();
  } else {
    okBtn?.focus();
  }

  cancel?.addEventListener('click', () => modal.remove());
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
  okBtn?.addEventListener('click', async () => {
    okBtn.disabled = true;
    okBtn.classList.add('loading');
    await onConfirm();
    modal.remove();
  });
}

// ── Onboarding hint ───────────────────────────────────────────

function _showOnboardingHint() {
  const el = document.getElementById('devices-onboard-hint');
  if (el) el.style.display = '';
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
