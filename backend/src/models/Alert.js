import mongoose from 'mongoose';

export const ALERT_SEVERITIES = ['info', 'warning', 'high', 'critical'];
export const ALERT_STATES = ['active', 'acknowledged', 'resolved'];

const alertSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
  },
  type: { type: String, required: true },
  severity: { type: String, enum: ALERT_SEVERITIES, required: true },
  /** Battery threshold level, if applicable (e.g. 30 for the 30% threshold). */
  level: { type: Number, default: null },
  cycleId: { type: Number, default: null },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  state: { type: String, enum: ALERT_STATES, default: 'active' },
  acknowledgedAt: { type: Date, default: null },
  /** When set, suppresses repeat notifications until this time. */
  snoozedUntil: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  /** Timestamp of the most recent repeat notification. */
  lastRepeatAt: { type: Date, default: null },
  /**
   * Composite dedup key prevents duplicate alerts for the same condition.
   * Format: "deviceId:type:level:cycleId" or "deviceId:HEARTBEAT_LOST:episodeId"
   */
  dedupeKey: { type: String, default: null },
});

alertSchema.index({ state: 1, createdAt: -1 });
// sparse: true means documents without dedupeKey are excluded from the unique constraint
alertSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const Alert = mongoose.model('Alert', alertSchema);
