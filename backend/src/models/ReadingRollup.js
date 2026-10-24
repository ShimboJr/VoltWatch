import mongoose from 'mongoose';

const rollupSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  /** UTC floor of the hour this bucket covers. */
  hour: { type: Date, required: true },
  minPercent: { type: Number, required: true },
  maxPercent: { type: Number, required: true },
  avgPercent: { type: Number, required: true },
  samples: { type: Number, required: true },
  onBatterySamples: { type: Number, required: true },
});

rollupSchema.index({ deviceId: 1, hour: 1 }, { unique: true });
// Keep rollup data for 365 days
rollupSchema.index({ hour: 1 }, { expireAfterSeconds: 365 * 86_400 });

export const ReadingRollup = mongoose.model('ReadingRollup', rollupSchema);
