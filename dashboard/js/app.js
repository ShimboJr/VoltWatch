/**
 * app.js — Application entry point.
 *
 * Bootstraps the router, authentication guard, poller,
 * theme management, device switcher, and page controllers.
 */

import { router }  from './router.js';
import { store }   from './store.js';
import { poller }  from './poller.js';
import { auth, devices, settings } from './api.js';
import { notify }  from './notify.js';
import { sound }   from './sound.js';
import { initLoginPage }   from './pages/login.js';
import { initLivePage }    from './pages/live.js';
import { initHistoryPage } from './pages/history.js';
import { initTimelinePage, destroyTimelinePage } from './pages/timeline.js';
import { initInsightsPage } from './pages/insights.js';
import { initAlertsPage, destroyAlertsPage }   from './pages/alerts.js';
import { initDevicesPage, destroyDevicesPage }  from './pages/devices.js';
import { initSettingsPage, destroySettingsPage } from './pages/settings.js';
import { initGlancePage, exitGlance } from './pages/glance.js';
import { renderOnboardingCard, subscribeOnboarding, shouldShowOnboarding } from './pages/onboarding.js';

import { registerSW, showIOSInstallGuide, isIOS, isInstalled, canInstall } from './push.js';

// Expose poller + auth helper globally
// afterLogin() is called by login.js after a successful login so we
// can set _authed and load data without a page reload.
window.__vw = {
  poller,
  store,
  afterLogin: (userObj) => _afterLogin(userObj),
};

// ─── Theme ────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'dark');
}

// ─── Auth guard ───────────────────────────────────────────────

let _authed = false;

router.beforeEach((hash) => {
  if (hash.startsWith('#/login')) return true;
  if (!_authed) {
    router.go('#/login');
    return false;
  }
  return true;
});

// ─── Page switching ───────────────────────────────────────────

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === id);
  });
}

// ─── Routes ──────────────────────────────────────────────────

router
  .on('#/login', () => {
    showPage('page-login');
    initLoginPage();
  })
  .on('#/live', () => {
    showPage('page-live');
    initLivePage();
    const deviceId = store.get('deviceId');
    if (deviceId) poller.start(deviceId);
    // Onboarding card for first-time users
    const ob = document.getElementById('onboarding-card');
    if (ob) renderOnboardingCard(ob);
  })
  .on('#/history', () => {
    showPage('page-history');
    initHistoryPage();
  })
  .on('#/timeline', () => {
    showPage('page-timeline');
    initTimelinePage();
  })
  .on('#/insights', () => {
    showPage('page-insights');
    initInsightsPage();
  })
  .on('#/alerts', () => {
    showPage('page-alerts');
    initAlertsPage();
  })
  .on('#/devices', () => {
    showPage('page-devices');
    initDevicesPage();
    // Wire wizard backdrop
    document.getElementById('devices-wizard-backdrop')?.addEventListener('click', () => {
      document.getElementById('devices-wizard')?.classList.remove('open');
    }, { once: true });
  })
  .on('#/settings', () => {
    showPage('page-settings');
    initSettingsPage();
  })
  .on('#/glance', () => {
    // Glance overlays current page; don't call showPage
    initGlancePage();
  });

// ─── Alerts page stub (replaced by alerts.js) ─────────────────
function _renderAlertsPage() { /* no-op; initAlertsPage() called by router */ }

// ─── Devices page stub (replaced by devices.js) ───────────────
async function _renderDevicesPage() { /* no-op; initDevicesPage() called by router */ }

window.switchDevice = (id) => {
  store.set('deviceId', id);
  poller.stop();
  poller.start(id);
  router.go('#/live');
};

function _updateDeviceSwitcher(list, activeId) {
  const sel = document.getElementById('device-select');
  if (!sel) return;
  sel.innerHTML = list.map(d =>
    `<option value="${d._id}" ${d._id === activeId ? 'selected' : ''}>${d.name || d._id}</option>`
  ).join('');
}

// ─── Post-auth data loader ───────────────────────────────────
// Called after both session-restore (boot) and explicit login (login.js).

