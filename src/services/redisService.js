// src/services/redisService.js - COMPLETELY FIXED

import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

let redisClientPromise = null;
let redisClientInstance = null;

/**
 * Returns a singleton promise that resolves to an ioredis client instance.
 * This ensures that only one connection to Redis is established and reused throughout the application.
 * @returns {Promise<Redis.Redis>} A promise that resolves to the Redis client instance.
 */
function getRedisClient() {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = new Promise((resolve, reject) => {
    console.log('🔌 Attempting to connect to Redis...');

    // Parse Redis URL for better configuration
    const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
    console.log(`📡 Redis URL: ${redisUrl.replace(/:([^@]+)@/, ':****@')}`); // Hide password in logs

    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 30000,
      commandTimeout: 5000, // Added command timeout
      lazyConnect: false,
      enableReadyCheck: true,
      keepAlive: 50000,
      retryDelayOnFailover: 100,
      retryDelayOnTryAgain: 100,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 5000);
        console.log(`🔄 Redis retry attempt ${times}, delaying ${delay}ms`);
        return delay;
      },
      reconnectOnError(err) {
        console.log('🔁 Redis reconnecting on error:', err.message);
        return true;
      }
    };

    try {
      const client = new Redis(redisUrl, redisOptions);
      redisClientInstance = client;

      client.on('connect', () => {
        console.log('🔄 Redis client connecting...');
      });

      client.on('ready', () => {
        console.log('✅ Redis client connected and ready.');
        resolve(client);
      });

      client.on('error', (err) => {
        console.error('❌ Redis client error:', err.message);
        sentryService.captureError(err, {
          component: 'redis_service',
          operation: 'connection_error'
        });

        if (!client.isReady) {
          reject(new Error(`Failed to connect to Redis: ${err.message}`));
        }
      });

      client.on('close', () => {
        console.warn('🔌 Redis connection closed.');
      });

      client.on('reconnecting', (time) => {
        console.log(`🔄 Redis client reconnecting in ${time}ms...`);
      });

      client.on('end', () => {
        console.log('🛑 Redis connection ended.');
      });

      // Set a timeout for initial connection
      const connectionTimeout = setTimeout(() => {
        if (!client.isReady) {
          console.error('❌ Redis connection timeout');
          reject(new Error('Redis connection timeout after 30 seconds'));
        }
      }, 30000);

      client.once('ready', () => {
        clearTimeout(connectionTimeout);
      });

    } catch (error) {
      console.error('❌ Failed to create Redis client:', error);
      reject(error);
    }
  });

  return redisClientPromise;
}

/**
 * Checks the health of the Redis connection.
 * @returns {Promise<{healthy: boolean, responseTime: number, status: string, timestamp: string, error?: string}>}
 */
async function checkRedisHealth() {
  try {
    const client = await getRedisClient();
    const startTime = Date.now();
    await client.ping();
    const responseTime = Date.now() - startTime;

    return {
      healthy: true,
      responseTime,
      status: 'ready',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      status: 'error',
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Gets information from the Redis server.
 * @returns {Promise<{status: string, info: object, timestamp: string, error?: string}>}
 */
async function getRedisInfo() {
  try {
    const client = await getRedisClient();
    const info = await client.info();

    const infoLines = info.split('\r\n');
    const redisInfo = {};

    for (const line of infoLines) {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          redisInfo[key] = value;
        }
      }
    }

    return {
      status: 'success',
      info: redisInfo,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Gracefully closes the Redis connection.
 * @returns {Promise<void>}
 */
async function closeRedis() {
  try {
    if (redisClientInstance) {
      await redisClientInstance.quit();
      console.log('✅ Redis connection closed gracefully');
    }
    redisClientPromise = null;
    redisClientInstance = null;
  } catch (error) {
    console.error('❌ Error closing Redis connection:', error);
  }
}

export default getRedisClient();
export {
  getRedisClient,
  checkRedisHealth,
  getRedisInfo,
  closeRedis
};
