/**
 * settings.js — Full settings page controller.
 *
 * Auto-saving: each section calls PATCH /settings debounced.
 * Optimistic UI: shows "Saved" on success, "Error" on failure.
 * All strings from strings.js.
 */

import { store }   from '../store.js';
import { settings as settingsApi, auth } from '../api.js';
import { sound }   from '../sound.js';
import { notify }  from '../notify.js';
import { S }       from '../strings.js';
import {
  isPushSupported, isIOS, isInstalled, canInstall,
  getPermissionState, subscribe, unsubscribe,
  listSubscriptions, removeSubscription, sendTestPush,
  showIOSInstallGuide, triggerInstall,
} from '../push.js';

// ── State ─────────────────────────────────────────────────────

let _cfg      = {};
let _saveTimer = null;
let _initDone  = false;

// ── Init ──────────────────────────────────────────────────────

export function initSettingsPage() {
  if (!_initDone) {
    _initDone = true;
    _buildSections();
    _wireSecuritySection();
    _wireDataSection();
    _wirePushSection();
  }
  _loadSettings();
}

export function destroySettingsPage() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _initDone = false;
}

// ── Load ──────────────────────────────────────────────────────

async function _loadSettings() {
  try {
    const res = await settingsApi.get();
    _cfg = res?.settings || res || {};
    store.set('settings', _cfg);
    _populateAll();
  } catch (err) {
    notify.toast({ title: 'Failed to load settings', message: err.message, severity: 'warning' });
  }
}

// ── Build static section markup ───────────────────────────────

