import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { logger } from './middleware/logger.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { dashboardRateLimit } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { sanitizeBody } from './middleware/sanitize.js';

import healthRouter from './routes/health.js';
import agentRouter from './routes/agent.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import settingsRouter from './routes/settings.js';
import alertsRouter  from './routes/alerts.js';
import streamRouter  from './routes/stream.js';
import pushRouter    from './routes/push.js';

import config from './config/index.js';

/**
 * Build and return the Express application.
 * Separated from server.js so tests can import it without starting a listener.
 *
 * @returns {import('express').Application}
 */
export function createApp() {
  const app = express();

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(helmet());
  app.use(
    cors({
      origin: config.appOrigin,
      credentials: true,
    }),
  );

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  // Strip MongoDB operator keys ($, .) from all request bodies
  app.use(sanitizeBody);

  // ── Request logging (redacts Authorization and cookies) ───────────────────
  app.use(pinoHttp({ logger }));

  // ── Public endpoints (no auth, no CSRF) ───────────────────────────────────
  app.use('/api/v1/health', healthRouter);

  // ── Agent routes (bearer token auth, own rate limit — no CSRF needed) ─────
  app.use('/api/v1/agent', agentRouter);

  // ── Dashboard routes (cookie auth + CSRF on mutating methods) ─────────────
  app.use('/api/v1/auth', csrfMiddleware, dashboardRateLimit, authRouter);
  app.use('/api/v1/devices', csrfMiddleware, dashboardRateLimit, devicesRouter);
  app.use('/api/v1/settings', csrfMiddleware, dashboardRateLimit, settingsRouter);
  app.use('/api/v1/alerts', csrfMiddleware, dashboardRateLimit, alertsRouter);

  // SSE stream — no CSRF (GET only), but does require session auth inside router
  app.use('/api/v1/stream', streamRouter);

  // Push — VAPID key endpoint is public; subscribe/list/test require session
  app.use('/api/v1/push', csrfMiddleware, dashboardRateLimit, pushRouter);
  // Public VAPID key does not need CSRF (GET)
  app.use('/api/v1/push/vapid-public-key', (_req, res, next) => next()); // no-op, just for clarity

  // ── Global error handler (must be last) ───────────────────────────────────
  app.use(errorHandler);

  return app;
}
