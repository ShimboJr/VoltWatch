import mongoose from 'mongoose';

// TTL is read from env at module load; changing RETENTION_DAYS requires
// manually updating the TTL index via collMod or dropping and recreating it.
const retentionSec = parseInt(process.env.RETENTION_DAYS || '30', 10) * 86_400;

const readingSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
  },
  /** UUID sent by the agent; used for idempotency. Unique per device. */
  readingId: { type: String, required: true },
  deviceTime: { type: Date, required: true },
  serverTime: { type: Date, required: true },
  percent: { type: Number, required: true, min: 0, max: 100 },
  charging: { type: Boolean, required: true },
  acConnected: { type: Boolean, required: true },
  secsLeft: { type: Number, default: null },
  mt5Running: { type: Boolean, required: true },
  uptimeSec: { type: Number, required: true },
  internetLatencyMs: { type: Number, default: null },
  cycleId: { type: Number, default: 0 },
  /** True when this reading arrived via the batch upload endpoint. */
  backfilled: { type: Boolean, default: false },
});

readingSchema.index({ deviceId: 1, deviceTime: 1 });
readingSchema.index({ deviceId: 1, readingId: 1 }, { unique: true });
// TTL: auto-delete old readings after retentionSec seconds
readingSchema.index({ serverTime: 1 }, { expireAfterSeconds: retentionSec });

export const Reading = mongoose.model('Reading', readingSchema);