function _buildSections() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  container.innerHTML = `
    ${_sectionHTML(S.secBatteryAlerts, 'settings-battery-section', `
      <div class="settings-card" style="padding:var(--space-4)">
        <div class="settings-row2-lbl-title" style="margin-bottom:var(--space-2)">${S.thresholdsLabel}</div>
        <div class="settings-row2-lbl-desc" style="margin-bottom:var(--space-3)">${S.thresholdsHint}</div>
        <div class="threshold-chips" id="threshold-chips-display"></div>
        <div class="threshold-add" style="margin-top:var(--space-3)">
          <input class="form-control" type="number" id="threshold-add-input"
                 min="1" max="99" placeholder="e.g. 25" style="width:90px"
                 aria-label="${S.addThreshold}" />
          <button class="btn btn-ghost btn-sm" id="threshold-add-btn">${S.addThreshold}</button>
          <div class="save-feedback" id="threshold-feedback"></div>
        </div>
        <div class="settings-row2" style="margin-top:var(--space-3);border-top:1px solid var(--border-subtle);padding-top:var(--space-3)">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.criticalLevelLabel}</div>
            <div class="settings-row2-lbl-desc">${S.criticalLevelHint}</div>
          </div>
          <div class="settings-row2-ctrl">
            <input class="form-control" type="number" id="setting-critical-level"
                   min="1" max="50" style="width:70px" aria-label="${S.criticalLevelLabel}" />
            <span>%</span>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.repeatIntervalLabel}</div>
            <div class="settings-row2-lbl-desc">${S.repeatIntervalHint}</div>
          </div>
          <div class="settings-row2-ctrl">
            <input class="form-control" type="number" id="setting-critical-repeat"
                   min="0" max="60" style="width:70px" aria-label="${S.repeatIntervalLabel}" />
            <span>min</span>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secConnection, 'settings-connection-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.heartbeatLabel}</div>
          </div>
          <div class="settings-row2-ctrl" style="flex-direction:column;align-items:flex-end">
            <div class="range-row">
              <input type="range" id="setting-heartbeat" min="30" max="60" step="5"
                     aria-label="${S.heartbeatLabel}" style="width:120px" />
              <span class="range-val" id="setting-heartbeat-val">30${S.heartbeatUnit}</span>
            </div>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.offlineTimeoutLabel}</div>
            <div class="range-preview" id="offline-preview"></div>
          </div>
          <div class="settings-row2-ctrl" style="flex-direction:column;align-items:flex-end">
            <div class="range-row">
              <input type="range" id="setting-offline-timeout" min="60" max="900" step="60"
                     aria-label="${S.offlineTimeoutLabel}" style="width:120px" />
              <span class="range-val" id="setting-offline-val">3min</span>
            </div>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secMt5, 'settings-mt5-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.mt5AlertLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <label class="toggle-switch" aria-label="${S.mt5AlertLabel}">
              <input type="checkbox" id="setting-mt5-alert" role="switch" />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.mt5DebounceLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <input class="form-control" type="number" id="setting-mt5-debounce"
                   min="5" max="300" style="width:70px" aria-label="${S.mt5DebounceLabel}" />
            <span>${S.mt5DebounceUnit}</span>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secQuietHours, 'settings-quiet-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.quietHoursLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <label class="toggle-switch">
              <input type="checkbox" id="setting-quiet-enabled" role="switch" />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="settings-row2" id="quiet-time-row">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.quietStartLabel} → ${S.quietEndLabel}</div>
            <div class="settings-row2-lbl-desc" style="color:var(--c-warning)">${S.quietHoursCritWarn}</div>
          </div>
          <div class="settings-row2-ctrl" style="gap:var(--space-1)">
            <input class="form-control" type="time" id="setting-quiet-start" style="width:110px" />
            <span style="color:var(--text-muted)">→</span>
            <input class="form-control" type="time" id="setting-quiet-end"   style="width:110px" />
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secAlarm, 'settings-alarm-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.volumeLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <input type="range" id="setting-alarm-volume" min="0" max="100" style="width:100px"
                   aria-label="${S.volumeLabel}" />
            <span class="range-val" id="setting-alarm-volume-val">80%</span>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.vibrationLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <label class="toggle-switch">
              <input type="checkbox" id="setting-vibration" role="switch" />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.armSoundLabel}</div>
            <div class="settings-row2-lbl-desc">${S.armSoundHint}</div>
          </div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" id="setting-arm-sound">🔔 Arm</button>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.wakeDefaultLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <label class="toggle-switch">
              <input type="checkbox" id="setting-wake-default" role="switch" />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secAppearance, 'settings-appearance-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">${S.themeLabel}</div></div>
          <div class="settings-row2-ctrl">
            <select class="form-control" id="setting-theme" style="width:auto;padding:6px 10px">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="amoled">AMOLED Black</option>
            </select>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">${S.timezoneLabel}</div></div>
          <div class="settings-row2-ctrl">
            <select class="form-control" id="setting-tz" style="width:auto;padding:6px 10px;max-width:180px">
              ${_tzOptions()}
            </select>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">${S.timeFormatLabel}</div></div>
          <div class="settings-row2-ctrl">
            <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--text-sm)">
              <input type="radio" name="time-fmt" id="setting-time-12" value="12" /> ${S.timeFormat12}
            </label>
            <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--text-sm);margin-left:var(--space-3)">
              <input type="radio" name="time-fmt" id="setting-time-24" value="24" /> ${S.timeFormat24}
            </label>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secData, 'settings-data-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.retentionLabel}</div>
          </div>
          <div class="settings-row2-ctrl">
            <input class="form-control" type="number" id="setting-retention"
                   min="1" max="365" style="width:70px" />
            <span>${S.retentionUnit}</span>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Export history</div></div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" id="setting-export-csv">${S.exportCSV}</button>
            <button class="btn btn-ghost btn-sm" id="setting-export-json">${S.exportJSON}</button>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title" style="color:var(--c-critical)">${S.deleteHistory}</div>
          </div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" style="color:var(--c-critical)" id="setting-delete-history">${S.deleteHistory}</button>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secSecurity, 'settings-security-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">${S.changePassword}</div></div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" id="setting-change-pw">${S.changePassword}</button>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">${S.signOutEverywhere}</div></div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" style="color:var(--c-critical)" id="setting-sign-out-all">${S.signOutEverywhere}</button>
          </div>
        </div>
        <div class="settings-row2" id="session-info-row">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">${S.sessionInfo}</div>
            <div class="settings-row2-lbl-desc" id="session-info-text">Loading…</div>
          </div>
        </div>
      </div>
    `)}

    ${_sectionHTML(S.secAbout, 'settings-about-section', `
      <div class="settings-card">
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Dashboard version</div></div>
          <div class="settings-row2-ctrl"><span class="tabnum" id="about-dash-ver">—</span></div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Backend version</div></div>
          <div class="settings-row2-ctrl"><span class="tabnum" id="about-backend-ver">—</span></div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Agent version</div></div>
          <div class="settings-row2-ctrl"><span class="tabnum" id="about-agent-ver">—</span></div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Health check</div></div>
          <div class="settings-row2-ctrl">
            <button class="btn btn-ghost btn-sm" id="setting-health-check">${S.checkHealth}</button>
            <span id="health-result" style="font-size:var(--text-xs);color:var(--text-muted)"></span>
          </div>
        </div>
        <div class="settings-row2">
          <div class="settings-row2-lbl"><div class="settings-row2-lbl-title">Runbook</div></div>
          <div class="settings-row2-ctrl">
            <a class="btn btn-ghost btn-sm" href="https://github.com/your-org/voltwatch/wiki" target="_blank" rel="noopener">${S.viewRunbook} ↗</a>
          </div>
        </div>
      </div>
    `)}
    ${_sectionHTML('Push notifications', 'settings-push-section', `
      <div class="settings-card">
        <!-- Status row -->
        <div class="settings-row2">
          <div class="settings-row2-lbl">
            <div class="settings-row2-lbl-title">Status</div>
            <div class="settings-row2-lbl-desc" id="push-status-desc">Loading…</div>
          </div>
          <div class="settings-row2-ctrl">
            <span class="pill" id="push-status-pill">—</span>
          </div>
        </div>

        <!-- Explanation (shown before requesting permission) -->
        <div id="push-explain-box" style="display:none;background:var(--c-info-dim);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);font-size:var(--text-sm);color:var(--text-secondary);line-height:1.5">
          Push notifications let VoltWatch alert you on your phone even when this tab is closed.
          Critical alerts repeat until acknowledged. Quiet hours still apply (except critical).
          <br/><br/>
          Your browser will ask for permission after you tap <strong>Enable</strong>.
        </div>

        <!-- iOS not installed warning -->
        <div id="push-ios-hint" style="display:none;background:var(--c-warning-dim);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);font-size:var(--text-sm);color:var(--c-warning)">
          On iPhone/iPad, push requires VoltWatch to be installed to your Home Screen first.
          <br/><br/>
          <button class="btn btn-ghost btn-sm" id="push-ios-guide-btn">How to install →</button>
        </div>

        <!-- Permission blocked -->
        <div id="push-blocked-hint" style="display:none;background:var(--c-critical-dim);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);font-size:var(--text-sm);color:var(--c-critical)">
          Notifications are blocked in your browser settings.
          To re-enable: open your browser settings → Site settings → Notifications → find this site and allow.
        </div>

        <!-- Action buttons -->
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-3)">
          <button class="btn btn-primary btn-sm" id="push-enable-btn" style="display:none">Enable push</button>
          <button class="btn btn-ghost btn-sm" id="push-disable-btn" style="display:none">Disable push</button>
          <button class="btn btn-ghost btn-sm" id="push-test-btn" style="display:none">🔔 Send test push</button>
          <span id="push-test-result" style="font-size:var(--text-xs);color:var(--text-muted);align-self:center"></span>
        </div>

        <!-- Android install app -->
        <div id="push-install-btn-row" style="display:none;margin-bottom:var(--space-3)">
          <button class="btn btn-ghost btn-sm" id="push-install-btn">📲 Install app</button>
          <span style="font-size:var(--text-xs);color:var(--text-muted);margin-left:var(--space-2)">Add VoltWatch to your home screen for the best experience.</span>
        </div>

        <!-- Subscriptions list -->
        <div id="push-subs-list" style="margin-top:var(--space-3)"></div>
      </div>
    `)}

  `;

  _wireControls();
}

