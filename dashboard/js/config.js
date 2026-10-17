/**
 * config.js — Runtime configuration injected before app.js loads.
 *
 * Override VOLTWATCH_API by setting window.VOLTWATCH_API before this script
 * (e.g. via a server-rendered meta tag or Vercel Edge Config) to point at a
 * different backend. Falls back to the Vercel rewrite proxy at /api/v1.
 */
window.VOLTWATCH_API = window.VOLTWATCH_API || '/api/v1';
