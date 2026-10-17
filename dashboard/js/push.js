/**
 * push.js — Client-side Web Push subscription manager.
 *
 * Handles:
 *  - Service worker registration and update flow
 *  - VAPID public key fetch
 *  - Notification permission request (with explanation first)
 *  - PushSubscription creation and sync to backend
 *  - Unsubscribe
 *  - iOS install prompt detection
 *  - Offline banner (SW messages)
 *
 * Usage: imported by app.js and settings.js
 */

import { api } from './api.js';
import { notify } from './notify.js';

// ── Registration ──────────────────────────────────────────────────────────────

let _swRegistration  = null;
let _pushSubscription = null;
let _vapidPublicKey   = null;

/**
 * Register the service worker and wire SW messages.
 * Called once from app.js boot.
 */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  try {
    _swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // Listen for SW messages
    navigator.serviceWorker.addEventListener('message', _onSWMessage);

    // Check for an already-active push subscription
    _pushSubscription = await _swRegistration.pushManager.getSubscription();

    // Detect updates
    _swRegistration.addEventListener('updatefound', _onUpdateFound);

    // If a new SW is already waiting, prompt immediately
    if (_swRegistration.waiting) {
      _showUpdatePrompt();
    }

    return _swRegistration;
  } catch (err) {
    console.warn('[Push] SW registration failed:', err.message);
  }
}

// ── SW message handler ────────────────────────────────────────────────────────

function _onSWMessage(event) {
  const { type, cachedDate, url } = event.data || {};

  if (type === 'SW_UPDATED') {
    _showUpdatePrompt();
  }

  if (type === 'OFFLINE_CACHED') {
    _showOfflineBanner(cachedDate);
  }

  if (type === 'BACK_ONLINE') {
    _hideOfflineBanner();
  }

  if (type === 'NAVIGATE') {
    // Notification click redirected us
    if (event.data.url && location.href !== event.data.url) {
      location.hash = event.data.url.split('#')[1] || '';
    }
  }
}

function _onUpdateFound() {
  const newWorker = _swRegistration.installing;
  newWorker?.addEventListener('statechange', () => {
    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
      _showUpdatePrompt();
    }
  });
}

// ── Update prompt ─────────────────────────────────────────────────────────────

function _showUpdatePrompt() {
  notify.toast({
    title: '⚡ New version available',
    message: 'Tap to refresh and apply the update.',
    severity: 'info',
    duration: 0, // permanent until user acts
    actions: [
      {
        label: 'Refresh',
        onClick: () => {
          _swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
          window.location.reload();
        },
      },
    ],
  });
}

// ── Offline banner ────────────────────────────────────────────────────────────

function _showOfflineBanner(cachedDate) {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const timeStr = cachedDate
    ? new Date(cachedDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'earlier';
  banner.textContent = `📴 Offline — showing data saved at ${timeStr}`;
  banner.style.display = '';
}

function _hideOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.style.display = 'none';
}

// ── Permission state ──────────────────────────────────────────────────────────

/** @returns {'granted'|'denied'|'default'|'unsupported'} */
export function getPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export function isPushSupported() {
  return 'serviceWorker' in navigator &&
         'PushManager' in window &&
         'Notification' in window;
}

/** True if installed as PWA (standalone or fullscreen) */
export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true; // iOS Safari
}

/** True if running on iOS */
export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// ── VAPID key ─────────────────────────────────────────────────────────────────

async function _getVapidKey() {
  if (_vapidPublicKey) return _vapidPublicKey;
  try {
    const { publicKey } = await api.get('/push/vapid-public-key');
    _vapidPublicKey = publicKey;
    return publicKey;
  } catch {
    return null;
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

/**
 * Request notification permission and create a push subscription.
 * Shows a pre-prompt explanation before the native browser dialog.
 *
 * @returns {Promise<'subscribed'|'denied'|'dismissed'|'unsupported'|'ios-not-installed'>}
 */
export async function subscribe(label = '') {
  if (!isPushSupported()) return 'unsupported';
  if (isIOS() && !isInstalled()) return 'ios-not-installed';

  const vapidKey = await _getVapidKey();
  if (!vapidKey) return 'unsupported';

  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'dismissed';

  try {
    const sub = await _swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(vapidKey),
    });

    _pushSubscription = sub;

    // Register with backend
    await api.post('/push/subscribe', {
      endpoint: sub.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
        auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))),
      },
      label,
    });

    return 'subscribed';
  } catch (err) {
    console.error('[Push] Subscribe failed:', err);
    return 'error';
  }
}

// ── Unsubscribe ───────────────────────────────────────────────────────────────

export async function unsubscribe() {
  if (!_pushSubscription) {
    _pushSubscription = await _swRegistration?.pushManager.getSubscription();
  }
  if (!_pushSubscription) return;

  const endpoint = _pushSubscription.endpoint;

  try {
    await _pushSubscription.unsubscribe();
    _pushSubscription = null;
    await api.delete('/push/subscribe', { body: JSON.stringify({ endpoint }) });
  } catch (err) {
    console.warn('[Push] Unsubscribe failed:', err);
  }
}

// ── Current subscription ──────────────────────────────────────────────────────

export function getCurrentSubscription() {
  return _pushSubscription;
}

export async function listSubscriptions() {
  try {
    const { subscriptions } = await api.get('/push/subscriptions');
    return subscriptions || [];
  } catch {
    return [];
  }
}

export async function removeSubscription(id) {
  await api.delete(`/push/subscriptions/${id}`);
}

export async function sendTestPush() {
  return api.post('/push/test', {});
}

// ── iOS install guide ─────────────────────────────────────────────────────────

/**
 * Show a one-time modal explaining how to install the PWA on iOS.
 * iOS Web Push only works when the app is installed to the Home Screen.
 */
export function showIOSInstallGuide() {
  const key = 'vw-ios-guide-shown';
  if (localStorage.getItem(key) === '1') return;

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ios-guide-title');
  modal.innerHTML = `
    <div class="confirm-modal-box" style="max-width:340px">
      <div class="confirm-modal-title" id="ios-guide-title">Add to Home Screen first</div>
      <div style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--space-4);line-height:1.6">
        Push notifications on iPhone and iPad require VoltWatch to be installed
        as an app.<br><br>
        <strong>How to install:</strong><br>
        1. Tap the <strong>Share</strong> button (⬆ square with arrow) in Safari.<br>
        2. Scroll down and tap <strong>Add to Home Screen</strong>.<br>
        3. Tap <strong>Add</strong> in the top-right corner.<br>
        4. Open VoltWatch from your Home Screen and enable push.
      </div>
      <div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-4)">
        Requires iOS / iPadOS 16.4 or later and Safari.
      </div>
      <div class="confirm-modal-actions">
        <button class="btn btn-primary" id="ios-guide-ok" style="width:100%">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#ios-guide-ok').addEventListener('click', () => {
    localStorage.setItem(key, '1');
    modal.remove();
  });
}

// ── Android install prompt ────────────────────────────────────────────────────

let _installPromptEvent = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPromptEvent = e;
  // Notify the settings page so it can show the install button
  document.dispatchEvent(new CustomEvent('vw:installprompt'));
});

/** @returns {boolean} whether the native install dialog is available */
export function canInstall() {
  return !!_installPromptEvent;
}

/** Trigger the Android/Chrome native install dialog */
export async function triggerInstall() {
  if (!_installPromptEvent) return false;
  _installPromptEvent.prompt();
  const result = await _installPromptEvent.userChoice;
  _installPromptEvent = null;
  return result.outcome === 'accepted';
}
