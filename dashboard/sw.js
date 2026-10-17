/**
 * sw.js — VoltWatch Service Worker
 *
 * Responsibilities:
 *  1. Precache the app shell (HTML, CSS, JS, fonts) on install.
 *  2. Stale-while-revalidate for static assets.
 *  3. Network-first for /api/* — cache last good response so the app
 *     opens offline with real data and shows an "offline, showing saved data"
 *     banner (posted to all clients via postMessage).
 *  4. Handle Web Push: show notifications with actions (Acknowledge, Snooze).
 *  5. Handle notificationclick: focus existing tab or open #/alerts.
 *  6. Update flow: on new SW activation prompt clients with a message so
 *     they can display a "New version available" toast + refresh button.
 */

'use strict';

// ── Cache names (bump CACHE_VERSION to force full refresh) ───────────────────

const CACHE_VERSION = 'v2';
const SHELL_CACHE   = `vw-shell-${CACHE_VERSION}`;
const API_CACHE     = `vw-api-${CACHE_VERSION}`;
const ASSET_CACHE   = `vw-assets-${CACHE_VERSION}`;

// ── App shell URLs to precache ────────────────────────────────────────────────

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/pages.css',
  '/css/pages2.css',
  '/css/pages3.css',
  '/js/app.js',
  '/js/config.js',
  '/js/api.js',
  '/js/store.js',
  '/js/router.js',
  '/js/poller.js',
  '/js/format.js',
  '/js/notify.js',
  '/js/sound.js',
  '/js/strings.js',
  '/js/push.js',
  '/js/pages/login.js',
  '/js/pages/live.js',
  '/js/pages/history.js',
  '/js/pages/timeline.js',
  '/js/pages/insights.js',
  '/js/pages/alerts.js',
  '/js/pages/devices.js',
  '/js/pages/settings.js',
  '/js/pages/onboarding.js',
  '/js/pages/glance.js',
  '/js/components/ring-gauge.js',
  '/js/components/sparkline.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// API paths to cache (last good response)
const CACHED_API_PATHS = [
  /\/api\/v1\/status/,
  /\/api\/v1\/alerts/,
  /\/api\/v1\/devices/,
  /\/api\/v1\/settings/,
];

// ── Install ───────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Cache individually so one 404 doesn't break the whole install
      await Promise.allSettled(
        SHELL_URLS.map(url => cache.add(url).catch(e => {
          console.warn(`[SW] precache miss: ${url}`, e.message);
        }))
      );
      // Activate immediately (skipWaiting applied by client after user confirms)
    })()
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete old versioned caches
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k.startsWith('vw-') && !k.endsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
      );

      await clients.claim();

      // Notify all open tabs that a new version has activated
      const allClients = await clients.matchAll({ type: 'window' });
      for (const client of allClients) {
        client.postMessage({ type: 'SW_UPDATED' });
      }
    })()
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin and CDN (fonts, Chart.js)
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com') &&
      !url.hostname.includes('cdn.jsdelivr.net')) {
    return;
  }

  // /api/* → network-first, cache last good GET response
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'GET' && _shouldCacheApi(url.pathname)) {
      event.respondWith(_networkFirstApi(request));
    }
    return; // non-GET API calls pass through
  }

  // Navigation → serve shell (SPA fallback)
  if (request.mode === 'navigate') {
    event.respondWith(_serveShell(request));
    return;
  }

  // Static assets → stale-while-revalidate
  event.respondWith(_staleWhileRevalidate(request));
});

function _shouldCacheApi(pathname) {
  return CACHED_API_PATHS.some(re => re.test(pathname));
}

async function _networkFirstApi(request) {
  try {
    const res = await fetch(request.clone());
    if (res.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, res.clone());
      // Reset offline flag for this path
      _notifyOnline(request.url);
    }
    return res;
  } catch {
    const cached = await caches.match(request, { cacheName: API_CACHE });
    if (cached) {
      _notifyOffline(request.url, cached);
      return cached;
    }
    return new Response(JSON.stringify({ error: 'Offline', cached: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function _serveShell(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, res.clone());
      return res;
    }
  } catch { /* offline */ }

  const cached =
    await caches.match(request, { cacheName: SHELL_CACHE }) ||
    await caches.match('/index.html', { cacheName: SHELL_CACHE });

  return cached || new Response('<h1>VoltWatch — offline</h1>', {
    headers: { 'Content-Type': 'text/html' }
  });
}

async function _staleWhileRevalidate(request) {
  const cache  = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || await fetchPromise ||
    new Response('', { status: 404 });
}

// ── Offline notifications ─────────────────────────────────────────────────────

let _offlineNotified = false;

async function _notifyOffline(url, cachedResponse) {
  if (_offlineNotified) return;
  _offlineNotified = true;

  // Extract cache date from the response if available
  const cachedDate = cachedResponse.headers.get('date') || null;

  const allClients = await clients.matchAll({ type: 'window' });
  for (const c of allClients) {
    c.postMessage({ type: 'OFFLINE_CACHED', url, cachedDate });
  }
}

async function _notifyOnline(url) {
  if (!_offlineNotified) return;
  _offlineNotified = false;
  const allClients = await clients.matchAll({ type: 'window' });
  for (const c of allClients) {
    c.postMessage({ type: 'BACK_ONLINE', url });
  }
}

// ── Web Push notifications ────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'VoltWatch', body: event.data.text(), data: {} };
  }

  const { title, body, icon, vibrate, data: payload } = data;
  const severity  = payload?.severity || 'info';
  const isCrit    = severity === 'critical';

  const options = {
    body,
    icon:             icon ? undefined : '/icons/icon-192.png',
    badge:            '/icons/icon-192.png',
    vibrate:          vibrate || [200],
    requireInteraction: isCrit,
    tag:              payload?.alertId ? `alert-${payload.alertId}` : 'voltwatch',
    renotify:         true,
    data:             payload || {},
    actions: [
      { action: 'ack',     title: '✓ Acknowledge' },
      { action: 'snooze',  title: '⏸ Snooze 10m' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title || 'VoltWatch', options)
  );

  // Update app badge if supported
  if (navigator.setAppBadge) {
    navigator.setAppBadge(1).catch(() => {});
  }
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  const { action, notification } = event;
  const alertId  = notification.data?.alertId;
  const deviceId = notification.data?.deviceId;
  const targetUrl = `${self.location.origin}/#/alerts`;

  notification.close();

  event.waitUntil(
    (async () => {
      // Handle actions by calling the API directly from the SW
      if (alertId) {
        if (action === 'ack') {
          await _swFetch(`/api/v1/alerts/${alertId}/ack`, 'POST');
        } else if (action === 'snooze') {
          await _swFetch(`/api/v1/alerts/${alertId}/snooze`, 'POST', { minutes: 10 });
        }
      }

      // Clear badge
      if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});

      // Focus existing window or open new
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = allClients.find(c => c.url.includes('/#/'));

      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'NAVIGATE', url: targetUrl });
      } else {
        await clients.openWindow(targetUrl);
      }
    })()
  );
});

// ── Message from page ─────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── SW fetch helper (for action handlers) ─────────────────────────────────────

async function _swFetch(path, method = 'GET', body = null) {
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'voltwatch',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.warn('[SW] action fetch failed:', e.message);
  }
}
