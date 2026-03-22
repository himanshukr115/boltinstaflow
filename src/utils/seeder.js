'use strict';

/**
 * Database Seeder
 *
 * Seeds the following data into MongoDB:
 *   1. Admin user (credentials from ADMIN_EMAIL / ADMIN_PASSWORD env vars)
 *   2. Three subscription plans: Free, Pro, Business
 *
 * Usage:
 *   node src/utils/seeder.js
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=Secret123! node src/utils/seeder.js
 *
 * Safe to run multiple times – uses upsert semantics (no duplicates created).
 */

require('dotenv').config();

const mongoose = require('mongoose');

// ─── Inline connection helper (seeder runs standalone, not via server) ────────

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }
  await mongoose.connect(uri, {
    maxPoolSize: 5,
    socketTimeoutMS: 30000,
    serverSelectionTimeoutMS: 10000,
  });
  console.log(`[Seeder] MongoDB connected: ${mongoose.connection.host}`);
}

async function disconnectDB() {
  await mongoose.disconnect();
  console.log('[Seeder] MongoDB disconnected');
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

/**
 * Build the admin user seed document.
 * Passwords are stored as bcrypt hashes; the User model's pre-save hook
 * handles hashing automatically.
 */
function buildAdminData() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email) throw new Error('ADMIN_EMAIL environment variable is not set');
  if (!password) throw new Error('ADMIN_PASSWORD environment variable is not set');

  return {
    name: process.env.ADMIN_NAME || 'Super Admin',
    email: email.toLowerCase().trim(),
    passwordHash: password,   // pre-save hook will hash this
    role: 'admin',
    isEmailVerified: true,
    isActive: true,
    isSuspended: false,
    timezone: 'Asia/Kolkata',
  };
}

/**
 * Plan seed data.
 * Prices are stored in the smallest currency unit (paise for INR).
 * -1 in limits means "unlimited".
 */
const PLAN_SEEDS = [
  {
    name: 'Free',
    slug: 'free',
    description: 'Perfect for individuals getting started with Instagram automation.',
    price: {
      monthly: 0,
      yearly: 0,
    },
    currency: 'INR',
    billingCycle: 'both',
    features: [
      '50 DMs per day',
      'Up to 100 contacts',
      '2 active automations',
      '1 Instagram account',
      'Basic analytics',
      'Community support',
    ],
    limits: {
      dmPerDay: 50,
      contacts: 100,
      automations: 2,
      campaigns: 1,
      instagramAccounts: 1,
    },
    isActive: true,
    isPopular: false,
    isFeatured: false,
    trialDays: 0,
    sortOrder: 1,
  },
  {
    name: 'Pro',
    slug: 'pro',
    description: 'For creators and small businesses ready to scale their Instagram presence.',
    price: {
      monthly: 99900,   // ₹999.00 in paise
      yearly: 999900,   // ₹9,999.00 in paise (~17% saving vs monthly)
    },
    currency: 'INR',
    billingCycle: 'both',
    features: [
      '500 DMs per day',
      'Up to 2,000 contacts',
      '20 active automations',
      '3 Instagram accounts',
      'Advanced analytics & reporting',
      'Keyword triggers (comment & DM)',
      'Story mention automation',
      'Priority email support',
      '7-day free trial',
    ],
    limits: {
      dmPerDay: 500,
      contacts: 2000,
      automations: 20,
      campaigns: 10,
      instagramAccounts: 3,
    },
    isActive: true,
    isPopular: true,
    isFeatured: false,
    trialDays: 7,
    sortOrder: 2,
  },
  {
    name: 'Business',
    slug: 'business',
    description: 'Unlimited power for agencies and high-growth brands managing multiple accounts.',
    price: {
      monthly: 299900,  // ₹2,999.00 in paise
      yearly: 2999900,  // ₹29,999.00 in paise (~17% saving vs monthly)
    },
    currency: 'INR',
    billingCycle: 'both',
    features: [
      'Unlimited DMs per day',
      'Unlimited contacts',
      'Unlimited automations',
      'Unlimited Instagram accounts',
      'Full analytics suite with export',
      'All automation trigger types',
      'Multi-step automation sequences',
      'Webhook integrations',
      'API access',
      'Dedicated account manager',
      'Priority phone & email support',
      '14-day free trial',
    ],
    limits: {
      dmPerDay: -1,          // -1 = unlimited
      contacts: -1,
      automations: -1,
      campaigns: -1,
      instagramAccounts: -1,
    },
    isActive: true,
    isPopular: false,
    isFeatured: true,
    trialDays: 14,
    sortOrder: 3,
  },
];

