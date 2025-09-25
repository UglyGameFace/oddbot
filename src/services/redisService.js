// src/services/redisService.js - Centralized Redis Client
import Redis from 'ioredis';
import env from '../config/env.js';
import sentryService from './sentryService.js';

let redis;
let isConnecting = false;

const connectToRedis = () => {
  if (redis || isConnecting) return;
  isConnecting = true;
  try {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      lazyConnect: true, // Graceful reconnects
    });
    client.on('connect', () => console.log('✅ Redis client connected.'));
    client.on('ready', () => console.log(' Redis client ready.'));
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

// Initial connection attempt
connectToRedis();

export default redis;
