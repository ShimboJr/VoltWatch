/**
 * emailService.js — Transactional email via Resend.
 *
 * Gracefully degrades when RESEND_API_KEY is not set (dev mode):
 * logs the email content to the console instead of sending it.
 */

import { Resend } from 'resend';
import config from '../config/index.js';
import { logger } from '../middleware/logger.js';

let _resend = null;

function getResend() {
  if (!_resend && config.resendApiKey) {
    _resend = new Resend(config.resendApiKey);
  }
  return _resend;
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────

function _htmlShell(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VoltWatch</title>
  <style>
    body { margin: 0; padding: 0; background: #0d1117; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e6edf3; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #161b22; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; }
    .header { background: linear-gradient(135deg, #0d1117 0%, #1c2128 100%); padding: 32px 40px; text-align: center; border-bottom: 1px solid #30363d; }
    .logo { font-size: 28px; font-weight: 800; color: #58a6ff; letter-spacing: -0.5px; }
    .logo span { color: #f78166; }
    .tagline { color: #8b949e; font-size: 13px; margin-top: 4px; }
    .body { padding: 32px 40px; }
    .btn { display: inline-block; margin: 24px 0; padding: 14px 32px; background: linear-gradient(135deg, #238636, #2ea043); color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; letter-spacing: 0.3px; }
    .btn:hover { background: linear-gradient(135deg, #2ea043, #3fb950); }
    .divider { border: none; border-top: 1px solid #30363d; margin: 24px 0; }
    .small { color: #8b949e; font-size: 12px; line-height: 1.6; }
    .footer { padding: 20px 40px; background: #0d1117; text-align: center; color: #484f58; font-size: 12px; border-top: 1px solid #30363d; }
    p { line-height: 1.7; color: #c9d1d9; font-size: 14px; margin: 0 0 12px; }
    h2 { color: #e6edf3; font-size: 20px; font-weight: 700; margin: 0 0 16px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">⚡ Volt<span>Watch</span></div>
      <div class="tagline">Battery monitor for your trading laptop</div>
    </div>
    <div class="body">${body}</div>
    <div class="footer">
      VoltWatch · <a href="${config.appUrl}" style="color:#58a6ff;text-decoration:none;">voltwatch-dashboard.vercel.app</a><br/>
      You received this email because an account was registered with this address.
    </div>
  </div>
</body>
</html>`;
}

// ── Send helper ───────────────────────────────────────────────────────────────

async function _send({ to, subject, html }) {
  const resend = getResend();

  if (!resend) {
    // Dev fallback — log to console
    logger.info({ to, subject }, '[emailService] DEV MODE — email not sent (no RESEND_API_KEY)');
    logger.debug({ html }, '[emailService] email body');
    return;
  }

  const { error } = await resend.emails.send({
    from: config.fromEmail,
    to,
    subject,
    html,
  });

  if (error) {
    logger.error({ error, to, subject }, '[emailService] Resend send error');
    throw new Error(`Email delivery failed: ${error.message}`);
  }

  logger.info({ to, subject }, '[emailService] Email sent');
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Send the email verification email to a newly registered user.
 *
 * @param {string} toEmail
 * @param {string} name  Display name (can be empty string)
 * @param {string} verificationUrl  Full URL including the raw token
 */
export async function sendVerificationEmail(toEmail, name, verificationUrl) {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const html = _htmlShell(`
    <h2>Verify your email address</h2>
    <p>${greeting}</p>
    <p>Thanks for creating a VoltWatch account! To start monitoring your battery, please verify your email address by clicking the button below.</p>
    <div style="text-align:center">
      <a class="btn" href="${verificationUrl}">Verify my email</a>
    </div>
    <hr class="divider" />
    <p class="small">This link expires in <strong>24 hours</strong>. If you didn't create a VoltWatch account, you can safely ignore this email.</p>
    <p class="small">Or copy and paste this URL into your browser:<br/><span style="color:#58a6ff;word-break:break-all">${verificationUrl}</span></p>
  `);

  await _send({
    to: toEmail,
    subject: 'Verify your VoltWatch email address',
    html,
  });
}

/**
 * Send a welcome email after successful verification.
 *
 * @param {string} toEmail
 * @param {string} name
 */
export async function sendWelcomeEmail(toEmail, name) {
  const greeting = name ? `Welcome aboard, ${name}! 🎉` : 'Welcome to VoltWatch! 🎉';
  const html = _htmlShell(`
    <h2>${greeting}</h2>
    <p>Your email has been verified and your account is ready to use.</p>
    <p>Here's how to get started in 3 minutes:</p>
    <ol style="color:#c9d1d9;font-size:14px;line-height:2;padding-left:20px">
      <li>Sign in to your dashboard</li>
      <li>Go to <strong>Devices</strong> → Add your laptop</li>
      <li>Install the Python agent on your laptop and paste the device token</li>
    </ol>
    <div style="text-align:center">
      <a class="btn" href="${config.appUrl}/app#/login">Open dashboard</a>
    </div>
    <hr class="divider" />
    <p class="small">Need help? Check the <a href="https://github.com/ShimboJr/VoltWatch/blob/main/docs/runbook.md" style="color:#58a6ff">runbook</a> for setup instructions.</p>
  `);

  await _send({
    to: toEmail,
    subject: 'Welcome to VoltWatch — you\'re all set!',
    html,
  });
}
