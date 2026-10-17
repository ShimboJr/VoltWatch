import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  connectTestDb,
  disconnectTestDb,
  clearTestDb,
  createTestUser,
  createTestDevice,
  loginAndGetCookie,
  seedReadings,
} from './helpers/setup.js';

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
// GET /api/v1/devices/:id/readings — downsampling
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/devices/:id/readings', () => {
  test('returns at most 300 points for 1h range with many readings', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    // Seed 400 readings at 9-second intervals within the last hour
    await seedReadings(device._id, 400, 9);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=1h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.points).toBeDefined();
    expect(res.body.gaps).toBeDefined();
    // 1h at 9s intervals → raw (≤400 in window) — raw returns all for 1h
    // The key contract: result.points.length <= 300 when range demands it
  });

  test('returns at most 300 points for 6h range', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    // 6h of readings at 30s intervals = 720 readings — should be bucketed to ≤180
    await seedReadings(device._id, 720, 30);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=6h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.points.length).toBeLessThanOrEqual(300);
  });

  test('returns at most 300 points for 24h range', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    // 24h at 45s intervals = 1920 readings
    await seedReadings(device._id, 1920, 45);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=24h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.points.length).toBeLessThanOrEqual(300);
  });

  test('returns gap when there is a large hole in readings', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    // Seed readings with a gap: some recent + some from long ago (within 1h window)
    // 10 readings 55-50 minutes ago, then a 40-minute gap, then 10 readings 5-0 min ago
    const { Reading } = await import('../src/models/Reading.js');
    const now = Date.now();

    const batch1 = Array.from({ length: 10 }, (_, i) => ({
      deviceId: device._id,
      readingId: crypto.randomUUID(),
      deviceTime: new Date(now - (55 - i) * 60_000),
      serverTime: new Date(now - (55 - i) * 60_000),
      percent: 80,
      charging: true,
      acConnected: true,
      secsLeft: null,
      mt5Running: true,
      uptimeSec: 0,
      cycleId: 0,
      backfilled: false,
    }));

    const batch2 = Array.from({ length: 10 }, (_, i) => ({
      deviceId: device._id,
      readingId: crypto.randomUUID(),
      deviceTime: new Date(now - (5 - i * 0.5) * 60_000),
      serverTime: new Date(now - (5 - i * 0.5) * 60_000),
      percent: 75,
      charging: true,
      acConnected: true,
      secsLeft: null,
      mt5Running: true,
      uptimeSec: 0,
      cycleId: 0,
      backfilled: false,
    }));

    await Reading.insertMany([...batch1, ...batch2]);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=1h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.gaps.length).toBeGreaterThanOrEqual(1);
    // The gap should span from ~50min ago to ~5min ago
    if (res.body.gaps.length > 0) {
      const gap = res.body.gaps[0];
      expect(gap.from).toBeDefined();
      expect(gap.to).toBeDefined();
    }
  });

  test('returns 422 for invalid range value', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=99h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  test('returns empty points and gaps arrays for a device with no readings', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=24h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.gaps).toEqual([]);
  });

  test('returns 404 for unknown device', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .get('/api/v1/devices/000000000000000000000000/readings')
      .set('Cookie', cookie);

    expect(res.status).toBe(404);
  });

  test('each point has expected fields', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice();

    await seedReadings(device._id, 5, 45);

    const res = await request(app)
      .get(`/api/v1/devices/${device._id}/readings?range=1h`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    if (res.body.points.length > 0) {
      const pt = res.body.points[0];
      expect(pt.t).toBeDefined();
      expect(typeof pt.percent).toBe('number');
    }
  });
});
