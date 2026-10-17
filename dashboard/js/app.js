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

// Expose poller globally for manual refresh
window.__vw = { poller, store };

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

// ─── Settings page ────────────────────────────────────────────
// (now handled by settings.js — stub kept for compatibility)
function _renderSettingsPage() { /* no-op; initSettingsPage() called by router */ }

// ─── Bootstrap ───────────────────────────────────────────────

async function boot() {
  // Register service worker (PWA + push)
  registerSW().catch(() => {});

  // Apply stored theme
  const theme = localStorage.getItem('vw-theme') || 'dark';
  applyTheme(theme);

  // Try to restore session
  try {
    const me = await auth.me();
    _authed = true;
    store.set('user', me.user || me);

    // Load first device
    const devList = await devices.list();
    const list    = devList.devices || devList;
    store.set('devices', list);

    if (list.length > 0) {
      store.set('deviceId', list[0]._id);
      _updateDeviceSwitcher(list, list[0]._id);
    }

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

    // Show glance shortcut after auth
    const glanceBtn = document.getElementById('btn-glance-shortcut');
    if (glanceBtn) glanceBtn.style.display = '';

  } catch {
    _authed = false;
  }

  // Device switcher change
  document.getElementById('device-select')?.addEventListener('change', (e) => {
    window.switchDevice(e.target.value);
  });

  // Logout button
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

  // Dead-man health poll: check /api/v1/health every 5 min; show banner if no readings recently
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

  // Start router
  router.start();
}

boot().catch(err => {
  console.error('[VoltWatch] Boot error:', err);
  router.start(); // Start anyway (will redirect to login)
});
