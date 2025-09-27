// src/services/redisService.js

import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js'; // FIX: Use named import

let redis;
let isConnecting = false;
let resolveConnection;
const connectionPromise = new Promise((resolve) => {
  resolveConnection = resolve;
});

const connectToRedis = () => {
  if (redis || isConnecting) return;
  isConnecting = true;
  try {
    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 15000,
      lazyConnect: true,
      enableReadyCheck: false,
      keepAlive: 50000,
    };

    const client = new Redis(env.REDIS_URL, redisOptions);

    client.on('connect', () => console.log('✅ Redis client connected.'));
    client.on('ready', () => {
        console.log(' Redis client ready.');
        resolveConnection(client);
    });
    client.on('error', err => {
      console.error('❌ Redis client error:', err.message);
      sentryService.captureError(err, { component: 'redis_service' });
    });
    client.on('close', () => console.warn(' Redis connection closed.'));
    client.on('reconnecting', () => console.log(' Redis client reconnecting...'));

    redis = client;
    isConnecting = false;
  } catch (error) {
    console.error('❌ Failed to initialize Redis client.', { error: error.message });
    isConnecting = false;
  }
};

connectToRedis();

export default connectionPromise;
