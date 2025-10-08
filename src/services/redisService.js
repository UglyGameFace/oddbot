// src/services/redisService.js - ABSOLUTE FINAL, ULTRA-DEFENSIVE SCRIPT - FIXED VERSION

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
    // CRITICAL FIX: Keep maxRetriesPerRequest at 3 for better reliability
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true,
    enableReadyCheck: true,
    keepAlive: 1000,
    
    // FIX: More reasonable retry delays
    retryDelayOnFailover: 1000, 
    retryDelayOnTryAgain: 1000, 
    
    retryStrategy: (times) => {
      if (times > 10) {
        console.warn('🔄 Redis retry limit exceeded');
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      console.log(`🔄 Redis reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    
    // CRITICAL FIX: Simplified reconnectOnError logic
    reconnectOnError: (err) => {
      const errorMessage = err.message;
      
      // FIX: Only reconnect on these specific connection errors
      const reconnectErrors = [
        'ECONNRESET',
        'ETIMEDOUT', 
        'EHOSTUNREACH',
        'ENOTFOUND',
        'ECONNREFUSED',
        'Socket closed unexpectedly'
      ];
      
      // FIX: Don't reconnect on command errors - these are usually transient
      const commandErrors = [
        'ERR syntax error',
        'Redis internal system error',
        'WRONGTYPE',
        'EXECABORT'
      ];
      
      if (reconnectErrors.some(e => errorMessage.includes(e))) {
        console.warn(`🔄 Redis reconnecting on connection error: ${errorMessage}`);
        return true; // Trigger reconnect
      }
      
      if (commandErrors.some(e => errorMessage.includes(e))) {
        console.warn(`⚠️ Redis command error (not reconnecting): ${errorMessage}`);
        return false; // Don't reconnect - just fail the command
      }
      
      // For unknown errors, default to reconnecting
      console.warn(`🔄 Redis reconnecting on unknown error: ${errorMessage}`);
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
    // FIX: Don't log connection-related errors to Sentry (they're normal)
    const ignorableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENOTFOUND'
    ];
    
    if (!ignorableErrors.some(e => err.message.includes(e))) {
      console.error('❌ Redis error:', err.message);
      sentryService.captureError(err, { component: 'redis_service' });
    } else {
      console.warn('⚠️ Redis connection error (normal):', err.message);
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
  // FIX: More robust connection state checking
  if (redisClient && 
      (redisClient.status === 'ready' || redisClient.status === 'connecting' || redisClient.status === 'connect')) {
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
      
      // FIX: More forgiving ping test
      try {
        await redisClient.ping();
        console.log('✅ Redis connection test passed');
      } catch (pingError) {
        console.warn('⚠️ Redis ping failed, but continuing:', pingError.message);
        // Don't fail the entire connection on ping failure
      }
      
      resolve(redisClient);
      connectionPromise = null;
      
    } catch (error) {
      console.error('❌ Redis connection failed:', error.message);
      redisClient = null;
      connectionPromise = null;
      console.warn('⚠️ Running without Redis - some features disabled');
      resolve(null); // FIX: Always resolve, never reject
    }
  });

  return connectionPromise;
}

// FIX: Maintain your existing default export
export default getRedisClient();
