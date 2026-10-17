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

  const form        = page.querySelector('#login-form');
  const emailEl     = page.querySelector('#login-email');
  const passEl      = page.querySelector('#login-password');
  const showPassBtn = page.querySelector('#toggle-password');
  const submitBtn   = page.querySelector('#login-submit');
  const errorEl     = page.querySelector('#login-error');
  const lockoutEl   = page.querySelector('#lockout-msg');

  // Show/hide password
  showPassBtn?.addEventListener('click', () => {
    const isText = passEl.type === 'text';
    passEl.type = isText ? 'password' : 'text';
    showPassBtn.setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
    showPassBtn.textContent = isText ? '👁' : '🙈';
  });

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

    try {
      await auth.login(email, password);
      // Reload so boot() re-runs auth.me() with the new session cookie,
      // sets _authed = true, then routes to #/live correctly.
      location.href = location.origin + location.pathname + '#/live';
      location.reload();
    } catch (err) {
      _setLoading(submitBtn, false);
      if (err.status === 401) {
        _setError(errorEl, 'Incorrect email or password.');
      } else if (err.status === 429) {
        lockoutEl?.classList.add('visible');
        lockoutEl.textContent = 'Too many attempts. Please wait a few minutes.';
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
