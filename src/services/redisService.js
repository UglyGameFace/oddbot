// src/services/redisService.js

import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

let redisClientPromise = null;

function getRedisClient() {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = new Promise((resolve, reject) => {
    console.log('Attempting to connect to Redis...');
    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 15000,
      lazyConnect: false, // immediate connect for early failure
      enableReadyCheck: false,
      keepAlive: 50000,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    };

    const client = new Redis(env.REDIS_URL, redisOptions);

    client.on('connect', () => console.log(' Redis client connecting...'));
    client.on('ready', () => {
      console.log('✅ Redis client connected and ready.');
      resolve(client);
    });
    client.on('error', (err) => {
      console.error('❌ Redis client error:', err);
      sentryService.captureError(err, { component: 'redis_service' });
      if (!client.isReady) {
        reject(new Error('Failed to connect to Redis.'));
      }
    });
    client.on('close', () => console.warn(' Redis connection closed.'));
    client.on('reconnecting', () => console.log(' Redis client reconnecting...'));
  });

  return redisClientPromise;
}

export default getRedisClient();