function _sectionHTML(title, id, body) {
  return `
    <div class="settings-group" id="${id}">
      <div class="settings-group-title">${_esc(title)}</div>
      ${body}
    </div>
  `;
}

// ── Populate controls from _cfg ───────────────────────────────

function _populateAll() {
  const c = _cfg;

  // Thresholds
  _renderThresholdChips(c.alertThresholds || [50, 30, 20, 15]);

  // Critical level + repeat
  _setVal('setting-critical-level', c.criticalLevel ?? 15);
  _setVal('setting-critical-repeat', c.criticalRepeatMin ?? 5);

  // Connection
  const hb = c.heartbeatIntervalSec ?? 30;
  _setVal('setting-heartbeat', hb);
  document.getElementById('setting-heartbeat-val').textContent = `${hb}s`;

  const ot = c.offlineThresholdSec ?? 180;
  _setVal('setting-offline-timeout', ot);
  _updateOfflinePreview(ot);

  // MT5
  _setChecked('setting-mt5-alert', c.mt5AlertEnabled ?? true);
  _setVal('setting-mt5-debounce', c.mt5DebounceSec ?? 60);

  // Quiet hours
  _setChecked('setting-quiet-enabled', c.quietHours?.enabled ?? false);
  _setVal('setting-quiet-start', c.quietHours?.start ?? '22:00');
  _setVal('setting-quiet-end',   c.quietHours?.end   ?? '07:00');
  _syncQuietRows();

  // Alarm
  const vol = Math.round((c.alarmVolume ?? 0.8) * 100);
  _setVal('setting-alarm-volume', vol);
  document.getElementById('setting-alarm-volume-val').textContent = `${vol}%`;
  _setChecked('setting-vibration',    c.vibration ?? true);
  _setChecked('setting-wake-default', c.keepAwakeDefault ?? false);

  // Appearance
  _setVal('setting-theme', c.theme ?? 'dark');
  _setVal('setting-tz', c.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const fmt = c.timeFormat ?? '24';
  const r12 = document.getElementById('setting-time-12');
  const r24 = document.getElementById('setting-time-24');
  if (r12) r12.checked = fmt === '12';
  if (r24) r24.checked = fmt === '24';

  // Data
  _setVal('setting-retention', c.retentionDays ?? 90);

  // About
  document.getElementById('about-dash-ver').textContent = '1.0.0';
  const backendVer = store.get('status')?.serverVersion || '—';
  document.getElementById('about-backend-ver').textContent = backendVer;
  const agentVer = store.get('devices')?.[0]?.agentVersion || '—';
  document.getElementById('about-agent-ver').textContent = agentVer;

  // Session
  const user = store.get('user');
  if (user) {
    document.getElementById('session-info-text').textContent =
      `Signed in as ${user.email || user.name || 'owner'} · Session active`;
  }
}

// ── Wire all controls ─────────────────────────────────────────

function _wireControls() {
  // Threshold chips
  document.getElementById('threshold-add-btn')?.addEventListener('click', _addThreshold);
  document.getElementById('threshold-add-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _addThreshold();
  });

  // Critical level / repeat — save on change
  _onChangeDebounced('setting-critical-level', v => {
    const n = parseInt(v);
    if (n >= 1 && n <= 99) _patchSettings({ criticalLevel: n });
  });
  _onChangeDebounced('setting-critical-repeat', v => {
    const n = parseInt(v);
    if (n >= 0) _patchSettings({ criticalRepeatMin: n });
  });

  // Heartbeat slider
  const hbEl = document.getElementById('setting-heartbeat');
  const hbVal = document.getElementById('setting-heartbeat-val');
  hbEl?.addEventListener('input', () => {
    hbVal.textContent = `${hbEl.value}s`;
    _scheduleSave({ heartbeatIntervalSec: parseInt(hbEl.value) });
  });

  // Offline timeout slider
  const otEl  = document.getElementById('setting-offline-timeout');
  otEl?.addEventListener('input', () => {
    _updateOfflinePreview(parseInt(otEl.value));
    _scheduleSave({ offlineThresholdSec: parseInt(otEl.value) });
  });

  // MT5
  document.getElementById('setting-mt5-alert')?.addEventListener('change', e => {
    _patchSettings({ mt5AlertEnabled: e.target.checked });
  });
  _onChangeDebounced('setting-mt5-debounce', v => {
    const n = parseInt(v);
    if (n >= 5) _patchSettings({ mt5DebounceSec: n });
  });

  // Quiet hours
  document.getElementById('setting-quiet-enabled')?.addEventListener('change', e => {
    _patchSettings({ quietHours: { ..._cfg.quietHours, enabled: e.target.checked } });
    _syncQuietRows();
  });
  document.getElementById('setting-quiet-start')?.addEventListener('change', e => {
    _patchSettings({ quietHours: { ..._cfg.quietHours, start: e.target.value } });
  });
  document.getElementById('setting-quiet-end')?.addEventListener('change', e => {
    _patchSettings({ quietHours: { ..._cfg.quietHours, end: e.target.value } });
  });

  // Alarm
  const volEl  = document.getElementById('setting-alarm-volume');
  const volVal = document.getElementById('setting-alarm-volume-val');
  volEl?.addEventListener('input', () => {
    const v = parseInt(volEl.value) / 100;
    volVal.textContent = `${Math.round(v * 100)}%`;
    sound.setVolume(v);
    _scheduleSave({ alarmVolume: v });
  });
  document.getElementById('setting-vibration')?.addEventListener('change', e => {
    _patchSettings({ vibration: e.target.checked });
  });
  document.getElementById('setting-arm-sound')?.addEventListener('click', () => {
    sound.arm();
    notify.toast({ title: 'Alarm armed', message: 'Sound will play for critical alerts.', severity: 'ok', duration: 3000 });
    document.getElementById('setting-arm-sound').textContent = '✅ Armed';
  });
  document.getElementById('setting-wake-default')?.addEventListener('change', e => {
    _patchSettings({ keepAwakeDefault: e.target.checked });
  });

  // Appearance
  document.getElementById('setting-theme')?.addEventListener('change', e => {
    document.documentElement.setAttribute('data-theme', e.target.value);
    localStorage.setItem('vw-theme', e.target.value);
    _patchSettings({ theme: e.target.value });
  });
  document.getElementById('setting-tz')?.addEventListener('change', e => {
    _patchSettings({ timezone: e.target.value });
  });
  document.querySelectorAll('[name="time-fmt"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = document.querySelector('[name="time-fmt"]:checked')?.value || '24';
      _patchSettings({ timeFormat: v });
    });
  });

  // Data
  _onChangeDebounced('setting-retention', v => {
    const n = parseInt(v);
    if (n >= 1) _patchSettings({ retentionDays: n });
  });
  document.getElementById('setting-export-csv')?.addEventListener('click', () => _exportHistory('csv'));
  document.getElementById('setting-export-json')?.addEventListener('click', () => _exportHistory('json'));
  document.getElementById('setting-delete-history')?.addEventListener('click', _deleteHistoryConfirm);

  // Health check
  document.getElementById('setting-health-check')?.addEventListener('click', _runHealthCheck);
}

