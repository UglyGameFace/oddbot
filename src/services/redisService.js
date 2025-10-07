// src/services/redisService.js - COMPLETE FIXED VERSION

import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

let redisClient = null;
let connectionPromise = null;

function createRedisClient() {
  console.log('🔌 Creating Redis client...');
  
  if (!env.REDIS_URL) {
    console.warn('❌ REDIS_URL not configured - Redis disabled');
    return null;
  }

  const redisOptions = {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true,
    enableReadyCheck: true,
    keepAlive: 1000,
    retryDelayOnFailover: 100,
    retryDelayOnTryAgain: 100,
    retryStrategy: (times) => {
      if (times > 10) {
        console.warn('🔄 Redis retry limit exceeded');
        return null;
      }
      const delay = Math.min(times * 100, 3000);
      console.log(`🔄 Redis reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    reconnectOnError: (err) => {
      console.warn('🔄 Redis reconnecting on error:', err.message);
      return true;
    }
  };

  const client = new Redis(env.REDIS_URL, redisOptions);

  client.on('connect', () => {
    console.log('🔄 Redis connecting...');
  });

  client.on('ready', () => {
    console.log('✅ Redis connected and ready');
  });

  client.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
    sentryService.captureError(err, { component: 'redis_service' });
  });

  client.on('close', () => {
    console.warn('🔌 Redis connection closed');
  });

  client.on('reconnecting', () => {
    console.log('🔄 Redis reconnecting...');
  });

  client.on('end', () => {
    console.warn('🛑 Redis connection ended');
  });

  return client;
}

export async function getRedisClient() {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise(async (resolve, reject) => {
    try {
      redisClient = createRedisClient();
      
      if (!redisClient) {
        console.warn('⚠️ Redis client not created - running without Redis');
        resolve(null);
        return;
      }

      await redisClient.connect();
      await redisClient.ping();
      console.log('✅ Redis connection test passed');
      
      resolve(redisClient);
      connectionPromise = null;
      
    } catch (error) {
      console.error('❌ Redis connection failed:', error.message);
      redisClient = null;
      connectionPromise = null;
      console.warn('⚠️ Running without Redis - some features disabled');
      resolve(null);
    }
  });

  return connectionPromise;
}

export default getRedisClient();
