// src/services/redisService.js
import Redis from 'ioredis';
import env from '../config/env.js';
import sentryService from './sentryService.js';

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 15000,
  lazyConnect: true,
  enableReadyCheck: false,
  keepAlive: 50000,
});

redis.on('connect', () => console.log('✅ Redis client connected.'));
redis.on('ready', () => console.log(' Redis client ready.'));
redis.on('error', err => {
  console.error('❌ Redis client error:', err.message);
  sentryService.captureError(err, { component: 'redis_service' });
});
redis.on('close', () => console.warn(' Redis connection closed.'));
redis.on('reconnecting', () => console.log(' Redis client reconnecting...'));

export default redis;
