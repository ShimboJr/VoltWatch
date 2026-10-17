import { Router } from 'express';
import { requireAuth } from '../middleware/authSession.js';
import { Device } from '../models/Device.js';
import { User } from '../models/User.js';
import { DEFAULT_SETTINGS } from '../models/User.js';
import { deriveStatus } from '../services/statusService.js';

const router = Router();

// ─── Event buffer (in-memory, last 200 events for Last-Event-ID replay) ──────
const BUFFER_SIZE = 200;
/** @type {{ id: number, event: string, data: object }[]} */
const eventBuffer = [];
let lastEventId = 0;

function addToBuffer(event, data) {
  const id = ++lastEventId;
  eventBuffer.push({ id, event, data });
  if (eventBuffer.length > BUFFER_SIZE) eventBuffer.shift();
  return id;
}

// ─── Active SSE clients ───────────────────────────────────────────────────────
/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

/**
 * Write a single SSE frame to a response object.
 */
function writeFrame(res, id, event, data) {
  res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Public broadcast API ─────────────────────────────────────────────────────

/**
 * Broadcast an SSE event to all connected dashboard clients.
 * Buffers the event for Late-Event-ID replay.
 *
 * @param {'status'|'alert'|'event'} event
 * @param {object} data
 */
export function broadcast(event, data) {
  const id = addToBuffer(event, data);
  for (const res of clients) {
    try {
      writeFrame(res, id, event, data);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a `status` update for a device.
 * Fetches the current status and pushes it to all clients.
 *
 * @param {string|import('mongoose').Types.ObjectId} deviceId
 * @param {object} settings  Owner settings (pass to avoid re-fetching)
 */
export async function broadcastStatus(deviceId, settings) {
  try {
    const device = await Device.findById(deviceId).lean();
    if (!device) return;
    const s = settings ?? (() => DEFAULT_SETTINGS)();
    const status = await deriveStatus(device, s, { predictions: false });
    broadcast('status', { deviceId: deviceId.toString(), ...status });
  } catch {
    /* Non-fatal */
  }
}

// ─── SSE Route ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/stream
 * Server-Sent Events stream. Requires session authentication.
 * Supports Last-Event-ID header for missed-event replay on reconnect.
 */
router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');    // Nginx
  res.setHeader('X-Content-Type-Options', 'nosniff'); // Belt-and-suspenders
  res.flushHeaders();

  // ── Replay missed events since Last-Event-ID ──────────────────────────────
  const lastIdHeader = parseInt(req.headers['last-event-id'] || '0', 10);
  if (lastIdHeader > 0) {
    const missed = eventBuffer.filter((e) => e.id > lastIdHeader);
    for (const ev of missed) {
      writeFrame(res, ev.id, ev.event, ev.data);
    }
  }

  clients.add(res);

  // Keep-alive ping every 25 s (prevents proxy/load-balancer timeouts)
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(pingInterval);
      clients.delete(res);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(res);
  });
});

export default router;
