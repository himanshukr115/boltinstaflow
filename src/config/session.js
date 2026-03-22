'use strict';

const session = require('express-session');
const MongoStore = require('connect-mongo');

function parseSessionDuration() {
  const raw = process.env.SESSION_DURATION;
  if (!raw) return 7 * 24 * 60 * 60 * 1000;

  const match = raw.match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'ms').toLowerCase();

  const multipliers = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return value * (multipliers[unit] || 1);
}

function createSessionMiddleware(mongooseConnection) {
  const secret = process.env.SESSION_SECRET || 'instaflow-dev-fallback-secret-key-32chars!';
  const isProduction = process.env.NODE_ENV === 'production';
  const maxAge = parseSessionDuration();

  let store;
  const isMongoReady = mongooseConnection && mongooseConnection.readyState === 1;

  if (isMongoReady) {
    try {
      store = MongoStore.create({
        client: mongooseConnection.getClient(),
        collectionName: 'sessions',
        autoRemove: 'native',
        touchAfter: 24 * 60 * 60,
        stringify: false,
        crypto: { secret },
      });
      store.on('error', (err) => console.error('[SESSION] MongoStore error:', err.message));
      console.log('[SESSION] Using MongoDB session store');
    } catch (err) {
      console.warn('[SESSION] MongoStore failed, using in-memory store:', err.message);
      store = undefined;
    }
  } else {
    console.warn('[SESSION] MongoDB not ready - using in-memory session store (sessions will not persist across restarts)');
  }

  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store,
    name: process.env.SESSION_COOKIE_NAME || 'instaflow.sid',
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: 'strict',
      maxAge,
      domain: isProduction ? process.env.COOKIE_DOMAIN || undefined : undefined,
      path: '/',
    },
    proxy: isProduction,
  });
}

module.exports = { createSessionMiddleware };