// ── Security section ──────────────────────────────────────────

function _wireSecuritySection() {
  document.getElementById('setting-change-pw')?.addEventListener('click', _changePasswordFlow);
  document.getElementById('setting-sign-out-all')?.addEventListener('click', async () => {
    if (!confirm(S.signOutEverywhere + '? You will be signed out on all devices.')) return;
    try {
      await auth.signOutAll?.();
      notify.toast({ title: 'Signed out everywhere', severity: 'ok', duration: 3000 });
    } catch (e) {
      notify.toast({ title: S.error, message: e.message, severity: 'warning' });
    }
  });
}

function _changePasswordFlow() {
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="confirm-modal-box">
      <div class="confirm-modal-title">Change password</div>
      <div class="form-group">
        <label class="form-label" for="cpw-current">Current password</label>
        <input class="form-control" type="password" id="cpw-current" autocomplete="current-password" />
      </div>
      <div class="form-group">
        <label class="form-label" for="cpw-new">New password</label>
        <input class="form-control" type="password" id="cpw-new" autocomplete="new-password" minlength="8" />
      </div>
      <div class="form-group" style="margin-bottom:var(--space-4)">
        <label class="form-label" for="cpw-confirm">Confirm new password</label>
        <input class="form-control" type="password" id="cpw-confirm" autocomplete="new-password" />
      </div>
      <div class="form-error" id="cpw-error" role="alert"></div>
      <div class="confirm-modal-actions">
        <button class="btn btn-ghost" id="cpw-cancel">${S.cancel}</button>
        <button class="btn btn-primary" id="cpw-submit">Update password</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#cpw-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
  modal.querySelector('#cpw-submit').addEventListener('click', async () => {
    const cur  = modal.querySelector('#cpw-current').value;
    const nw   = modal.querySelector('#cpw-new').value;
    const conf = modal.querySelector('#cpw-confirm').value;
    const err  = modal.querySelector('#cpw-error');

    if (!cur || !nw || !conf) { err.textContent = 'All fields required.'; return; }
    if (nw !== conf)          { err.textContent = 'Passwords do not match.'; return; }
    if (nw.length < 8)        { err.textContent = 'Password must be at least 8 characters.'; return; }

    const btn = modal.querySelector('#cpw-submit');
    btn.classList.add('loading');
    try {
      await auth.changePassword(cur, nw);
      modal.remove();
      notify.toast({ title: 'Password updated', severity: 'ok', duration: 3000 });
    } catch (e) {
      err.textContent = e.message || S.error;
    } finally {
      btn.classList.remove('loading');
    }
  });
}

