/**
 * Central config loaded from environment variables.
 * Import this everywhere instead of reading process.env directly.
 */
import { config as loadEnv } from 'dotenv';
loadEnv();

export default {
  port: parseInt(process.env.PORT || '3001', 10),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/voltwatch',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  ownerEmail: process.env.OWNER_EMAIL || '',
  ownerPasswordHash: process.env.OWNER_PASSWORD_HASH || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:3000',
  appUrl: process.env.APP_URL || process.env.APP_ORIGIN || 'https://voltwatch-dashboard.vercel.app',
  retentionDays: parseInt(process.env.RETENTION_DAYS || '30', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  fromEmail: process.env.FROM_EMAIL || 'VoltWatch <noreply@voltwatch-dashboard.vercel.app>',
};
