/**
 * sound.js — Web Audio API alarm system.
 *
 * Mobile browsers block audio until a user gesture. We require the user to
 * "arm" the alarm with one tap before any sound plays. The arm-prompt
 * is shown persistently until done.
 *
 * API:
 *   sound.arm()        — call from a user tap to unlock audio context
 *   sound.isArmed()    — true after arm()
 *   sound.playAlarm()  — loop a critical alarm (if armed)
 *   sound.stopAlarm()  — stop looping alarm
 *   sound.playChime()  — soft single chime for non-critical alerts
 *   sound.setVolume(v) — 0.0 – 1.0
 */

let _ctx = null;
let _armed = false;
let _volume = 0.8;
let _alarmNode = null;
let _alarmInterval = null;

function _getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

function _resume() {
  const ctx = _getCtx();
  if (ctx.state === 'suspended') return ctx.resume();
  return Promise.resolve();
}

/** Play a synthesised tone burst (alarm or chime) */
function _playTone(frequency, duration, type = 'sine', gain = 1.0) {
  const ctx = _getCtx();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(_volume * gain, ctx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  g.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime);
  osc.connect(g);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

/** Synthesise a 3-pulse alarm burst */
function _alarmBurst() {
  _playTone(880, 0.15, 'square', 0.6);
  setTimeout(() => _playTone(1100, 0.15, 'square', 0.7), 180);
  setTimeout(() => _playTone(880,  0.2,  'square', 0.5), 360);
}

/** Soft chime: two-note ascending */
function _softChime() {
  _playTone(660, 0.25, 'sine', 0.4);
  setTimeout(() => _playTone(880, 0.3, 'sine', 0.3), 150);
}

// ── Public API ────────────────────────────────────────────────

export const sound = {
  arm() {
    _armed = true;
    _resume().catch(() => {});
    // Play a silent sound to unlock audio context on iOS
    const ctx = _getCtx();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    return this;
  },

  isArmed() { return _armed; },

  setVolume(v) {
    _volume = Math.max(0, Math.min(1, v));
    return this;
  },

  async playAlarm() {
    if (!_armed) return;
    await _resume();
    if (_alarmInterval) return; // already running
    _alarmBurst();
    _alarmInterval = setInterval(_alarmBurst, 2200);
    // Vibration where supported
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 600]);
  },

  stopAlarm() {
    if (_alarmInterval) {
      clearInterval(_alarmInterval);
      _alarmInterval = null;
    }
    if (navigator.vibrate) navigator.vibrate(0);
  },

  async playChime() {
    if (!_armed) return;
    await _resume();
    _softChime();
  },

  isAlarmPlaying() { return _alarmInterval !== null; },
};