// ─── Seeder Functions ─────────────────────────────────────────────────────────

/**
 * Seed the admin user. Uses findOneAndUpdate with upsert so it's idempotent.
 * If the user already exists, only non-sensitive fields are updated (role, isActive).
 * The password is NOT overwritten on subsequent runs.
 */
async function seedAdmin() {
  // Require lazily so this file can be imported without mongoose being connected
  const User = require('../models/User');
  const bcrypt = require('bcryptjs');

  const adminData = buildAdminData();

  const existingUser = await User.findOne({ email: adminData.email });

  if (existingUser) {
    // Update role / status but preserve the existing password hash
    existingUser.role = 'admin';
    existingUser.isActive = true;
    existingUser.isSuspended = false;
    existingUser.isEmailVerified = true;
    await existingUser.save({ validateModifiedOnly: true });
    console.log(`[Seeder] Admin user already exists – updated: ${adminData.email}`);
    return existingUser;
  }

  // Hash the password manually (bypasses the pre-save hook which expects a plain password
  // only when passwordHash field is marked modified and has not yet been hashed)
  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(adminData.password || adminData.passwordHash, salt);

  const admin = await User.create({
    name: adminData.name,
    email: adminData.email,
    passwordHash,
    role: adminData.role,
    isEmailVerified: adminData.isEmailVerified,
    isActive: adminData.isActive,
    isSuspended: adminData.isSuspended,
    timezone: adminData.timezone,
  });

  console.log(`[Seeder] Admin user created: ${admin.email} (id: ${admin._id})`);
  return admin;
}

/**
 * Seed subscription plans. Upserts by slug so it's idempotent.
 */
async function seedPlans() {
  const Plan = require('../models/Plan');

  const results = { created: [], updated: [] };

  for (const planData of PLAN_SEEDS) {
    const existing = await Plan.findOne({ slug: planData.slug });

    if (existing) {
      // Update everything except the slug/name to allow description/feature changes
      Object.assign(existing, {
        description: planData.description,
        price: planData.price,
        currency: planData.currency,
        billingCycle: planData.billingCycle,
        features: planData.features,
        limits: planData.limits,
        isActive: planData.isActive,
        isPopular: planData.isPopular,
        isFeatured: planData.isFeatured,
        trialDays: planData.trialDays,
        sortOrder: planData.sortOrder,
      });
      await existing.save();
      results.updated.push(planData.slug);
      console.log(`[Seeder] Plan updated: ${planData.name} (${planData.slug})`);
    } else {
      const plan = await Plan.create(planData);
      results.created.push(plan.slug);
      console.log(`[Seeder] Plan created: ${plan.name} (${plan.slug}) id=${plan._id}`);
    }
  }

  return results;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

async function main() {
  console.log('[Seeder] Starting database seed...\n');

  try {
    await connectDB();

    console.log('[Seeder] --- Seeding admin user ---');
    await seedAdmin();

    console.log('\n[Seeder] --- Seeding subscription plans ---');
    const planResults = await seedPlans();

    console.log('\n[Seeder] ✓ Seeding complete.');
    console.log(`         Plans created : [${planResults.created.join(', ') || 'none'}]`);
    console.log(`         Plans updated : [${planResults.updated.join(', ') || 'none'}]`);
  } catch (err) {
    console.error('[Seeder] Fatal error during seeding:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
}

// Run when executed directly (node src/utils/seeder.js)
if (require.main === module) {
  main();
}

// ─── Exports (for use in tests or programmatic seeding) ──────────────────────

module.exports = {
  seedAdmin,
  seedPlans,
  PLAN_SEEDS,
};
