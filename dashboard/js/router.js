/**
 * router.js — Minimal hash router with page transitions.
 *
 * Routes are registered with router.on('#/path', handlerFn).
 * The handler receives { params } from the URL.
 * Transitions use CSS class toggling.
 */

const _routes = [];
let _current = null;
let _beforeEach = null;

export const router = {
  /**
   * Register a route.
   * @param {string} hash     — e.g. '#/live' or '#/alerts'
   * @param {Function} handler — called with (params) when route activates
   */
  on(hash, handler) {
    _routes.push({ hash, handler });
    return this;
  },

  /** Register a global guard called before each navigation. */
  beforeEach(fn) {
    _beforeEach = fn;
    return this;
  },

  /** Navigate programmatically. */
  go(hash) {
    location.hash = hash;
  },

  /** Start the router (call once on app init). */
  start() {
    window.addEventListener('hashchange', () => this._dispatch());
    this._dispatch();
    return this;
  },

  _dispatch() {
    const hash = location.hash || '#/login';

    if (_beforeEach) {
      const allow = _beforeEach(hash);
      if (allow === false) return;
    }

    // Find the matching route (exact or prefix match)
    const route = _routes.find(r => {
      if (r.hash === hash) return true;
      if (r.hash.endsWith('*') && hash.startsWith(r.hash.slice(0, -1))) return true;
      return false;
    });

    if (!route) {
      // 404 → home
      location.hash = '#/live';
      return;
    }

    _current = hash;
    route.handler({ hash });

    // Update active states on tab bar and sidebar
    document.querySelectorAll('[data-route]').forEach(el => {
      const target = el.getAttribute('data-route');
      el.classList.toggle('active', hash.startsWith(target));
    });
  },

  current() { return _current; },
};
