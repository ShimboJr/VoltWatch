/**
 * sanitize.js — Strip MongoDB operator keys from user-supplied JSON bodies.
 *
 * MongoDB is NOT directly vulnerable to operator injection through Mongoose
 * because Mongoose casts query parameters, but belt-and-braces defence ensures
 * any key starting with "$" or containing "." is removed from req.body before
 * it reaches route handlers.
 *
 * Applied globally to all routes via app.use() after body parsing.
 */

/**
 * Recursively remove any key that starts with '$' or contains '.'.
 * @param {unknown} obj
 * @returns {unknown}
 */
function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj !== null && typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$') || k.includes('.')) continue; // strip operator keys
      clean[k] = sanitize(v);
    }
    return clean;
  }
  return obj;
}

export function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  next();
}
