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

  /**
   * Reset all user-session state to initial defaults.
   * Call this on logout and at the start of _afterLogin so stale data
   * from a previous session is never visible to the incoming user.
   */
  reset() {
    const defaults = {
      user:          null,
      deviceId:      null,
      devices:       [],
      status:        null,
      alerts:        [],
      unreadAlerts:  0,
      connection:    'offline',
      clockOffsetMs: 0,
      settings: {
        theme: 'dark',
        alarmVolume: 0.8,
        alertsPaused: false,
      },
      soundArmed:    false,
      criticalActive: false,
    };
    Object.entries(defaults).forEach(([key, val]) => {
      _state[key] = val;
      _notify(key);
    });
  },

  /** Subscribe to any key change: fn(key, value) */
  subscribeAll(fn) {
    return this.subscribe('*', fn);
  },
};