async function _afterLogin(userObj) {
  _authed = true;
  store.set('user', userObj);

  // Load first device
  try {
    const devList = await devices.list();
    const list    = devList.devices || devList || [];
    store.set('devices', list);

    if (list.length > 0) {
      store.set('deviceId', list[0]._id);
      _updateDeviceSwitcher(list, list[0]._id);
    }
  } catch { /* no devices yet — handled by live page empty state */ }

  // Load user settings (non-fatal)
  try {
    const cfg = await settings.get();
    const s   = cfg?.settings || cfg || {};
    store.set('settings', s);
    applyTheme(s.theme);
    sound.setVolume(s.alarmVolume ?? 0.8);
  } catch { /* ignore */ }

  // Subscribe onboarding card to store changes
  const ob = document.getElementById('onboarding-card');
  if (ob) subscribeOnboarding(ob);

  // Show glance shortcut
  const glanceBtn = document.getElementById('btn-glance-shortcut');
  if (glanceBtn) glanceBtn.style.display = '';

  // Navigate to live — if already there, re-dispatch to kick off poller
  if (router.current()?.startsWith('#/live')) {
    const deviceId = store.get('deviceId');
    if (deviceId) { poller.stop(); poller.start(deviceId); }
  } else {
    router.go('#/live');
  }
}

// ─── Settings page ────────────────────────────────────────────
// (now handled by settings.js — stub kept for compatibility)
function _renderSettingsPage() { /* no-op; initSettingsPage() called by router */ }

// ─── Bootstrap ───────────────────────────────────────────────

async function boot() {
  // Register service worker (PWA + push)
  registerSW().catch(() => {});

  // Apply stored theme immediately
  const theme = localStorage.getItem('vw-theme') || 'dark';
  applyTheme(theme);

  // ── Wire up UI event listeners (don't need auth) ─────────────
  document.getElementById('device-select')?.addEventListener('change', (e) => {
    window.switchDevice(e.target.value);
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try { await auth.logout(); } catch { /* ignore */ }
    _authed = false;
    store.set('user', null);
    store.set('devices', []);
    poller.stop();
    document.getElementById('btn-glance-shortcut')?.style &&
      (document.getElementById('btn-glance-shortcut').style.display = 'none');
    router.go('#/login');
  });

  // ── Start router & dismiss loader immediately ─────────────────
  // Router shows #/login right away (since _authed is still false).
  // We don't block on network — the auth check below will navigate
  // to #/live if the session is valid.
  router.start();
  _dismissLoader();

  // ── Dead-man health poll ──────────────────────────────────────
  (function startDeadManPoll() {
    async function checkHealth() {
      try {
        const h = await fetch('/api/v1/health').then(r => r.json());
        const banner = document.getElementById('dead-man-banner');
        if (banner) banner.style.display = h.deadManWarning ? '' : 'none';
      } catch { /* backend unreachable — offline-banner handles this via SW */ }
    }
    checkHealth();
    setInterval(checkHealth, 5 * 60 * 1000);
  })();

  // ── Try to restore session (runs after UI is already visible) ─
  try {
    const me = await auth.me();
    await _afterLogin(me.user || me);
  } catch {
    // Not authenticated — router is already at #/login, nothing to do.
    // Do NOT reset _authed here; login.js may have already set it to true
    // via window.__vw.afterLogin() while auth.me() was in-flight.
  }
}

// ─── Dismiss loader ───────────────────────────────────────
let _loaderDismissed = false;
function _dismissLoader() {
  if (_loaderDismissed) return;
  _loaderDismissed = true;
  document.body.classList.remove('app-loading');
  const loader = document.getElementById('app-loader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 260);
}

// Show a hint after 3 s if backend is still loading the session in background
setTimeout(() => {
  const hint = document.getElementById('app-loader-hint');
  if (hint && !_loaderDismissed) hint.style.display = '';
}, 3000);

boot().catch(err => {
  console.error('[VoltWatch] Boot error:', err);
  _dismissLoader();
});
