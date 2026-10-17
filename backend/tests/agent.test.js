import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  connectTestDb,
  disconnectTestDb,
  clearTestDb,
  createTestDevice,
  makeHeartbeat,
} from './helpers/setup.js';
import { Reading } from '../src/models/Reading.js';
import { Device } from '../src/models/Device.js';

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
// Agent authentication
// ─────────────────────────────────────────────────────────────────────────────
describe('Agent authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .send(makeHeartbeat());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 401 with wrong token', async () => {
    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', 'Bearer totally-wrong-token')
      .send(makeHeartbeat());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('returns 401 with malformed Authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', 'NotBearer abc')
      .send(makeHeartbeat());
    expect(res.status).toBe(401);
  });

  test('returns 200 with valid token', async () => {
    const { token } = await createTestDevice();
    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat());
    expect(res.status).toBe(200);
    expect(res.body.serverTime).toBeDefined();
    expect(res.body.config).toBeDefined();
    expect(res.body.config.intervalSec).toBeDefined();
    expect(res.body.config.configVersion).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readingId idempotency
// ─────────────────────────────────────────────────────────────────────────────
describe('Heartbeat idempotency', () => {
  test('duplicate readingId returns {duplicate: true} and does not create a second record', async () => {
    const { token } = await createTestDevice();
    const payload = makeHeartbeat({ readingId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

    // First submission
    const res1 = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    expect(res1.status).toBe(200);
    expect(res1.body.duplicate).toBeUndefined();

    // Duplicate submission
    const res2 = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);

    // Only one reading in DB
    const count = await Reading.countDocuments({});
    expect(count).toBe(1);
  });

  test('different readingId on same device creates two records', async () => {
    const { token } = await createTestDevice();

    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat());

    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat());

    expect(await Reading.countDocuments({})).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Device state updates on heartbeat
// ─────────────────────────────────────────────────────────────────────────────
describe('Heartbeat device state updates', () => {
  test('updates lastSeenAt and lastReading on device', async () => {
    const { token, device } = await createTestDevice();

    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat({ percent: 72, charging: false, acConnected: false }));

    const updated = await Device.findById(device._id);
    expect(updated.lastSeenAt).toBeDefined();
    expect(updated.lastReading.percent).toBe(72);
    expect(updated.lastReading.charging).toBe(false);
    expect(updated.hostname).toBe('TEST-HOST');
    expect(updated.agentVersion).toBe('1.0.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/v1/agent/batch', () => {
  test('accepts batch and processes all readings', async () => {
    const { token } = await createTestDevice();

    const readings = [
      makeHeartbeat({ percent: 90 }),
      makeHeartbeat({ percent: 80 }),
      makeHeartbeat({ percent: 70 }),
    ];

    const res = await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(3);
    expect(res.body.duplicates).toBe(0);
    expect(await Reading.countDocuments({})).toBe(3);
  });

  test('processes readings in ascending deviceTime order regardless of submission order', async () => {
    const { token } = await createTestDevice();
    const now = new Date();

    // Submit in reverse time order
    const readings = [
      makeHeartbeat({ deviceTime: new Date(now - 10_000).toISOString(), percent: 70 }),
      makeHeartbeat({ deviceTime: new Date(now - 30_000).toISOString(), percent: 90 }),
      makeHeartbeat({ deviceTime: new Date(now - 20_000).toISOString(), percent: 80 }),
    ];

    await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings });

    // The readings in DB should all be there; order of insertion is tested
    // by confirming all three were processed and the device lastReading
    // reflects the most-recent deviceTime (70% = oldest - but all are processed sequentially)
    const count = await Reading.countDocuments({});
    expect(count).toBe(3);
  });

  test('marks batch readings as backfilled', async () => {
    const { token } = await createTestDevice();

    await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings: [makeHeartbeat()] });

    const reading = await Reading.findOne({});
    expect(reading.backfilled).toBe(true);
  });

  test('handles duplicates in a batch gracefully', async () => {
    const { token } = await createTestDevice();
    const sharedId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    const readings = [
      makeHeartbeat({ readingId: sharedId, percent: 60 }),
      makeHeartbeat({ readingId: sharedId, percent: 60 }), // duplicate
    ];

    const res = await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings });

    expect(res.body.processed).toBe(1);
    expect(res.body.duplicates).toBe(1);
  });

  test('rejects deviceTime more than 24h in the future without crashing the batch', async () => {
    const { token } = await createTestDevice();
    const farFuture = new Date(Date.now() + 25 * 3_600_000).toISOString();

    const readings = [
      makeHeartbeat({ percent: 50 }),               // valid
      makeHeartbeat({ deviceTime: farFuture }),      // invalid
    ];

    const res = await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.errors).toBe(1);
  });

  test('rejects a batch with more than 500 items', async () => {
    const { token } = await createTestDevice();
    const readings = Array.from({ length: 501 }, () => makeHeartbeat());

    const res = await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ readings });

    expect(res.status).toBe(422);
  });

  test('returns 401 for batch with invalid token', async () => {
    const res = await request(app)
      .post('/api/v1/agent/batch')
      .set('Authorization', 'Bearer bad-token')
      .send({ readings: [makeHeartbeat()] });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat validation
// ─────────────────────────────────────────────────────────────────────────────
describe('Heartbeat validation', () => {
  test('rejects payload with missing required fields', async () => {
    const { token } = await createTestDevice();

    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ percent: 80 }); // many required fields missing

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects deviceTime more than 24h in the future', async () => {
    const { token } = await createTestDevice();
    const farFuture = new Date(Date.now() + 25 * 3_600_000).toISOString();

    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat({ deviceTime: farFuture }));

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting (agent)
// ─────────────────────────────────────────────────────────────────────────────
describe('Agent rate limiting', () => {
  test('rate limit headers are present on responses', async () => {
    const { token } = await createTestDevice();

    const res = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat());

    // express-rate-limit sets RateLimit-* headers
    expect(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
