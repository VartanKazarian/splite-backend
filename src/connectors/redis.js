const Redis = require('ioredis');
const config = require('../config');
const { logger } = require('./logger');

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true
});

redis.on('error', err => logger.error({ event: 'REDIS_ERROR', err }, 'Redis error'));

async function connectRedis() {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  return redis;
}

async function closeRedis() {
  try { await redis.quit(); } catch { redis.disconnect(); }
}

module.exports = { redis, connectRedis, closeRedis };
