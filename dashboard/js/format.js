/**
 * format.js — Formatting utilities.
 *
 * All functions are pure (no side-effects) except `startTimeTicker`
 * which sets up a live-ticking interval.
 */

import { store } from './store.js';

// ── Time-ago ──────────────────────────────────────────────────

/**
 * Format a date as a human-readable time-ago string,
 * corrected by the server clock offset stored in the store.
 *
 * @param {string|Date|number} ts  - Timestamp
 * @param {number} nowMs           - Override for "now" (for testing)
 */
export function timeAgo(ts, nowMs) {
  if (!ts) return '—';
  const date = new Date(ts);
  const offset = store.get('clockOffsetMs') || 0;
  const now = nowMs ?? (Date.now() + offset);
  const diffSec = Math.round((now - date.getTime()) / 1000);

  if (diffSec <   0) return 'just now';
  if (diffSec <   5) return 'just now';
  if (diffSec <  60) return `${diffSec}s ago`;
  if (diffSec < 120) return '1m ago';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 7200) return '1h ago';
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return formatTime(date);
}

/**
 * Start a 1-second ticker that calls `onTick()` to update time-ago displays.
 * Returns a cleanup function.
 */
export function startTimeTicker(onTick) {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}

// ── Duration ──────────────────────────────────────────────────

/**
 * Format seconds as a human duration: "2h 10m" or "45m" or "30s"
 */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || totalSeconds < 0) return '—';
  const sec = Math.round(totalSeconds);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * Format seconds remaining into a clock time (e.g. "shuts down at 14:32")
 */
export function shutdownTime(secsLeft) {
  if (!secsLeft || secsLeft <= 0) return null;
  const t = new Date(Date.now() + secsLeft * 1000);
  return formatTime(t);
}

// ── Percent ───────────────────────────────────────────────────

export function formatPct(pct) {
  if (pct == null) return '—';
  return `${Math.round(pct)}%`;
}

// ── Time ──────────────────────────────────────────────────────

export function formatTime(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleTimeString(undefined, opts);
}

export function formatDateTime(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleString(undefined, opts);
}

// ── Power state ───────────────────────────────────────────────

/**
 * Derive a human-readable power state string and a severity key.
 *
 * @param {{ acConnected, charging, percent }} reading
 * @returns {{ text: string, severity: string }}
 */
export function powerState(reading) {
  if (!reading) return { text: 'Unknown', severity: 'unknown' };
  const { acConnected, charging, percent } = reading;
  if (charging)              return { text: 'Charging',              severity: 'info' };
  if (acConnected)           return { text: 'Plugged in, not charging', severity: 'ok' };
  if (percent <= 15)         return { text: 'On battery — critical', severity: 'critical' };
  if (percent <= 30)         return { text: 'On battery — low',     severity: 'warning' };
  return                            { text: 'On battery',           severity: 'battery' };
}

/**
 * Derive a status banner text and state from the enriched status object.
 */
export function statusBanner(status) {
  if (!status) return { text: 'Loading…', state: 'offline' };

  const { deviceStatus, latestReading } = status;

  // Backend returns UPPER_CASE status strings
  switch (deviceStatus) {
    case 'ONLINE':
    case 'ok':
      return latestReading?.acConnected
        ? { text: latestReading.charging ? 'Charging' : 'Healthy — plugged in', state: 'ok' }
        : { text: 'Healthy — on battery', state: 'ok' };
    case 'STALE':
    case 'stale':
      return { text: 'Agent silent (no heartbeat)', state: 'stale' };
    case 'OFFLINE':
    case 'offline':
      return {
        text: `Agent offline since ${formatTime(status.offlineSince || status.lastSeenAt)}`,
        state: 'offline',
      };
    case 'PLANNED_STOP':
    case 'planned_stop':
      return { text: 'Monitoring paused (planned stop)', state: 'offline' };
    case 'NEVER_SEEN':
    case 'never_connected':
      return { text: 'Never connected', state: 'offline' };
    // Legacy lowercase variants from old frontend-derived status
    case 'low_battery':
      return { text: 'Low battery', state: 'warning' };
    case 'critical_battery':
      return { text: 'Critical battery!', state: 'critical' };
    default:
      return { text: 'Connecting…', state: 'offline' };
  }
}

// ── Drain rate ────────────────────────────────────────────────

/**
 * Format a drain-rate object into human text.
 * drainRate: { drainPctPerHour, onBatteryForSec, drainedPct }
 */
export function formatDrainInfo(drainRate) {
  if (!drainRate) return null;
  const { drainPctPerHour, onBatteryForSec, drainedPct } = drainRate;
  const dur = onBatteryForSec ? formatDuration(onBatteryForSec) : null;
  const rate = drainPctPerHour ? `about ${Math.round(drainPctPerHour)}%/h` : null;

  const parts = [];
  if (dur && drainedPct != null) parts.push(`On battery for ${dur}, drained ${Math.round(drainedPct)}%`);
  if (rate) parts.push(`(${rate})`);
  return parts.join(' ') || null;
}

// ── Gauge colour by percent ───────────────────────────────────

export function gaugeColour(pct, acConnected, charging) {
  if (charging)       return 'var(--c-charging)';
  if (acConnected)    return 'var(--c-ok)';
  if (pct <= 15)      return 'var(--c-critical)';
  if (pct <= 30)      return 'var(--c-warning)';
  return                     'var(--c-ok)';
}

export function gaugeSeverity(pct, acConnected, charging) {
  if (charging || acConnected) return 'ok';
  if (pct <= 15) return 'critical';
  if (pct <= 30) return 'warning';
  return 'ok';
}
