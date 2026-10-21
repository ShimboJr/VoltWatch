/**
 * webPushNotifier.test.js — Unit tests for WebPushNotifier.
 *
 * Tests the pure buildPayload() function and dead-subscription cleanup.
 * Uses an in-memory MongoDB instance via mongodb-memory-server.
 *
 * Run with:  npm test -- webPushNotifier
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ── buildPayload import ───────────────────────────────────────────────────────

// The module uses web-push internally but buildPayload() is pure — no network
import { buildPayload, cleanupDeadSubscriptions } from '../src/services/notifier/webPush.js';
import { PushSubscription }  from '../src/models/PushSubscription.js';

// ── Test setup ────────────────────────────────────────────────────────────────

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await PushSubscription.deleteMany({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeAlert = (overrides = {}) => ({
  _id:     new mongoose.Types.ObjectId(),
  level:   'high',
  type:    'LOW_BATTERY',
  message: 'Battery at 15%',
  ...overrides,
});

const makeDevice = (overrides = {}) => ({
  _id:           new mongoose.Types.ObjectId(),
  name:          'Trading Laptop',
  alertsPaused:  false,
  userId:        new mongoose.Types.ObjectId(),
  ...overrides,
});

const makeSettings = (overrides = {}) => ({
  quietHours:    { enabled: false, from: '22:00', to: '07:00' },
  alarmVolume:   0.8,
  ...overrides,
});

// ── buildPayload() ────────────────────────────────────────────────────────────

describe('buildPayload()', () => {
  test('returns payload for a high-level alert', () => {
    const result = buildPayload(makeAlert(), makeDevice(), makeSettings());

    expect(result).not.toBeNull();
    expect(result.payload).toBeDefined();

    const data = JSON.parse(result.payload);
    expect(data.title).toContain('Trading Laptop');
    expect(data.body).toBe('Battery at 15%');
    expect(data.vibrate).toHaveLength(3);    // high = [200, 100, 200]
  });

  test('critical alert uses "high" urgency and long vibration', () => {
    const result = buildPayload(
      makeAlert({ level: 'critical', message: 'Battery at 5%' }),
      makeDevice(),
      makeSettings(),
    );

    expect(result).not.toBeNull();
    expect(result.options.urgency).toBe('high');
    expect(result.options.TTL).toBe(3600);

    const data = JSON.parse(result.payload);
    expect(data.title).toMatch(/CRITICAL/);
    expect(data.vibrate).toHaveLength(5);    // critical = [200, 100, 200, 100, 600]
  });

  test('HEARTBEAT_LOST is treated as critical regardless of level', () => {
    const result = buildPayload(
      makeAlert({ level: 'high', type: 'HEARTBEAT_LOST', message: 'Agent offline' }),
      makeDevice(),
      makeSettings(),
    );

    expect(result).not.toBeNull();
    expect(result.options.urgency).toBe('high');
    const data = JSON.parse(result.payload);
    expect(data.title).toMatch(/CRITICAL/);
  });

  test('info-level alert has normal urgency and short TTL', () => {
    const result = buildPayload(
      makeAlert({ level: 'info', message: 'AC restored' }),
      makeDevice(),
      makeSettings(),
    );

    expect(result).not.toBeNull();
    expect(result.options.urgency).toBe('normal');
    expect(result.options.TTL).toBe(600);
  });

  test('returns null when alerts are paused (non-critical)', () => {
    const result = buildPayload(
      makeAlert({ level: 'high' }),
      makeDevice({ alertsPaused: true }),
      makeSettings(),
    );

    expect(result).toBeNull();
  });

  test('critical alert is NOT suppressed even when alerts are paused', () => {
    const result = buildPayload(
      makeAlert({ level: 'critical' }),
      makeDevice({ alertsPaused: true }),
      makeSettings(),
    );

    expect(result).not.toBeNull();
  });

  test('returns null during quiet hours (non-critical)', () => {
    // Mock "now" is inside quiet hours
    const RealDate = Date;
    const mockDate = new Date('2026-01-01T23:30:00');
    global.Date = class extends RealDate {
      constructor(...args) { return args.length ? new RealDate(...args) : mockDate; }
      static now() { return mockDate.getTime(); }
    };

    const result = buildPayload(
      makeAlert({ level: 'high' }),
      makeDevice(),
      makeSettings({ quietHours: { enabled: true, from: '22:00', to: '07:00' } }),
    );

    global.Date = RealDate;
    expect(result).toBeNull();
  });

  test('critical alert fires DURING quiet hours', () => {
    const RealDate = Date;
    const mockDate = new Date('2026-01-01T23:30:00');
    global.Date = class extends RealDate {
      constructor(...args) { return args.length ? new RealDate(...args) : mockDate; }
      static now() { return mockDate.getTime(); }
    };

    const result = buildPayload(
      makeAlert({ level: 'critical' }),
      makeDevice(),
      makeSettings({ quietHours: { enabled: true, from: '22:00', to: '07:00' } }),
    );

    global.Date = RealDate;
    expect(result).not.toBeNull();
  });

  test('quiet hours overnight range (e.g. 22:00 → 07:00)', () => {
    // Test the boundary — 06:59 inside, 07:01 outside
    const RealDate = Date;

    for (const [timeStr, expectedNull] of [
      ['2026-01-01T06:59:00', true],   // inside
      ['2026-01-01T07:01:00', false],  // outside
      ['2026-01-01T22:01:00', true],   // inside
      ['2026-01-01T21:59:00', false],  // outside
    ]) {
      const mockDate = new Date(timeStr);
      global.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : mockDate; }
        static now() { return mockDate.getTime(); }
      };

      const result = buildPayload(
        makeAlert({ level: 'high' }),
        makeDevice(),
        makeSettings({ quietHours: { enabled: true, from: '22:00', to: '07:00' } }),
      );

      global.Date = RealDate;
      if (expectedNull) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
      }
    }
  });

  test('notification tag is unique per alertId', () => {
    const alert  = makeAlert({ level: 'high' });
    const result = buildPayload(alert, makeDevice(), makeSettings());

    expect(result.options.topic).toBe(`alert-${alert._id}`);
  });
});

// ── cleanupDeadSubscriptions() ────────────────────────────────────────────────

describe('cleanupDeadSubscriptions()', () => {
  const userId = new mongoose.Types.ObjectId();

  const makeSub = (endpoint, dead = false) => ({
    userId,
    endpoint,
    keys: { p256dh: 'fakekey', auth: 'fakeauth' },
    dead,
  });

  test('deletes subscriptions marked dead', async () => {
    await PushSubscription.insertMany([
      makeSub('https://push.example.com/alive', false),
      makeSub('https://push.example.com/dead1', true),
      makeSub('https://push.example.com/dead2', true),
    ]);

    const count = await cleanupDeadSubscriptions();

    expect(count).toBe(2);
    const remaining = await PushSubscription.find({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe('https://push.example.com/alive');
  });

  test('returns 0 when no dead subscriptions exist', async () => {
    await PushSubscription.insertMany([
      makeSub('https://push.example.com/ok1', false),
      makeSub('https://push.example.com/ok2', false),
    ]);

    const count = await cleanupDeadSubscriptions();
    expect(count).toBe(0);
  });

  test('returns 0 when collection is empty', async () => {
    const count = await cleanupDeadSubscriptions();
    expect(count).toBe(0);
  });
});
