import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import { User } from '../../src/models/User.js';
import { Device } from '../../src/models/Device.js';
import { Reading } from '../../src/models/Reading.js';
import { DEFAULT_SETTINGS } from '../../src/models/User.js';
import { generateToken } from '../../src/services/tokenService.js';

let mongod;

/**
 * Start an in-memory MongoDB instance and connect Mongoose to it.
 * Call once in beforeAll.
 */
export async function connectTestDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'voltwatch_test' });
}

/**
 * Disconnect Mongoose and stop the in-memory server.
 * Call once in afterAll.
 */
export async function disconnectTestDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

/**
 * Delete all documents from every collection.
 * Call in beforeEach to keep tests isolated.
 */
export async function clearTestDb() {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/**
 * Create the test owner user with a known password.
 *
 * @param {string} [email]
 * @param {string} [password]
 * @returns {Promise<{ user: import('../../src/models/User.js').User, password: string }>}
 */
export async function createTestUser(email = 'owner@test.com', password = 'TestPass123!') {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await User.create({
    email,
    passwordHash,
    settings: { ...DEFAULT_SETTINGS },
  });
  return { user, password };
}

/**
 * Create a test device and return its plaintext token.
 *
 * @param {string} [name]
 * @returns {Promise<{ device: import('../../src/models/Device.js').Device, token: string }>}
 */
export async function createTestDevice(name = 'Test Laptop') {
  const { token, tokenHash } = generateToken();
  const device = await Device.create({ name, tokenHash });
  return { device, token };
}

/**
 * Build a valid heartbeat payload for a device.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function makeHeartbeat(overrides = {}) {
  return {
    readingId: crypto.randomUUID(),
    deviceTime: new Date().toISOString(),
    kind: 'heartbeat',
    event: null,
    percent: 85,
    charging: true,
    acConnected: true,
    secsLeft: null,
    mt5Running: true,
    uptimeSec: 3600,
    internetLatencyMs: 50,
    agentVersion: '1.0.0',
    hostname: 'TEST-HOST',
    meta: {},
    ...overrides,
  };
}

/**
 * Login and return the Set-Cookie header value (for subsequent requests).
 *
 * @param {import('supertest').SuperTest} agent
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} cookie string
 */
export async function loginAndGetCookie(agent, email, password) {
  const res = await agent
    .post('/api/v1/auth/login')
    .set('X-Requested-With', 'voltwatch')
    .send({ email, password });

  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return res.headers['set-cookie'];
}

/**
 * Insert `count` raw Reading documents for a device, going back in time.
 *
 * @param {mongoose.Types.ObjectId} deviceId
 * @param {number} count
 * @param {number} intervalSec  Spacing between readings
 */
export async function seedReadings(deviceId, count, intervalSec = 45) {
  const now = Date.now();
  const docs = Array.from({ length: count }, (_, i) => ({
    deviceId,
    readingId: crypto.randomUUID(),
    deviceTime: new Date(now - (count - i) * intervalSec * 1000),
    serverTime: new Date(now - (count - i) * intervalSec * 1000),
    percent: Math.max(5, 100 - i),
    charging: false,
    acConnected: false,
    secsLeft: null,
    mt5Running: true,
    uptimeSec: i * intervalSec,
    cycleId: 0,
    backfilled: false,
  }));
  await Reading.insertMany(docs);
}
