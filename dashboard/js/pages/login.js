/**
 * login.js — Login page controller.
 */

import { auth } from '../api.js';
import { store } from '../store.js';
import { router } from '../router.js';
import { notify } from '../notify.js';

export function initLoginPage() {
  const page = document.getElementById('page-login');
  if (!page) return;

  const form         = page.querySelector('#login-form');
  const emailEl      = page.querySelector('#login-email');
  const passEl       = page.querySelector('#login-password');
  const showPassBtn  = page.querySelector('#toggle-password');
  const submitBtn    = page.querySelector('#login-submit');
  const errorEl      = page.querySelector('#login-error');
  const lockoutEl    = page.querySelector('#lockout-msg');
  const unverifiedEl = page.querySelector('#unverified-msg');
  const resendBtn    = page.querySelector('#resend-verification-btn');
  const signupLink   = page.querySelector('#goto-register');

  // ── Handle ?verified= query param on page load ──────────────────────────
  const params = new URLSearchParams(location.search);
  const verified = params.get('verified');
  if (verified === '1') {
    notify.toast({ title: '✅ Email verified!', message: 'You can now sign in.', severity: 'ok', duration: 5000 });
    // Clean up the URL param
    history.replaceState({}, '', location.pathname + location.hash.split('?')[0]);
  } else if (verified === 'error') {
    _setError(errorEl, 'Verification link is invalid or has expired. Request a new one below.');
    history.replaceState({}, '', location.pathname + location.hash.split('?')[0]);
  }

  // ── Show/hide password ───────────────────────────────────────────────────
  showPassBtn?.addEventListener('click', () => {
    const isText = passEl.type === 'text';
    passEl.type = isText ? 'password' : 'text';
    showPassBtn.setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
    showPassBtn.textContent = isText ? '👁' : '🙈';
  });

  // ── Sign up link ─────────────────────────────────────────────────────────
  signupLink?.addEventListener('click', (e) => {
    e.preventDefault();
    router.go('#/register');
  });

  // ── Resend verification email ────────────────────────────────────────────
  resendBtn?.addEventListener('click', async () => {
    const email = emailEl.value.trim();
    if (!email) {
      _setError(errorEl, 'Enter your email above, then click resend.');
      return;
    }
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending…';
    try {
      await auth.resendVerification(email);
      notify.toast({ title: 'Verification email sent!', message: 'Check your inbox.', severity: 'ok', duration: 4000 });
      if (unverifiedEl) unverifiedEl.style.display = 'none';
    } catch {
      notify.toast({ title: 'Could not resend', message: 'Please try again later.', severity: 'warning', duration: 4000 });
    } finally {
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend verification email';
    }
  });

  // ── Login form ───────────────────────────────────────────────────────────
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = emailEl.value.trim();
    const password = passEl.value;

    if (!email || !password) {
      _setError(errorEl, 'Please enter your email and password.');
      return;
    }

    _setLoading(submitBtn, true);
    _setError(errorEl, '');
    if (unverifiedEl) unverifiedEl.style.display = 'none';
    if (lockoutEl) lockoutEl.style.display = 'none';

    try {
      const data = await auth.login(email, password);
      await window.__vw.afterLogin(data?.user ?? { email });
    } catch (err) {
      _setLoading(submitBtn, false);
      if (err.status === 401) {
        _setError(errorEl, 'Incorrect email or password.');
      } else if (err.status === 403 && err.message?.includes('verify')) {
        _setError(errorEl, '');
        if (unverifiedEl) unverifiedEl.style.display = '';
      } else if (err.status === 429) {
        if (lockoutEl) {
          lockoutEl.style.display = '';
          lockoutEl.textContent = 'Too many attempts. Please wait a few minutes.';
        }
        _setError(errorEl, '');
      } else {
        _setError(errorEl, err.message || 'Login failed. Check your connection.');
      }
    } finally {
      _setLoading(submitBtn, false);
    }
  });
}

function _setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function _setError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
