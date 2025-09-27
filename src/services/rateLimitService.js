// src/services/rateLimitService.js - ENTERPRISE-GRADE RATE LIMITING
import redis from './redisService.js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

class EnterpriseRateLimitService {
  constructor() {
    this.limits = {
      user: {
        points: env.RATE_LIMIT_REQUESTS,
        duration: env.RATE_LIMIT_TIME_WINDOW, // in ms
      },
    };
    console.log('✅ Enterprise Rate Limit Service Initialized.');
  }

  /**
   * Checks if an action is allowed for a given identifier.
   * Uses a sliding window log algorithm in Redis.
   * @param {string} identifier User ID, IP address, etc.
   * @param {string} type The type of limit to apply (e.g., 'user').
   * @param {string} context The specific action (e.g., a command name).
   * @returns {Promise<object>} An object indicating if the action is allowed.
   */
  async checkRateLimit(identifier, type = 'user', context = '') {
  const limitConfig = this.limits[type];
  if (!limitConfig) return { allowed: true };

  // Resolve the Redis client promise here
  const redisClient = await redis; 

  const key = `ratelimit:${type}:${identifier}:${context}`;
  const now = Date.now();
  const windowStart = now - limitConfig.duration;

  try {
    // Use the resolved client
    const multi = redisClient.multi(); 
    multi.zremrangebyscore(key, 0, windowStart);
    multi.zadd(key, now, now);
    multi.zcard(key);
    multi.expire(key, Math.ceil(limitConfig.duration / 1000));

    const results = await multi.exec();
    const requestCount = results[2][1];

    if (requestCount > limitConfig.points) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: limitConfig.points - requestCount };

  } catch (error) {
    // This import now works correctly
    sentryService.captureError(error, { component: 'rate_limiter' }); 
    return { allowed: true, remaining: Infinity };
  }
}
}

export default new EnterpriseRateLimitService();
