import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  connectTestDb,
  disconnectTestDb,
  clearTestDb,
  createTestUser,
  createTestDevice,
  loginAndGetCookie,
  makeHeartbeat,
} from './helpers/setup.js';
import { DEFAULT_SETTINGS } from '../src/models/User.js';
import { deriveStatus } from '../src/services/statusService.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  app = createApp();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveStatus unit tests (boundary conditions from spec section 8)
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveStatus — unit tests', () => {
  const settings = { ...DEFAULT_SETTINGS }; // staleAfterSec=120, offlineAfterSec=180

  function makeDevice(overrides = {}) {
    return {
      _id: new mongoose.Types.ObjectId(),
      lastSeenAt: null,
      plannedStopUntil: null,
      lastReading: null,
      currentCycleId: 0,
      firedLevels: [],
      ...overrides,
    };
  }

  test('NEVER_SEEN when lastSeenAt is null', async () => {
    const result = await deriveStatus(makeDevice({ lastSeenAt: null }), settings);
    expect(result.deviceStatus).toBe('NEVER_SEEN');
    expect(result.severity).toBe('unknown');
  });

  test('ONLINE when age <= staleAfterSec (120s)', async () => {
    const lastSeenAt = new Date(Date.now() - 100_000); // 100s ago
    const result = await deriveStatus(makeDevice({ lastSeenAt }), settings);
    expect(result.deviceStatus).toBe('ONLINE');
    expect(result.severity).toBe('ok');
  });

  test('ONLINE at exactly staleAfterSec boundary (120s)', async () => {
    const lastSeenAt = new Date(Date.now() - 120_000); // exactly 120s ago
    const result = await deriveStatus(makeDevice({ lastSeenAt }), settings);
    expect(result.deviceStatus).toBe('ONLINE');
  });

  test('STALE when age is staleAfterSec+1 (121s)', async () => {
    const lastSeenAt = new Date(Date.now() - 121_000);
    const result = await deriveStatus(makeDevice({ lastSeenAt }), settings);
    expect(result.deviceStatus).toBe('STALE');
    expect(result.severity).toBe('warning');
  });

  test('STALE when age is offlineAfterSec (180s)', async () => {
    const lastSeenAt = new Date(Date.now() - 180_000); // exactly 180s ago
    const result = await deriveStatus(makeDevice({ lastSeenAt }), settings);
    expect(result.deviceStatus).toBe('STALE');
  });

  test('OFFLINE when age is offlineAfterSec+1 (181s)', async () => {
    const lastSeenAt = new Date(Date.now() - 181_000);
    const result = await deriveStatus(makeDevice({ lastSeenAt }), settings);
    expect(result.deviceStatus).toBe('OFFLINE');
    expect(result.severity).toBe('critical');
  });

  test('PLANNED_STOP when plannedStopUntil is in the future', async () => {
    const lastSeenAt = new Date(Date.now() - 500_000); // would be OFFLINE
    const plannedStopUntil = new Date(Date.now() + 60_000);
    const result = await deriveStatus(makeDevice({ lastSeenAt, plannedStopUntil }), settings);
    expect(result.deviceStatus).toBe('PLANNED_STOP');
    expect(result.severity).toBe('ok');
  });

  test('OFFLINE when plannedStopUntil is in the past', async () => {
    const lastSeenAt = new Date(Date.now() - 500_000);
    const plannedStopUntil = new Date(Date.now() - 60_000); // expired
    const result = await deriveStatus(makeDevice({ lastSeenAt, plannedStopUntil }), settings);
    expect(result.deviceStatus).toBe('OFFLINE');
  });

  test('power=CHARGING when charging=true', async () => {
    const lr = { charging: true, acConnected: true, percent: 80 };
    const result = await deriveStatus(makeDevice({ lastSeenAt: new Date(), lastReading: lr }), settings);
    expect(result.power).toBe('CHARGING');
  });

  test('power=PLUGGED_NOT_CHARGING when acConnected=true, charging=false', async () => {
    const lr = { charging: false, acConnected: true, percent: 80 };
    const result = await deriveStatus(makeDevice({ lastSeenAt: new Date(), lastReading: lr }), settings);
    expect(result.power).toBe('PLUGGED_NOT_CHARGING');
  });

  test('power=ON_BATTERY when acConnected=false', async () => {
    const lr = { charging: false, acConnected: false, percent: 50 };
    const result = await deriveStatus(makeDevice({ lastSeenAt: new Date(), lastReading: lr }), settings);
    expect(result.power).toBe('ON_BATTERY');
  });

  test('power=UNKNOWN when lastReading is null', async () => {
    const result = await deriveStatus(makeDevice({ lastSeenAt: new Date(), lastReading: null }), settings);
    expect(result.power).toBe('UNKNOWN');
  });

  test('enriched fields present (null while ONLINE with no battery readings)', async () => {
    const result = await deriveStatus(makeDevice({ lastSeenAt: new Date() }), settings);
    expect(result.predictedEmptyAt).toBeNull();
    expect(result.trendSecsLeft).toBeNull();
    expect(result.diagnosis).toBeNull();
    expect(Array.isArray(result.activeAlerts)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/devices/:id/status — integration tests
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/devices/:id/status', () => {
  test('returns NEVER_SEEN for brand new device', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice('Test Laptop', user._id);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/status`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.deviceStatus).toBe('NEVER_SEEN');
    expect(res.body.severity).toBe('unknown');
  });

  test('returns ONLINE after a fresh heartbeat', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device, token } = await createTestDevice('Test Laptop', user._id);

    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat({ percent: 88, charging: true, acConnected: true }));

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/status`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.deviceStatus).toBe('ONLINE');
    expect(res.body.latestReading.percent).toBe(88);
    expect(res.body.power).toBe('CHARGING');
  });

  test('returns correct power state for ON_BATTERY', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device, token } = await createTestDevice('Test Laptop', user._id);

    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat({ percent: 60, charging: false, acConnected: false, secsLeft: 7200 }));

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/status`)
      .set('Cookie', cookie);

    expect(res.body.power).toBe('ON_BATTERY');
    expect(res.body.windowsSecsLeft).toBe(7200);
  });

  test('returns 401 without session', async () => {
    const { device } = await createTestDevice();
    const res = await request(app).get(`/api/v1/devices/${device._id}/status`);
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown device', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .get('/api/v1/devices/000000000000000000000000/status')
      .set('Cookie', cookie);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings configVersion bump
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/v1/settings — configVersion bump', () => {
  test('bumps configVersion when intervalSec changes', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const before = await request(app)
      .get('/api/v1/settings')
      .set('Cookie', cookie);
    const prevVersion = before.body.settings.configVersion;

    await request(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ intervalSec: 30 });

    const after = await request(app)
      .get('/api/v1/settings')
      .set('Cookie', cookie);

    expect(after.body.settings.configVersion).toBe(prevVersion + 1);
    expect(after.body.settings.intervalSec).toBe(30);
  });

  test('does NOT bump configVersion when only theme changes', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const before = await request(app).get('/api/v1/settings').set('Cookie', cookie);
    const prevVersion = before.body.settings.configVersion;

    await request(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ theme: 'light' });

    const after = await request(app).get('/api/v1/settings').set('Cookie', cookie);
    expect(after.body.settings.configVersion).toBe(prevVersion);
  });

  test('rejects intervalSec outside 30-60 range', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ intervalSec: 15 }); // below minimum

    expect(res.status).toBe(422);
  });
});
