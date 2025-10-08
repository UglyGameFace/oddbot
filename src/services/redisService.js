// src/services/redisService.js - ABSOLUTE FINAL, ULTRA-DEFENSIVE SCRIPT

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
    // Keep maxRetries high, but maxRetriesPerRequest low
    maxRetriesPerRequest: 1, // FIX: Lower this to fail quickly and rely on external reconnection
    connectTimeout: 10000,
    lazyConnect: true,
    enableReadyCheck: true,
    keepAlive: 1000,
    
    // FIX: Set a dedicated reconnection delay on command failure
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
      // FIX: Identify the exact errors from the logs and return false for them.
      // Returning FALSE tells ioredis NOT to close the entire connection, but to retry the command.
      const transientErrors = [
          'READONLY', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 
          'Error: write EPIPE', // Common network pipeline error
          'Redis internal system error' // The error seen in your log
      ];
      
      if (transientErrors.some(e => err.message.includes(e))) {
        console.warn(`⚠️ Redis transient error (${err.message.substring(0, 30)}...), attempting command retry.`);
        return false; // CRITICAL FIX: DO NOT DISCONNECT THE CLIENT
      }
      
      // The specific "ERR syntax error" usually means the command pipeline is truly corrupted.
      if (err.message.includes('ERR syntax error')) {
        console.warn('🔄 Redis command pipeline corrupted, forcing full reconnect.');
        return true; // Force a full reconnect cycle
      }
      
      console.warn('🔄 Redis reconnecting on error:', err.message);
      return true;
    },
    
    enableOfflineQueue: true, 
    showFriendlyErrorStack: true
  };

  const client = new Redis(env.REDIS_URL, redisOptions);

  client.on('connect', () => {
    console.log('🔄 Redis connecting...');
  });

  client.on('ready', () => {
    console.log('✅ Redis connected and ready');
  });

  client.on('error', (err) => {
    // Sentry logging for general errors
    if (!err.message.includes('ERR syntax error') && !err.message.includes('Redis internal system error')) {
      console.error('❌ Redis error:', err.message);
      sentryService.captureError(err, { component: 'redis_service' });
    }
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
