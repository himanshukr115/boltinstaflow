const mongoose = require('mongoose');
const logger = require('./logger');

const MONGODB_OPTIONS = {
  maxPoolSize: 50,
  minPoolSize: 5,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  w: 'majority',
};

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  if (!process.env.MONGODB_URI) {
    console.warn('[DB] MONGODB_URI not set - skipping MongoDB connection');
    logger.warn('MONGODB_URI not set - skipping MongoDB connection');
    return;
  }

  const safeUri = process.env.MONGODB_URI.replace(/:\/\/[^@]+@/, '://<credentials>@');
  console.log(`[DB] Connecting to MongoDB: ${safeUri}...`);

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, MONGODB_OPTIONS);
    isConnected = true;
    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
    logger.info(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      console.error('[DB] MongoDB connection error:', err.message);
      logger.error('MongoDB connection error:', err);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] MongoDB disconnected. Attempting reconnect...');
      logger.warn('MongoDB disconnected. Attempting reconnect...');
      isConnected = false;
      setTimeout(connectDB, 5000);
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[DB] MongoDB reconnected');
      logger.info('MongoDB reconnected');
      isConnected = true;
    });

    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed due to app termination');
      process.exit(0);
    });

  } catch (err) {
    console.warn(`[DB] MongoDB connection failed: ${err.message} - app will start without database`);
    logger.warn(`MongoDB connection failed (${err.message}) - app will start without database`);
  }
}

module.exports = { connectDB };
