/**
 * api.js — Fetch wrapper for the VoltWatch backend.
 *
 * Features:
 *  - credentials: 'same-origin', X-Requested-With header
 *  - JSON error parsing with friendly messages
 *  - 401 → redirect to login (unless already there)
 *  - 15-second timeout
 *  - One automatic retry on network error (not on 4xx/5xx)
 */

const API_TIMEOUT_MS = 15_000;
const MAX_RETRIES    = 1;

/** Base URL resolved from window.VOLTWATCH_API or Vercel rewrite. */
export const BASE = window.VOLTWATCH_API ?? '/api/v1';

// ── Core fetch ────────────────────────────────────────────────

async function _fetch(path, options = {}, attempt = 0) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'voltwatch',
        ...options.headers,
      },
      signal: controller.signal,
      ...options,
    });

    clearTimeout(tid);

    // 401 → back to login
    if (res.status === 401) {
      if (!location.hash.startsWith('#/login')) {
        location.hash = '#/login';
      }
      throw new ApiError(401, 'Session expired. Please log in again.');
    }

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        // Backend errors come as { error: { code, message } } or { message } or { error: "string" }
        if (typeof body?.error?.message === 'string') {
          message = body.error.message;
        } else if (typeof body?.message === 'string') {
          message = body.message;
        } else if (typeof body?.error === 'string') {
          message = body.error;
        }
      } catch { /* ignore parse errors */ }
      throw new ApiError(res.status, message);
    }

    // 204 No Content
    if (res.status === 204) return null;

    return res.json();
  } catch (err) {
    clearTimeout(tid);

    if (err instanceof ApiError) throw err;

    // Network error or timeout — retry once
    if (attempt < MAX_RETRIES) {
      await _delay(500);
      return _fetch(path, options, attempt + 1);
    }

    throw new ApiError(0, err.name === 'AbortError'
      ? 'Request timed out. Check your connection.'
      : `Network error: ${err.message}`);
  }
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── ApiError class ────────────────────────────────────────────

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

// ── Public methods ────────────────────────────────────────────

export const api = {
  get:    (path, opts)        => _fetch(path, { method: 'GET', ...opts }),
  post:   (path, body, opts)  => _fetch(path, { method: 'POST',  body: JSON.stringify(body), ...opts }),
  put:    (path, body, opts)  => _fetch(path, { method: 'PUT',   body: JSON.stringify(body), ...opts }),
  patch:  (path, body, opts)  => _fetch(path, { method: 'PATCH', body: JSON.stringify(body), ...opts }),
  delete: (path, opts)        => _fetch(path, { method: 'DELETE', ...opts }),
};

// ── Auth endpoints ────────────────────────────────────────────

export const auth = {
  login:               (email, password)   => api.post('/auth/login',  { email, password }),
  logout:              ()                  => api.post('/auth/logout', {}),
  me:                  ()                  => api.get('/auth/me'),
  changePassword:      (current, next)     => api.post('/auth/change-password', { current, next }),
  signOutAll:          ()                  => api.post('/auth/sign-out-all', {}),
  register:            (name, email, password) => api.post('/auth/register', { name, email, password }),
  resendVerification:  (email)             => api.post('/auth/resend-verification', { email }),
};

// ── Status / live data ────────────────────────────────────────

export const status = {
  // Correct backend route: GET /api/v1/devices/:id/status
  get: (deviceId) => api.get(`/devices/${deviceId}/status`),
};

// ── Alerts ───────────────────────────────────────────────────

export const alerts = {
  list:        (params = {})       => api.get('/alerts?' + new URLSearchParams(params)),
  acknowledge: (id)                => api.post(`/alerts/${id}/ack`, {}),
  snooze:      (id, minutes = 10)  => api.post(`/alerts/${id}/snooze`, { minutes }),
  delete:      (id)                => api.delete(`/alerts/${id}`),
  test:        ()                  => api.post('/alerts/test', {}),
};

// ── Devices ───────────────────────────────────────────────────

export const devices = {
  list:        ()      => api.get('/devices'),
  get:         (id)    => api.get(`/devices/${id}`),
  create:      (body)  => api.post('/devices', body),
  update:      (id, b) => api.patch(`/devices/${id}`, b),
  rotateToken: (id)    => api.post(`/devices/${id}/rotate-token`, {}),
  delete:      (id)    => api.delete(`/devices/${id}`),
};

// ── Settings ──────────────────────────────────────────────────

/**
 * Translate the frontend's field names to the backend schema names,
 * and strip any keys the backend Zod schema doesn't accept (.strict()).
 *
 * Backend-accepted keys (from routes/settings.js schema):
 *   thresholds, criticalLevel, criticalRepeatMin, offlineAfterSec,
 *   staleAfterSec, intervalSec, mt5Alert, mt5DebounceSec, quietHours,
 *   alarmSound, alarmVolume, vibrate, theme, timeZone, retentionDays
 *
 * Frontend-only keys that must be dropped: keepAwakeDefault, timeFormat,
 *   configVersion (internal), alertsPaused (device-level, not settings).
 */
function _mapSettingsToBackend(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      // ── Renames ──────────────────────────────────────────────────────────
      case 'alertThresholds':       out.thresholds       = v; break;
      case 'mt5AlertEnabled':       out.mt5Alert         = v; break;
      case 'heartbeatIntervalSec':  out.intervalSec      = v; break;
      case 'offlineThresholdSec':   out.offlineAfterSec  = v; break;
      case 'vibration':             out.vibrate          = v; break;
      case 'timezone':              out.timeZone         = v; break;
      // quietHours: remap start/end → from/to
      case 'quietHours': {
        const qh = { ...v };
        if ('start' in qh) { qh.from = qh.start; delete qh.start; }
        if ('end'   in qh) { qh.to   = qh.end;   delete qh.end;   }
        out.quietHours = qh;
        break;
      }
      // ── Drop: no backend field / internal-only ────────────────────────
      case 'keepAwakeDefault': break;
      case 'timeFormat':       break;
      case 'configVersion':    break;  // managed by backend, not writable via API
      case 'alertsPaused':     break;  // device-level setting, not user settings
      // ── Pass-through: already-correct backend names ────────────────────
      default: out[k] = v;
    }
  }
  return out;
}

export const settings = {
  get:           ()     => api.get('/settings'),
  // Backend only has PUT /settings (no PATCH). Translate field names on the way out.
  save:          (body) => api.put('/settings', _mapSettingsToBackend(body)),
  update:        (body) => api.put('/settings', _mapSettingsToBackend(body)), // alias
  deleteHistory: ()     => api.delete('/settings/history'),
};

// ── SSE stream URL ────────────────────────────────────────────

export function streamUrl(deviceId) {
  return `${BASE}/stream${deviceId ? `?deviceId=${deviceId}` : ''}`;
}

// ── Readings (history) ────────────────────────────────────────

export const readings = {
  /**
   * @param {string} deviceId
   * @param {{ since, until, limit, cursor }} params
   */
  list: (deviceId, params = {}) =>
    api.get(`/devices/${deviceId}/readings?` + new URLSearchParams(_clean(params))),
};

// ── Events (timeline) ─────────────────────────────────────────

export const events = {
  /**
   * @param {string} deviceId
   * @param {{ before, limit, types }} params
   */
  list: (deviceId, params = {}) =>
    api.get(`/devices/${deviceId}/events?` + new URLSearchParams(_clean(params))),
};

// ── Insights ──────────────────────────────────────────────────

export const insights = {
  get: (deviceId, range = '7d') =>
    api.get(`/devices/${deviceId}/insights?range=${range}`),
};

function _clean(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}
