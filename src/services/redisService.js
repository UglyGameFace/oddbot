// src/services/redisService.js

import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

let redisClientPromise = null;

/**
 * Creates a single, memoized Redis client instance.
 * This pattern ensures that we only attempt to connect once, and all
 * other parts of the application will wait for the connection to resolve.
 */
function getRedisClient() {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = new Promise((resolve, reject) => {
    console.log('Attempting to connect to Redis...');
    
    const redisOptions = {
      // These options are optimized for cloud environments and prevent common issues.
      maxRetriesPerRequest: 3,
      connectTimeout: 15000,
      lazyConnect: false, // CHANGED: Connect immediately on startup to get clear errors.
      enableReadyCheck: false,
      // Keep the connection alive by sending a ping, crucial for serverless environments
      keepAlive: 50000, 
      // If the connection is lost, automatically try to reconnect.
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000); // Exponential backoff
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
      // UPDATED: Log the full error object for more detail.
      console.error('❌ Redis client error:', err); 
      sentryService.captureError(err, { component: 'redis_service' });
      // On the first connection error, reject the promise to allow for fast failure
      if (!client.isReady) {
        reject(new Error('Failed to connect to Redis.'));
      }
    });

    client.on('close', () => console.warn(' Redis connection closed.'));
    
    client.on('reconnecting', () => console.log(' Redis client reconnecting...'));
  });

  return redisClientPromise;
}

// Export the promise directly. Other modules will `await` this promise
// to get the connected client instance.
export default getRedisClient();
