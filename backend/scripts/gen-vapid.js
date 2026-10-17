/**
 * gen-vapid.js — Generate VAPID key pair for Web Push.
 *
 * Usage:
 *   node scripts/gen-vapid.js
 *
 * Copy the output into your .env file.
 * The PUBLIC key must also be pasted into dashboard/js/push.js
 * (or fetched dynamically from GET /api/v1/push/vapid-public-key).
 *
 * The PRIVATE key must NEVER be committed to version control.
 */

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

console.log(`
=============================================================
  VoltWatch VAPID keys generated
=============================================================

Add to backend/.env:

  VAPID_PUBLIC_KEY=${keys.publicKey}
  VAPID_PRIVATE_KEY=${keys.privateKey}

The PUBLIC key is safe to commit / share (used by the browser).
The PRIVATE key must stay secret and never be committed.

=============================================================
`);
