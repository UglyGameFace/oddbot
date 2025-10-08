// src/services/redisService.js - ABSOLUTE FINAL FIXED VERSION

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
    enableReadyCheck: false,
    keepAlive: 1000,
    
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
    
    reconnectOnError: (err) => {
      const errorMessage = err.message;
      
      // Never reconnect on syntax errors
      if (errorMessage.includes('ERR syntax error')) {
        console.warn(`⚠️ Redis syntax error (no reconnect): ${errorMessage.substring(0, 100)}`);
        return false;
      }
      
      const forceReconnectErrors = [
        'ECONNREFUSED',
        'ETIMEDOUT', 
        'EHOSTUNREACH',
        'ENOTFOUND',
        'Socket closed unexpectedly'
      ];
      
      if (forceReconnectErrors.some(e => errorMessage.includes(e))) {
        console.warn(`🔄 Redis forcing reconnect on: ${errorMessage}`);
        return true;
      }
      
      return false;
    },
    
    enableOfflineQueue: true, 
    showFriendlyErrorStack: true,
    autoResubscribe: false,
    autoResendUnfulfilled: false
  };

  const client = new Redis(env.REDIS_URL, redisOptions);

  client.on('connect', () => {
    console.log('🔄 Redis connecting...');
  });

  client.on('ready', () => {
    console.log('✅ Redis connected and ready');
  });

  client.on('error', (err) => {
    const ignorableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EHOSTUNREACH', 
      'ENOTFOUND',
      'ERR syntax error',
      'Redis internal system error'
    ];
    
    if (ignorableErrors.some(e => err.message.includes(e))) {
      console.warn('⚠️ Redis operational error:', err.message);
    } else {
      console.error('❌ Redis critical error:', err.message);
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
  if (redisClient) {
    const status = redisClient.status;
    if (status === 'ready' || status === 'connecting' || status === 'connect') {
      return redisClient;
    }
    if (status === 'close' || status === 'end' || status === 'error') {
      console.warn('🔄 Redis client in bad state, resetting...');
      redisClient = null;
      connectionPromise = null;
    }
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
      
      const pingPromise = redisClient.ping().then(() => {
        console.log('✅ Redis connection test passed');
      }).catch(pingError => {
        console.warn('⚠️ Redis ping failed, but continuing:', pingError.message);
      });
      
      await Promise.race([
        pingPromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
      
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

export async function checkRedisHealth() {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    
    await client.ping();
    return true;
  } catch (error) {
    console.warn('⚠️ Redis health check failed:', error.message);
    return false;
  }
}

export async function disconnectRedis() {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (error) {
      // Ignore quit errors during shutdown
    }
    redisClient = null;
    connectionPromise = null;
  }
}

process.on('SIGTERM', async () => {
  console.log('🔌 Redis disconnecting due to SIGTERM...');
  await disconnectRedis();
});

export default getRedisClient;
