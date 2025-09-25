// src/services/rateLimitService.js - ENTERPRISE-GRADE RATE LIMITING
import redis from './redisService.js';
import env from '../config/env.js';
import sentryService from './sentryService.js';

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
    if (!limitConfig) return { allowed: true }; // Fail open if no config

    const key = `ratelimit:${type}:${identifier}:${context}`;
    const now = Date.now();
    const windowStart = now - limitConfig.duration;

    try {
      const multi = redis.multi();
      // Remove all timestamps outside the current window
      multi.zremrangebyscore(key, 0, windowStart);
      // Add the timestamp of the current request
      multi.zadd(key, now, now);
      // Count the number of requests in the current window
      multi.zcard(key);
      // Set the key to expire after the window duration to prevent memory leaks
      multi.expire(key, Math.ceil(limitConfig.duration / 1000));
      
      const results = await multi.exec();
      const requestCount = results[2][1]; // Result of the zcard command

      if (requestCount > limitConfig.points) {
        return { allowed: false, remaining: 0 };
      }

      return { allowed: true, remaining: limitConfig.points - requestCount };

    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limiter' });
      // Fail open: If Redis fails, allow the request but log the error.
      return { allowed: true, remaining: Infinity };
    }
  }
}

export default new EnterpriseRateLimitService();