// ── Data section ──────────────────────────────────────────────

function _wireDataSection() {
  /* handled in _wireControls() via event delegation */
}

function _deleteHistoryConfirm() {
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="confirm-modal-box">
      <div class="confirm-modal-title" style="color:var(--c-critical)">${S.deleteHistory}</div>
      <div class="confirm-modal-desc">${S.deleteHistoryWarning}</div>
      <div class="form-group" style="margin-bottom:var(--space-4)">
        <label class="form-label">${S.deleteHistoryConfirm}</label>
        <input class="form-control" id="del-hist-input" placeholder="DELETE" autocomplete="off" />
      </div>
      <div class="confirm-modal-actions">
        <button class="btn btn-ghost" id="del-hist-cancel">${S.cancel}</button>
        <button class="btn" id="del-hist-ok" disabled style="background:var(--c-critical);color:#fff">Delete all</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector('#del-hist-input');
  const okBtn = modal.querySelector('#del-hist-ok');
  input.addEventListener('input', () => { okBtn.disabled = input.value !== 'DELETE'; });
  modal.querySelector('#del-hist-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
  okBtn.addEventListener('click', async () => {
    okBtn.classList.add('loading');
    try {
      await settingsApi.deleteHistory();
      modal.remove();
      notify.toast({ title: 'History deleted', severity: 'ok', duration: 3000 });
    } catch (e) {
      notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      modal.remove();
    }
  });
}

async function _exportHistory(fmt) {
  const deviceId = store.get('deviceId');
  if (!deviceId) return;
  try {
    const url = `${window.VOLTWATCH_API}/devices/${deviceId}/readings?limit=50000&format=${fmt}`;
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.click();
  } catch (e) {
    notify.toast({ title: S.error, message: e.message, severity: 'warning' });
  }
}

async function _runHealthCheck() {
  const btn = document.getElementById('setting-health-check');
  const res = document.getElementById('health-result');
  btn?.classList.add('loading');
  if (res) res.textContent = 'Checking…';
  try {
    const data = await fetch(`${window.VOLTWATCH_API.replace('/v1', '')}/health`).then(r => r.json());
    if (res) {
      res.textContent = data.status === 'ok' ? '✅ Healthy' : `⚠ ${data.status}`;
      res.style.color = data.status === 'ok' ? 'var(--c-ok)' : 'var(--c-warning)';
    }
  } catch (e) {
    if (res) { res.textContent = '❌ Unreachable'; res.style.color = 'var(--c-critical)'; }
  } finally {
    btn?.classList.remove('loading');
  }
}

// ── Threshold chips ───────────────────────────────────────────

function _renderThresholdChips(values) {
  const display = document.getElementById('threshold-chips-display');
  if (!display) return;

  const sorted = [...new Set(values)].sort((a, b) => b - a);
  const critLevel = parseInt(_cfg.criticalLevel ?? 15);

  display.innerHTML = sorted.map(v => {
    const isCrit = v === critLevel;
    return `
      <span class="threshold-chip ${isCrit ? 'critical' : ''}"
            aria-label="${v}% threshold${isCrit ? ' (critical)' : ''}">
        ${v}%
        <button type="button" aria-label="Remove ${v}% threshold"
                data-remove-threshold="${v}">×</button>
      </span>`;
  }).join('');

  display.querySelectorAll('[data-remove-threshold]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.removeThreshold);
      const newList = sorted.filter(x => x !== v);
      _cfg.alertThresholds = newList;
      _renderThresholdChips(newList);
      _patchSettings({ alertThresholds: newList }, 'threshold-feedback');
    });
  });
}

