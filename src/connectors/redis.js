const Redis = require('ioredis');
const config = require('../config');

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true
});

redis.on('error', err => console.error('[Redis]', err.message));

async function connectRedis() {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  return redis;
}

async function closeRedis() {
  try { await redis.quit(); } catch { redis.disconnect(); }
}

module.exports = { redis, connectRedis, closeRedis };
