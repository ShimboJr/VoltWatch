/**
 * migrateToMultiUser.js
 *
 * One-time migration script: backfills `userId` on all existing Device,
 * Alert, Reading, ReadingRollup, and PowerEvent documents, pointing them
 * to the seeded owner user. Also marks the owner as email-verified so
 * they are not locked out after the upgrade.
 *
 * Run once after deploying the multi-user backend:
 *   node scripts/migrateToMultiUser.js
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Device } from '../src/models/Device.js';
import { Alert } from '../src/models/Alert.js';
import { Reading } from '../src/models/Reading.js';
import { ReadingRollup } from '../src/models/ReadingRollup.js';
import { PowerEvent } from '../src/models/PowerEvent.js';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  console.log('Connecting to MongoDB…');
  await mongoose.connect(uri);
  console.log('Connected.\n');

  // Find the seeded owner (the first/only user created by bootstrapOwner)
  const owner = await User.findOne({}).sort({ createdAt: 1 }).lean();
  if (!owner) {
    console.error('No user found in the database. Has the server been started at least once?');
    await mongoose.disconnect();
    process.exit(1);
  }

  const ownerId = owner._id;
  console.log(`Owner found: ${owner.email} (${ownerId})\n`);

  // Mark owner as email-verified (they predated the verification system)
  await User.updateOne({ _id: ownerId }, {
    $set: { emailVerified: true, verificationToken: null, verificationTokenExpiry: null },
  });
  console.log('✓ Owner marked as email-verified');

  // Backfill userId on all collections where it's missing
  const collections = [
    { model: Device,       name: 'devices' },
    { model: Alert,        name: 'alerts' },
    { model: Reading,      name: 'readings' },
    { model: ReadingRollup, name: 'readingRollups' },
    { model: PowerEvent,   name: 'powerEvents' },
  ];

  for (const { model, name } of collections) {
    const result = await model.updateMany(
      { userId: { $exists: false } },
      { $set: { userId: ownerId } },
    );
    console.log(`✓ ${name}: ${result.modifiedCount} documents backfilled`);
  }

  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
