import mongoose from 'mongoose';

export const POWER_EVENT_TYPES = [
  'AC_DISCONNECTED',
  'AC_RECONNECTED',
  'LOW_BATTERY',
  'HEARTBEAT_LOST',
  'HEARTBEAT_RECOVERED',
  'AGENT_STARTED',
  'AGENT_STOPPED_PLANNED',
  'SYSTEM_SHUTDOWN',
  'RESUMED_FROM_SLEEP',
  'UNEXPECTED_SHUTDOWN',
  'MT5_STARTED',
  'MT5_STOPPED',
];

const powerEventSchema = new mongoose.Schema({
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
  type: { type: String, required: true, enum: POWER_EVENT_TYPES },
  at: { type: Date, required: true },
  percent: { type: Number, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  cycleId: { type: Number, default: 0 },
});

powerEventSchema.index({ deviceId: 1, at: -1 });
// TTL: keep events for 180 days
powerEventSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 86_400 });

export const PowerEvent = mongoose.model('PowerEvent', powerEventSchema);
