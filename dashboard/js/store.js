/**
 * store.js — Tiny reactive pub/sub store.
 *
 * Usage:
 *   store.set('status', { ... });
 *   store.subscribe('status', (val) => { ... });
 *   store.get('status');
 */

const _state = {
  /** Current authenticated user (null = not logged in) */
  user: null,

  /** Active device ID */
  deviceId: null,

  /** List of user's devices */
  devices: [],

  /** Enriched status for the active device */
  status: null,

  /** Active (unacked) alerts */
  alerts: [],

  /** Unread alert count (for badge) */
  unreadAlerts: 0,

  /** Connection state: 'live' | 'polling' | 'offline' */
  connection: 'offline',

  /** Server clock offset in ms (server - client) */
  clockOffsetMs: 0,

  /** User settings */
  settings: {
    theme: 'dark',
    alarmVolume: 0.8,
    alertsPaused: false,
  },

  /** Whether alarm sound is armed by user tap */
  soundArmed: false,

  /** Whether a critical takeover is currently showing */
  criticalActive: false,
};

const _subs = {};

function _notify(key) {
  (_subs[key] || []).forEach(fn => {
    try { fn(_state[key]); } catch (e) { console.error('[store]', e); }
  });
  (_subs['*'] || []).forEach(fn => {
    try { fn(key, _state[key]); } catch (e) { console.error('[store]', e); }
  });
}

export const store = {
  get(key) {
    return _state[key];
  },

  set(key, value) {
    _state[key] = value;
    _notify(key);
  },

  update(key, partial) {
    _state[key] = { ..._state[key], ...partial };
    _notify(key);
  },

  subscribe(key, fn) {
    if (!_subs[key]) _subs[key] = [];
    _subs[key].push(fn);
    // Immediately call with current value
    try { fn(_state[key]); } catch (e) { console.error('[store]', e); }
    // Return unsubscribe fn
    return () => {
      _subs[key] = _subs[key].filter(f => f !== fn);
    };
  },

  /** Subscribe to any key change: fn(key, value) */
  subscribeAll(fn) {
    return this.subscribe('*', fn);
  },
};
