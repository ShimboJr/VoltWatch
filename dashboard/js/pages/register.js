/**
 * register.js — Registration page controller.
 */

import { auth } from '../api.js';
import { router } from '../router.js';
import { notify } from '../notify.js';

export function initRegisterPage() {
  const page = document.getElementById('page-register');
  if (!page) return;

  const form        = page.querySelector('#register-form');
  const successBox  = page.querySelector('#register-success');
  const nameEl      = page.querySelector('#register-name');
  const emailEl     = page.querySelector('#register-email');
  const passEl      = page.querySelector('#register-password');
  const confirmEl   = page.querySelector('#register-confirm');
  const showPassBtn = page.querySelector('#toggle-register-password');
  const submitBtn   = page.querySelector('#register-submit');
  const errorEl     = page.querySelector('#register-error');
  const loginLink   = page.querySelector('#goto-login');

  // ── Show/hide password ───────────────────────────────────────────────────
  showPassBtn?.addEventListener('click', () => {
    const isText = passEl.type === 'text';
    passEl.type = isText ? 'password' : 'text';
    showPassBtn.setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
    showPassBtn.textContent = isText ? '👁' : '🙈';
  });

  // ── Login link ───────────────────────────────────────────────────────────
  loginLink?.addEventListener('click', (e) => {
    e.preventDefault();
    router.go('#/login');
  });

  // ── Register form ────────────────────────────────────────────────────────
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    _setError(errorEl, '');

    const name     = nameEl?.value.trim() || '';
    const email    = emailEl.value.trim();
    const password = passEl.value;
    const confirm  = confirmEl.value;

    // Client-side validation
    if (!email) { _setError(errorEl, 'Email is required.'); return; }
    if (!password) { _setError(errorEl, 'Password is required.'); return; }
    if (password.length < 8) { _setError(errorEl, 'Password must be at least 8 characters.'); return; }
    if (password !== confirm) { _setError(errorEl, 'Passwords do not match.'); return; }

    _setLoading(submitBtn, true);

    try {
      await auth.register(name, email, password);

      // Show success state
      if (form) form.style.display = 'none';
      if (successBox) {
        successBox.style.display = '';
        successBox.querySelector('#success-email').textContent = email;
      }
    } catch (err) {
      if (err.status === 409) {
        _setError(errorEl, 'An account with this email already exists. Try signing in.');
      } else if (err.status === 400) {
        _setError(errorEl, err.message || 'Please check your details and try again.');
      } else {
        _setError(errorEl, err.message || 'Registration failed. Please try again.');
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
  btn.textContent = loading ? 'Creating account…' : 'Create account';
}

function _setError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
