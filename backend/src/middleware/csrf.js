const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for dashboard routes.
 * Requires the custom header "X-Requested-With: voltwatch" on all
 * state-changing requests (POST, PUT, PATCH, DELETE).
 *
 * This defence is sufficient because the custom header can only be set by
 * code served from the same origin (or a trusted extension), not by a
 * cross-site form submission.
 */
export function csrfMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const header = req.headers['x-requested-with'];
  if (header !== 'voltwatch') {
    return res.status(403).json({
      error: {
        code: 'CSRF_REJECTED',
        message: 'X-Requested-With: voltwatch header is required for this request',
      },
    });
  }
  next();
}
