import mongoose from 'mongoose';

/** Embedded snapshot of the most recent reading on the device. */
const lastReadingSchema = new mongoose.Schema(
  {
    percent: Number,
    charging: Boolean,
    acConnected: Boolean,
    secsLeft: { type: Number, default: null },
    mt5Running: Boolean,
    deviceTime: Date,
    serverTime: Date,
  },
  { _id: false },
);

const deviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  hostname: { type: String, default: null },
  os: { type: String, default: null },
  agentVersion: { type: String, default: null },
  /** SHA-256 hex of the bearer token. Never store the plaintext. */
  tokenHash: { type: String, required: true },
  tokenRotatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  alertsPaused: { type: Boolean, default: false },
  /** Increments on each AC_DISCONNECTED event; used for alert dedup. */
  currentCycleId: { type: Number, default: 0 },
  /** Battery threshold levels already fired in the current cycle. */
  firedLevels: { type: [Number], default: [] },
  lastReading: { type: lastReadingSchema, default: null },
  lastSeenAt: { type: Date, default: null },
  /** Set when agent signals a planned stop; suppresses HEARTBEAT_LOST. */
  plannedStopUntil: { type: Date, default: null },
  /** When MT5 first went offline (for debounce timer). Null while MT5 is running. */
  mt5OffSince: { type: Date, default: null },
  /** True when MT5_NOT_RUNNING alert has already been fired in the current cycle. */
  mt5AlertFired: { type: Boolean, default: false },
  /** cycleId of the last offline alert, to avoid re-firing per episode. */
  lastOfflineAlertCycle: { type: Number, default: 0 },
});

export const Device = mongoose.model('Device', deviceSchema);
