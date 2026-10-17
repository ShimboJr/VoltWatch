import { logger } from './logger.js';

/**
 * Express 4-argument error handler.
 * Must be registered last in app.use() chain.
 *
 * In production, never leaks stack traces or internal messages to clients.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  logger.error(
    {
      err: { message: err.message, code, stack: err.stack },
      url: req.url,
      method: req.method,
      status,
    },
    'Request error',
  );

  if (res.headersSent) return;

  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'An internal error occurred'
      : err.message || 'An internal error occurred';

  res.status(status).json({ error: { code, message } });
}
