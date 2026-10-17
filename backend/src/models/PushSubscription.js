import mongoose from 'mongoose';

/**
 * PushSubscription — stores a Web Push endpoint for one browser/device.
 *
 * One user (always the owner in VoltWatch) can have many subscriptions —
 * phone, tablet, desktop, etc. Each subscription is identified by its
 * unique `endpoint` URL provided by the browser.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    endpoint: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    keys: {
      p256dh: { type: String, required: true },
      auth:   { type: String, required: true },
    },

    /** Best-effort label from the registering browser (User-Agent trimmed). */
    userAgent: { type: String, default: '' },

    /** Friendly name set by the user (e.g. "iPhone 15"). */
    label: { type: String, default: '' },

    /** The deviceId this subscription was registered from (informational). */
    deviceId: { type: String, default: '' },

    lastSuccessAt: { type: Date, default: null },
    lastErrorAt:   { type: Date, default: null },
    lastErrorCode: { type: Number, default: null },

    /** True once the endpoint returns 404/410 and we remove it next cleanup. */
    dead: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound index: fast owner lookup
pushSubscriptionSchema.index({ userId: 1, dead: 1 });

export const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
