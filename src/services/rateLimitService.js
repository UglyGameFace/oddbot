// src/services/rateLimitService.js - ENTERPRISE-GRADE RATE LIMITING + PROVIDER QUOTA SNAPSHOTS
import redis from './redisService.js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

// utility
const num = (v) => (v == null ? null : Number(v));
const pick = (o, keys) => {
  const out = {}; if (!o) return out;
  for (const k of keys) if (o[k] != null) out[k] = o[k];
  return out;
};

class EnterpriseRateLimitService {
  constructor() {
    this.limits = {
      user: {
        points: env.RATE_LIMIT_REQUESTS,
        duration: env.RATE_LIMIT_TIME_WINDOW, // ms
      },
    };
    console.log('✅ Enterprise Rate Limit Service Initialized.');
  }

  // -------- Sliding-window user limiter (unchanged) --------
  async checkRateLimit(identifier, type = 'user', context = '') {
    const limitConfig = this.limits[type];
    if (!limitConfig) return { allowed: true };

    try {
      const redisClient = await redis;
      const key = `ratelimit:${type}:${identifier}:${context}`;
      const now = Date.now();
      const windowStart = now - limitConfig.duration;

      const multi = redisClient.multi();
      multi.zremrangebyscore(key, 0, windowStart);
      multi.zadd(key, now, now);
      multi.zcard(key);
      multi.expire(key, Math.ceil(limitConfig.duration / 1000));

      const results = await multi.exec();
      const requestCount = results?.[2]?.[1] ?? 0;

      if (requestCount > limitConfig.points) {
        return { allowed: false, remaining: 0 };
      }
      return { allowed: true, remaining: Math.max(0, limitConfig.points - requestCount) };
    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limiter' });
      return { allowed: true, remaining: Infinity };
    }
  }

  // -------- Provider quota snapshots (no extra requests) --------
  // Parse provider-specific headers and normalize
  parseProviderHeaders(provider, headers = {}) {
    const h = headers || {};

    if (provider === 'theodds') {
      // The Odds API response headers
      // x-requests-remaining, x-requests-used, x-requests-last
      return {
        provider,
        remaining: num(h['x-requests-remaining']),
        used: num(h['x-requests-used']),
        limit: null,
        reset: null,
        window: null,
        raw: pick(h, ['x-requests-remaining','x-requests-used','x-requests-last']),
      };
    }

    // Generic X-RateLimit-* or RateLimit draft headers
    // X-RateLimit-Remaining, X-RateLimit-Limit, X-RateLimit-Reset, RateLimit, RateLimit-Policy
    const remaining = num(h['x-ratelimit-remaining'] ?? h['x-rate-limit-remaining']);
    const limit = num(h['x-ratelimit-limit'] ?? h['x-rate-limit-limit']);
    const reset = num(h['x-ratelimit-reset'] ?? h['x-rate-limit-reset']);
    const window = h['ratelimit-policy'] ?? h['ratelimit'] ?? null; // draft fields
    return {
      provider,
      remaining,
      used: limit != null && remaining != null ? limit - remaining : null,
      limit,
      reset,
      window,
      raw: pick(h, [
        'x-ratelimit-remaining','x-rate-limit-remaining',
        'x-ratelimit-limit','x-rate-limit-limit',
        'x-ratelimit-reset','x-rate-limit-reset',
        'ratelimit','ratelimit-policy'
      ]),
    };
  }

  // Save snapshot to Redis (1h TTL)
  async saveProviderQuota(provider, headers) {
    try {
      const snapshot = this.parseProviderHeaders(provider, headers);
      snapshot.at = Date.now();
      const client = await redis;
      await client.set(`quota:${provider}`, JSON.stringify(snapshot), { EX: 3600 });
      return snapshot;
    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limit_quota_save', provider });
      return null;
    }
  }

  // Read snapshot
  async getProviderQuota(provider) {
    try {
      const client = await redis;
      const raw = await client.get(`quota:${provider}`);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limit_quota_get', provider });
      return null;
    }
  }

  // Helper: should we bypass live calls for this provider?
  async shouldBypassLive(provider) {
    const snap = await this.getProviderQuota(provider);
    return !!(snap && snap.remaining === 0);
  }
}

export default new EnterpriseRateLimitService();
