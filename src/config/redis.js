const Redis = require('ioredis');
const logger = require('./logger');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryDelayOnFailover: 100,
  retryDelayOnClusterDown: 300,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  keepAlive: 30000,
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) return true;
    return false;
  },
};

if (process.env.REDIS_TLS === 'true') {
  redisConfig.tls = { rejectUnauthorized: false };
}

let redisClient = null;
let pubClient = null;
let subClient = null;

function createRedisClient(name = 'main') {
  const client = new Redis(redisConfig);

  client.on('connect', () => logger.info(`Redis [${name}] connected`));
  client.on('ready', () => logger.info(`Redis [${name}] ready`));
  client.on('error', (err) => logger.error(`Redis [${name}] error:`, err));
  client.on('close', () => logger.warn(`Redis [${name}] connection closed`));
  client.on('reconnecting', () => logger.info(`Redis [${name}] reconnecting...`));

  return client;
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedisClient('main');
  }
  return redisClient;
}

function getPubClient() {
  if (!pubClient) pubClient = createRedisClient('pub');
  return pubClient;
}

function getSubClient() {
  if (!subClient) subClient = createRedisClient('sub');
  return subClient;
}

function getBullMQConnection() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

module.exports = { getRedisClient, getPubClient, getSubClient, getBullMQConnection, createRedisClient };
