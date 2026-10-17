import mongoose from 'mongoose';

/** Default settings for the single owner (spec section 7). */
export const DEFAULT_SETTINGS = Object.freeze({
  thresholds: [50, 30, 20, 15],
  criticalLevel: 15,
  criticalRepeatMin: 5,
  offlineAfterSec: 180,
  staleAfterSec: 120,
  intervalSec: 45,
  mt5Alert: true,
  mt5DebounceSec: 120,
  quietHours: { enabled: false, from: '23:00', to: '06:00' },
  alarmSound: 'siren',
  alarmVolume: 0.8,
  vibrate: true,
  theme: 'dark',
  timeZone: 'Africa/Lagos',
  retentionDays: 30,
  configVersion: 1,
});

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: { type: String, required: true },
  /** All user-configurable settings (spec section 7). */
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({ ...DEFAULT_SETTINGS }),
  },
  /** Consecutive failed login count; reset on success. */
  failedLogins: { type: Number, default: 0 },
  /** Non-null while account is locked due to too many failures. */
  lockedUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

export const User = mongoose.model('User', userSchema);