function _addThreshold() {
  const input = document.getElementById('threshold-add-input');
  const v     = parseInt(input?.value);
  if (!v || v < 1 || v > 99) {
    _showFeedback('threshold-feedback', 'Value must be 1–99', false);
    return;
  }
  const existing = _cfg.alertThresholds || [];
  if (existing.includes(v)) {
    _showFeedback('threshold-feedback', 'Already added', false);
    return;
  }
  const newList = [...existing, v];
  _cfg.alertThresholds = newList;
  _renderThresholdChips(newList);
  _patchSettings({ alertThresholds: newList }, 'threshold-feedback');
  if (input) input.value = '';
}

// ── Save helpers ──────────────────────────────────────────────

function _scheduleSave(patch) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => _patchSettings(patch), 600);
}

async function _patchSettings(patch, feedbackId) {
  Object.assign(_cfg, patch);
  store.update('settings', patch);
  try {
    await settingsApi.save(_cfg);
    if (feedbackId) _showFeedback(feedbackId, S.saved, true);
  } catch (e) {
    if (feedbackId) _showFeedback(feedbackId, S.settingsSaveError, false);
    notify.toast({ title: S.settingsSaveError, message: e.message, severity: 'warning', duration: 3000 });
  }
}

function _showFeedback(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `save-feedback ${ok ? 'ok' : 'error'}`;
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// ── Misc helpers ──────────────────────────────────────────────

function _updateOfflinePreview(secs) {
  const el  = document.getElementById('offline-preview');
  const val = document.getElementById('setting-offline-val');
  const min = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.round(secs/60)} min` : `${(secs/3600).toFixed(1)} h`;
  if (val) val.textContent = min;
  if (el)  el.textContent  = S.offlinePreview(min);
}

function _syncQuietRows() {
  const enabled = document.getElementById('setting-quiet-enabled')?.checked;
  const row     = document.getElementById('quiet-time-row');
  if (row) row.style.opacity = enabled ? '1' : '0.4';
}

function _onChangeDebounced(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  let t;
  el.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => cb(el.value), 700);
  });
}

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined && val !== null) el.value = val;
}

function _setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function _tzOptions() {
  const zones = Intl.supportedValuesOf
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo'];
  return zones.map(z => `<option value="${z}">${z.replace(/_/g,' ')}</option>`).join('');
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Push section ──────────────────────────────────────────────

async function _wirePushSection() {
  const pill    = document.getElementById('push-status-pill');
  const desc    = document.getElementById('push-status-desc');
  const explain = document.getElementById('push-explain-box');
  const iosHint = document.getElementById('push-ios-hint');
  const blocked = document.getElementById('push-blocked-hint');
  const enableBtn  = document.getElementById('push-enable-btn');
  const disableBtn = document.getElementById('push-disable-btn');
  const testBtn    = document.getElementById('push-test-btn');
  const testResult = document.getElementById('push-test-result');
  const installRow = document.getElementById('push-install-btn-row');
  const installBtn = document.getElementById('push-install-btn');

  if (!pill) return; // Section not rendered yet

  async function refresh() {
    // Reset all conditional UI to hidden before each refresh.
    // This ensures switching states (enable → disable → enable) never leaves
    // stale buttons visible from a previous branch.
    [explain, iosHint, blocked, enableBtn, disableBtn, testBtn, installRow].forEach(el => {
      if (el) el.style.display = 'none';
    });
    if (testResult) testResult.textContent = '';

    if (!isPushSupported()) {
      pill.textContent = 'Unsupported';
      pill.className   = 'pill pill-unknown';
      desc.textContent = 'Push notifications are not supported in this browser.';
      return;
    }

    // iOS not installed
    if (isIOS() && !isInstalled()) {
      pill.textContent = 'Not installed';
      pill.className   = 'pill pill-warning';
      desc.textContent = 'Install VoltWatch to your Home Screen to enable push.';
      if (iosHint) iosHint.style.display = '';
      return;
    }

    const perm = getPermissionState();

    if (perm === 'denied') {
      pill.textContent = 'Blocked';
      pill.className   = 'pill pill-critical';
      desc.textContent = 'Permission was denied. Change it in your browser settings.';
      if (blocked) blocked.style.display = '';
      return;
    }

    if (perm === 'granted') {
      // Permission is granted — check if there is an active push subscription
      const subs = await listSubscriptions().catch(() => []);
      const hasSub = subs.length > 0;

      if (hasSub) {
        pill.textContent = `Active (${subs.length})`;
        pill.className   = 'pill pill-ok';
        desc.textContent = `Push enabled on ${subs.length} browser${subs.length > 1 ? 's' : ''}.`;
        if (disableBtn) disableBtn.style.display = '';
        if (testBtn)    testBtn.style.display    = '';
        _renderSubsList(subs, refresh);
      } else {
        // Permission granted but no active endpoint (e.g. just disabled)
        pill.textContent = 'Not enabled';
        pill.className   = 'pill pill-unknown';
        desc.textContent = 'Push permission granted but no active subscription. Tap Enable to re-subscribe.';
        if (explain)   explain.style.display   = '';
        if (enableBtn) enableBtn.style.display = '';
        const subsList = document.getElementById('push-subs-list');
        if (subsList) subsList.innerHTML = '';
      }
    } else {
      // 'default' — not yet asked
      pill.textContent = 'Not enabled';
      pill.className   = 'pill pill-unknown';
      desc.textContent = 'Enable push to get alerts even when the tab is closed.';
      if (explain)   explain.style.display   = '';
      if (enableBtn) enableBtn.style.display = '';
    }

    // Android install prompt
    if (canInstall() && installRow) installRow.style.display = '';
  }

  await refresh();

  // Enable button
  enableBtn?.addEventListener('click', async () => {
    enableBtn.classList.add('loading');
    const result = await subscribe();
    enableBtn.classList.remove('loading');

    if (result === 'ios-not-installed') {
      showIOSInstallGuide();
    } else if (result === 'denied') {
      notify.toast({ title: 'Permission denied', message: 'Allow notifications in your browser settings.', severity: 'warning' });
    } else if (result === 'subscribed') {
      notify.toast({ title: '✅ Push enabled', severity: 'ok', duration: 3000 });
      await refresh();
    } else if (result === 'error') {
      notify.toast({ title: 'Push failed', message: 'Could not create subscription. Try again.', severity: 'warning' });
    }
  });

  // Disable button
  disableBtn?.addEventListener('click', async () => {
    disableBtn.classList.add('loading');
    await unsubscribe();
    disableBtn.classList.remove('loading');
    notify.toast({ title: 'Push disabled', severity: 'ok', duration: 3000 });
    await refresh();
  });

  // Test push button
  testBtn?.addEventListener('click', async () => {
    testBtn.classList.add('loading');
    if (testResult) testResult.textContent = 'Sending…';
    try {
      const { sent, failed, total } = await sendTestPush();
      if (testResult) testResult.textContent = `Sent to ${sent}/${total} devices${failed ? ` (${failed} failed)` : ''}`;
    } catch (e) {
      if (testResult) testResult.textContent = `Failed: ${e.message}`;
    } finally {
      testBtn.classList.remove('loading');
    }
  });

  // iOS guide button
  document.getElementById('push-ios-guide-btn')?.addEventListener('click', showIOSInstallGuide);

  // Android install button
  installBtn?.addEventListener('click', async () => {
    const accepted = await triggerInstall();
    if (accepted) {
      installRow.style.display = 'none';
      notify.toast({ title: '📲 App installed!', severity: 'ok', duration: 3000 });
    }
  });

  // Re-show install prompt if available later
  document.addEventListener('vw:installprompt', () => {
    if (installRow) installRow.style.display = '';
  });
}

function _renderSubsList(subs, onRemove) {
  const container = document.getElementById('push-subs-list');
  if (!container) return;

  if (!subs.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div style="font-size:var(--text-xs);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:var(--space-2)">Registered browsers</div>
    ${subs.map(s => `
      <div class="settings-row2" data-sub-id="${_esc(s._id)}">
        <div class="settings-row2-lbl">
          <div class="settings-row2-lbl-title">${_esc(s.label || s.userAgent?.slice(0, 40) || 'Unknown browser')}</div>
          <div class="settings-row2-lbl-desc">
            Added ${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}
            ${s.lastSuccessAt ? ' · Last push ' + new Date(s.lastSuccessAt).toLocaleDateString() : ''}
          </div>
        </div>
        <div class="settings-row2-ctrl">
          <button class="btn btn-ghost btn-sm" style="color:var(--c-critical)" data-remove-sub="${_esc(s._id)}">Remove</button>
        </div>
      </div>
    `).join('')}
  `;

  container.querySelectorAll('[data-remove-sub]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('loading');
      try {
        await removeSubscription(btn.dataset.removeSub);
        await onRemove();
      } catch (e) {
        notify.toast({ title: S.error, message: e.message, severity: 'warning' });
      }
    });
  });
}

