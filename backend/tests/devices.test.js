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
import { Device } from '../src/models/Device.js';
import { Reading } from '../src/models/Reading.js';
import { Alert } from '../src/models/Alert.js';
import { hashToken } from '../src/services/tokenService.js';

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
// POST /api/v1/devices — create
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/v1/devices', () => {
  test('creates a device and returns a plaintext token once', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .post('/api/v1/devices')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ name: 'My Laptop' });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.device.name).toBe('My Laptop');

    // Token must NOT appear in the device object
    expect(res.body.device.tokenHash).toBeUndefined();
  });

  test('stores only the SHA-256 hash in the database, never the plaintext', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .post('/api/v1/devices')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ name: 'Hash Test Device' });

    const { token, device: { _id: deviceId } } = res.body;

    const dbDevice = await Device.findById(deviceId);
    expect(dbDevice.tokenHash).toBeDefined();
    // tokenHash must equal sha256(token)
    expect(dbDevice.tokenHash).toBe(hashToken(token));
    // plaintext must NOT be stored
    expect(dbDevice.tokenHash).not.toBe(token);
  });

  test('returns 401 without session', async () => {
    const res = await request(app)
      .post('/api/v1/devices')
      .set('X-Requested-With', 'voltwatch')
      .send({ name: 'Ghost' });

    expect(res.status).toBe(401);
  });

  test('returns 422 for missing name', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);

    const res = await request(app)
      .post('/api/v1/devices')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({});

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/devices
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/devices', () => {
  test('returns list without tokenHash exposed', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    await createTestDevice('Dev A', user._id);
    await createTestDevice('Dev B', user._id);

    const res = await request(app)
      .get('/api/v1/devices')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(2);
    res.body.devices.forEach((d) => expect(d.tokenHash).toBeUndefined());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/devices/:id/rotate-token
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/v1/devices/:id/rotate-token', () => {
  test('rotated token is returned once and old token stops working', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device, token: oldToken } = await createTestDevice('Rotate Me', user._id);

    // Old token works before rotation
    const beforeRotate = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${oldToken}`)
      .send(makeHeartbeat());
    expect(beforeRotate.status).toBe(200);

    // Rotate
    const rotateRes = await request(app)
      .post(`/api/v1/devices/${device._id}/rotate-token`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch');

    expect(rotateRes.status).toBe(200);
    const newToken = rotateRes.body.token;
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);

    // Old token no longer works
    const withOld = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${oldToken}`)
      .send(makeHeartbeat());
    expect(withOld.status).toBe(401);

    // New token works
    const withNew = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${newToken}`)
      .send(makeHeartbeat());
    expect(withNew.status).toBe(200);
  });

  test('DB stores new hash, not the plaintext new token', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice('Test Laptop', user._id);

    const res = await request(app)
      .post(`/api/v1/devices/${device._id}/rotate-token`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch');

    const newToken = res.body.token;
    const dbDevice = await Device.findById(device._id);
    expect(dbDevice.tokenHash).toBe(hashToken(newToken));
    expect(dbDevice.tokenHash).not.toBe(newToken);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/devices/:id — cascade
// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/v1/devices/:id', () => {
  test('deletes device and cascades to readings and alerts', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device, token } = await createTestDevice('Test Laptop', user._id);

    // Create a reading via heartbeat
    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(makeHeartbeat());

    // Create an alert
    await Alert.create({
      deviceId: device._id,
      userId: user._id,
      type: 'TEST',
      severity: 'info',
      message: 'test',
    });

    // Delete device
    const res = await request(app)
      .delete(`/api/v1/devices/${device._id}`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch');

    expect(res.status).toBe(200);

    // Verify cascade
    expect(await Device.findById(device._id)).toBeNull();
    expect(await Reading.countDocuments({ deviceId: device._id })).toBe(0);
    expect(await Alert.countDocuments({ deviceId: device._id })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/devices/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/v1/devices/:id', () => {
  test('updates name and alertsPaused', async () => {
    const { user, password } = await createTestUser();
    const cookie = await loginAndGetCookie(request(app), user.email, password);
    const { device } = await createTestDevice('Old Name', user._id);

    const res = await request(app)
      .patch(`/api/v1/devices/${device._id}`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'voltwatch')
      .send({ name: 'New Name', alertsPaused: true });

    expect(res.status).toBe(200);
    expect(res.body.device.name).toBe('New Name');
    expect(res.body.device.alertsPaused).toBe(true);
  });
});
