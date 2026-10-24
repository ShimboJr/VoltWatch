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
import { initRegisterPage } from './pages/register.js';
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

/**
 * Apply a theme and, when the value comes from the server, persist it to
 * localStorage so that the next cold load starts with the correct colour.
 *
 * @param {string} theme  'dark' | 'light' | 'amoled'
 * @param {boolean} [fromServer=false]  Set true when the value is authoritative
 *                                       (fetched from backend settings).
 */
function applyTheme(theme, fromServer = false) {
  if (!theme) return;
  document.documentElement.setAttribute('data-theme', theme);
  // Keep localStorage in sync with the server-authoritative value so the
  // NEXT cold load pre-applies the right theme before the API call returns.
  if (fromServer) localStorage.setItem('vw-theme', theme);
}

// ─── Auth guard ───────────────────────────────────────────────

let _authed = false;

router.beforeEach((hash) => {
  if (hash.startsWith('#/login')) return true;
  if (hash.startsWith('#/register')) return true;
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
  .on('#/register', () => {
    showPage('page-register');
    initRegisterPage();
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
    // Wire wizard backdrop close
    document.getElementById('devices-wizard-backdrop')?.addEventListener('click', () => {
      document.getElementById('devices-wizard')?.classList.remove('open');
      document.getElementById('devices-wizard-backdrop')?.classList.remove('visible');
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
  // Set _authed=true here too so explicit logins (via login.js → window.__vw.afterLogin)
  // also unlock the router guard. On boot, this is a harmless no-op since boot() already
  // sets _authed=true before calling _afterLogin.
  _authed = true;

  // ── Clear any stale data from a previous session BEFORE fetching ──────────
  // This prevents the previous user's live-page data from flickering on screen
  // while the new user's data loads asynchronously.
  store.reset();

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

  // Load user settings (non-fatal).
  // Skip if boot() already loaded them to avoid a redundant network round-trip.
  if (!store.get('settings')?._loadedFromServer) {
    try {
      const cfg = await settings.get();
      const s   = cfg?.settings || cfg || {};
      store.set('settings', { ...s, _loadedFromServer: true });
      applyTheme(s.theme, true);
      sound.setVolume(s.alarmVolume ?? 0.8);
    } catch { /* ignore */ }
  }

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

// ─── Shared logout handler ─────────────────────────────────────

async function _doLogout() {
  try { await auth.logout(); } catch { /* ignore */ }
  _authed = false;
  poller.stop();
  store.reset();   // wipe ALL session state — user, devices, status, alerts, settings, etc.
  // Clear user-specific localStorage so the next user starts clean
  try { localStorage.removeItem('vw-theme'); } catch { /* incognito */ }
  // Reset alert badge
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  const glanceBtn = document.getElementById('btn-glance-shortcut');
  if (glanceBtn) glanceBtn.style.display = 'none';
  router.go('#/login');
}

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
    await _doLogout();
  });
  document.getElementById('btn-logout-topbar')?.addEventListener('click', async () => {
    await _doLogout();
  });
  document.getElementById('btn-logout-settings')?.addEventListener('click', async () => {
    await _doLogout();
  });

  // Show mobile logout buttons only when sidebar is hidden (≤992px)
  function _syncMobileLogout() {
    const sidebarVisible = window.matchMedia('(min-width: 992px)').matches;
    const topbarBtn  = document.getElementById('btn-logout-topbar');
    const settingsRow = document.getElementById('settings-signout-row');
    if (topbarBtn)   topbarBtn.style.display   = sidebarVisible ? 'none' : '';
    if (settingsRow) settingsRow.style.display  = sidebarVisible ? 'none' : '';
  }
  _syncMobileLogout();
  window.matchMedia('(min-width: 992px)').addEventListener('change', _syncMobileLogout);

  // (router.start() and _dismissLoader() are called after auth check below
  //  to prevent the login-page flash on reload)

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

  // ── Try to restore session BEFORE starting the router ────────
  // Keeping the app-loader visible until auth state is known prevents
  // the "flash of login page" on every reload when the user is already
  // authenticated. The loader CSS is already in index.html.
  try {
    const me = await auth.me();
    // Session is valid — set auth flag so the router guard passes.
    _authed = true;

    // ── Fetch the server-authoritative theme BEFORE revealing the app ──
    // This eliminates the flash-of-wrong-theme that occurs when the
    // backend theme differs from the stale localStorage value (e.g. the
    // user changed the theme on another device).
    try {
      const cfg = await settings.get();
      const s   = cfg?.settings || cfg || {};
      // Persist to localStorage so the NEXT cold load is correct.
      applyTheme(s.theme, true);
      sound.setVolume(s.alarmVolume ?? 0.8);
      // Mark as loaded so _afterLogin skips the redundant fetch.
      store.set('settings', { ...s, _loadedFromServer: true });
    } catch { /* non-fatal — localStorage theme already applied */ }

    // Start the router now that we know the user is authenticated.
    // It will navigate to #/live (or whatever hash is in the URL).
    router.start();
    _dismissLoader();
    // Load devices, alerts, etc. (settings already loaded above).
    await _afterLogin(me.user || me);
  } catch {
    // Not authenticated — show the login page (unless already on a public route).
    router.start();
    _dismissLoader();
    const publicRoutes = ['#/login', '#/register'];
    const isPublic = publicRoutes.some(r => location.hash.startsWith(r));
    if (!isPublic) {
      router.go('#/login');
    }
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
