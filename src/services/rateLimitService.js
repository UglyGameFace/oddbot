// src/services/rateLimitService.js - COMPLETE FIXED VERSION
import { getRedisClient } from './redisService.js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';
import { sleep } from '../utils/asyncUtils.js';

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
        points: Number(env.RATE_LIMIT_REQUESTS || 100),
        duration: Number(env.RATE_LIMIT_TIME_WINDOW || 60_000),
      },
      api_provider: {
        points: Number(env.API_RATE_LIMIT_REQUESTS || 1000),
        duration: Number(env.API_RATE_LIMIT_WINDOW || 3600000),
      },
      telegram: {
        points: Number(env.TELEGRAM_RATE_LIMIT_REQUESTS || 30),
        duration: Number(env.TELEGRAM_RATE_LIMIT_WINDOW || 60000),
      }
    };
    
    this.providerConfigs = {
      theodds: {
        name: 'The Odds API',
        monthly_limit: 1000,
        burst_limit: 10,
        recommended_delay: 1000
      },
      sportradar: {
        name: 'SportRadar',
        monthly_limit: null,
        burst_limit: 5,
        recommended_delay: 1200
      },
      apisports: {
        name: 'API-Sports',
        daily_limit: 100,
        burst_limit: 3,
        recommended_delay: 2000
      }
    };
    
    console.log('✅ Enterprise Rate Limit Service Initialized.');
  }

  async checkRateLimit(identifier, type = 'user', context = '') {
    const limitConfig = this.limits[type];
    if (!limitConfig) return { allowed: true, remaining: Infinity };

    try {
      const redisClient = await getRedisClient();
      if (!redisClient) return { allowed: true, remaining: Infinity, error: 'Redis not available' };

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

      const remaining = Math.max(0, limitConfig.points - requestCount);
      const allowed = requestCount <= limitConfig.points;
      
      const resetTime = now + limitConfig.duration;
      const retryAfter = allowed ? 0 : Math.ceil((resetTime - now) / 1000);

      return { 
        allowed, 
        remaining,
        limit: limitConfig.points,
        reset: new Date(resetTime).toISOString(),
        retryAfter,
        window: limitConfig.duration
      };

    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limiter' });
      return { allowed: true, remaining: Infinity, error: error.message };
    }
  }

  async checkBurstLimit(identifier, maxBurst = 10, windowMs = 1000) {
    try {
      const redisClient = await getRedisClient();
      if (!redisClient) return { allowed: true, error: 'Redis not available' };

      const key = `burst:${identifier}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      const multi = redisClient.multi();
      multi.zremrangebyscore(key, 0, windowStart);
      multi.zadd(key, now, now);
      multi.zcard(key);
      multi.expire(key, Math.ceil(windowMs / 1000));
      const results = await multi.exec();
      const burstCount = results?.[2]?.[1] ?? 0;

      if (burstCount > maxBurst) {
        const oldest = await redisClient.zrange(key, 0, 0, 'WITHSCORES');
        const waitTime = oldest.length ? Math.ceil((parseInt(oldest[1]) + windowMs - now) / 1000) : 1;
        return { allowed: false, wait: waitTime, current: burstCount, max: maxBurst };
      }

      return { allowed: true, current: burstCount, max: maxBurst };

    } catch (error) {
      console.error('Burst limit check failed:', error);
      return { allowed: true, error: error.message };
    }
  }

  parseProviderHeaders(provider, headers = {}) {
    const h = headers || {};

    if (provider === 'theodds') {
      const remaining = num(h['x-requests-remaining']);
      const used = num(h['x-requests-used']);
      
      return {
        provider,
        name: 'The Odds API',
        remaining,
        used,
        limit: 1000,
        reset: this._calculateOddsAPIReset(),
        window: 'monthly',
        utilization: remaining !== null ? ((used || 0) / 1000 * 100).toFixed(1) : null,
        critical: remaining !== null && remaining < 50,
        raw: pick(h, ['x-requests-remaining','x-requests-used','x-requests-last']),
      };
    }

    if (provider === 'sportradar') {
      return {
        provider,
        name: 'SportRadar',
        remaining: null,
        used: null,
        limit: 'account-tier',
        reset: null,
        window: 'policy-dependent',
        utilization: null,
        critical: false,
        raw: {},
      };
    }

    if (provider === 'apisports') {
      const remaining = num(h['x-ratelimit-requests-remaining'] ?? h['X-RateLimit-Remaining']);
      const limit = num(h['x-ratelimit-requests-limit'] ?? h['X-RateLimit-Limit']);
      const used = limit != null && remaining != null ? limit - remaining : null;
      
      return {
        provider,
        name: 'API-Sports',
        remaining,
        used,
        limit,
        reset: this._calculateDailyReset(),
        window: 'daily',
        utilization: limit && remaining ? ((limit - remaining) / limit * 100).toFixed(1) : null,
        critical: remaining !== null && remaining < 10,
        raw: pick(h, [
          'x-ratelimit-requests-remaining',
          'x-ratelimit-requests-limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Limit'
        ]),
      };
    }

    const remaining = num(h['x-ratelimit-remaining'] ?? h['x-rate-limit-remaining']);
    const limit = num(h['x-ratelimit-limit'] ?? h['x-rate-limit-limit']);
    const reset = num(h['x-ratelimit-reset'] ?? h['x-rate-limit-reset']);
    const window = h['ratelimit-policy'] ?? h['ratelimit'] ?? null;
    const used = limit != null && remaining != null ? limit - remaining : null;
    
    return {
      provider,
      name: provider,
      remaining,
      used,
      limit,
      reset: reset ? new Date(Date.now() + reset * 1000).toISOString() : null,
      window,
      utilization: limit && remaining ? ((limit - remaining) / limit * 100).toFixed(1) : null,
      critical: remaining !== null && remaining < (limit || 100) * 0.1,
      raw: pick(h, [
        'x-ratelimit-remaining','x-rate-limit-remaining',
        'x-ratelimit-limit','x-rate-limit-limit',
        'x-ratelimit-reset','x-rate-limit-reset',
        'ratelimit','ratelimit-policy'
      ]),
    };
  }

  async saveProviderQuota(provider, headers) {
    try {
      const snapshot = this.parseProviderHeaders(provider, headers);
      snapshot.at = Date.now();
      snapshot.timestamp = new Date().toISOString();
      
      const client = await getRedisClient();
      if (!client) return null;
      
      await client.set(`quota:${provider}:current`, JSON.stringify(snapshot), { EX: 3600 });
      
      const historyKey = `quota:${provider}:history`;
      await client.zadd(historyKey, snapshot.at, JSON.stringify(snapshot));
      await client.zremrangebyscore(historyKey, 0, snapshot.at - (24 * 60 * 60 * 1000));
      await client.expire(historyKey, 48 * 60 * 60);
      
      await this._updateProviderStatus(provider, snapshot);
      
      return snapshot;
    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limit_quota_save', provider });
      return null;
    }
  }

  async getProviderQuota(provider, includeHistory = false) {
    try {
      const client = await getRedisClient();
      if (!client) return null;

      const current = await client.get(`quota:${provider}:current`);
      const snapshot = current ? JSON.parse(current) : null;
      
      if (!includeHistory || !snapshot) {
        return snapshot;
      }

      const historyKey = `quota:${provider}:history`;
      const historyRaw = await client.zrange(historyKey, -10, -1);
      const history = historyRaw.map(entry => JSON.parse(entry));
      
      const trends = this._analyzeQuotaTrends(history, snapshot);
      
      return {
        ...snapshot,
        history: history.slice(-5),
        trends
      };

    } catch (error) {
      sentryService.captureError(error, { component: 'rate_limit_quota_get', provider });
      return null;
    }
  }

  async shouldBypassLive(provider) {
    const snap = await this.getProviderQuota(provider);
    if (!snap) return false;
    
    const conditions = [
      snap.remaining === 0,
      snap.critical === true,
      snap.utilization > 95,
      await this._isProviderTempBanned(provider)
    ];
    
    return conditions.some(condition => condition === true);
  }

  async getRecommendedDelay(provider) {
    const config = this.providerConfigs[provider];
    if (!config) return 1000;
    
    const quota = await this.getProviderQuota(provider);
    if (!quota) return config.recommended_delay;
    
    let delay = config.recommended_delay;
    if (quota.utilization > 80) {
      delay *= 2;
    } else if (quota.utilization > 60) {
      delay *= 1.5;
    } else if (quota.utilization < 20) {
      delay *= 0.8;
    }
    
    return Math.max(500, Math.min(5000, delay));
  }

  async getProviderHealth(provider) {
    const quota = await this.getProviderQuota(provider, true);
    const config = this.providerConfigs[provider];
    
    if (!quota) {
      return {
        provider,
        status: 'unknown',
        last_seen: null,
        recommendation: 'Check API configuration'
      };
    }
    
    const hoursSinceUpdate = (Date.now() - quota.at) / (1000 * 60 * 60);
    let status = 'healthy';
    let recommendation = 'Normal operation';
    
    if (hoursSinceUpdate > 2) {
      status = 'stale';
      recommendation = 'Data may be outdated';
    }
    
    if (quota.critical) {
      status = 'critical';
      recommendation = 'Approaching rate limits - consider reducing usage';
    }
    
    if (quota.remaining === 0) {
      status = 'exhausted';
      recommendation = 'Rate limit exhausted - bypassing provider';
    }
    
    return {
      provider,
      name: config?.name || provider,
      status,
      last_seen: new Date(quota.at).toISOString(),
      utilization: quota.utilization,
      remaining: quota.remaining,
      recommendation,
      should_bypass: await this.shouldBypassLive(provider),
      recommended_delay: await this.getRecommendedDelay(provider)
    };
  }

  async getAllProvidersHealth() {
    const providers = Object.keys(this.providerConfigs);
    const healthReports = await Promise.all(
      providers.map(provider => this.getProviderHealth(provider))
    );
    
    const overallStatus = healthReports.every(r => r.status === 'healthy') ? 'healthy' :
                         healthReports.some(r => r.status === 'critical') ? 'degraded' : 'warning';
    
    return {
      overall: overallStatus,
      timestamp: new Date().toISOString(),
      providers: healthReports
    };
  }

  async getRateLimitStats(timeframe = '24h') {
    try {
      const client = await getRedisClient();
      if (!client) return { error: 'Redis not available' };

      const patterns = ['ratelimit:*', 'burst:*', 'quota:*'];
      
      const stats = {};
      for (const pattern of patterns) {
        const keys = await client.keys(pattern);
        stats[pattern] = keys.length;
      }
      
      const recentLimits = await client.keys('ratelimit:*:current');
      const limitedProviders = [];
      
      for (const key of recentLimits) {
        const quota = await client.get(key);
        if (quota) {
          const data = JSON.parse(quota);
          if (data.critical || data.remaining === 0) {
            limitedProviders.push(data.provider);
          }
        }
      }
      
      return {
        timeframe,
        timestamp: new Date().toISOString(),
        key_counts: stats,
        total_keys: Object.values(stats).reduce((sum, count) => sum + count, 0),
        limited_providers: limitedProviders,
        active_limits: Object.keys(this.limits)
      };
      
    } catch (error) {
      console.error('Failed to get rate limit stats:', error);
      return { error: error.message };
    }
  }

  async _updateProviderStatus(provider, snapshot) {
    try {
      const client = await getRedisClient();
      if (!client) return;

      const statusKey = `provider:${provider}:status`;
      
      const status = {
        last_updated: snapshot.timestamp,
        remaining: snapshot.remaining,
        utilization: snapshot.utilization,
        critical: snapshot.critical,
        healthy: !snapshot.critical && snapshot.remaining !== 0
      };
      
      await client.set(statusKey, JSON.stringify(status), { EX: 7200 });
      
    } catch (error) {
      console.error(`Failed to update provider status for ${provider}:`, error);
    }
  }

  async _isProviderTempBanned(provider) {
    try {
      const client = await getRedisClient();
      if (!client) return false;
      const banKey = `provider:${provider}:banned`;
      const banned = await client.get(banKey);
      return banned === '1';
    } catch (error) {
      return false;
    }
  }

  _analyzeQuotaTrends(history, current) {
    if (history.length < 2) return { trend: 'insufficient_data' };
    
    const recent = history.slice(-3);
    const utilizationTrend = recent.map(h => parseFloat(h.utilization || 0));
    const remainingTrend = recent.map(h => h.remaining || 0);
    
    const utilizationSlope = this._calculateSlope(utilizationTrend);
    const remainingSlope = this._calculateSlope(remainingTrend);
    
    let trend = 'stable';
    if (utilizationSlope > 5) trend = 'increasing';
    if (utilizationSlope > 15) trend = 'rapid_increase';
    if (utilizationSlope < -5) trend = 'decreasing';
    
    return {
      trend,
      utilization_slope: utilizationSlope,
      remaining_slope: remainingSlope,
      data_points: history.length,
      prediction: this._predictExhaustion(history, current)
    };
  }

  _calculateSlope(values) {
    if (values.length < 2) return 0;
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    values.forEach((y, i) => {
      const x = i;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  _predictExhaustion(history, current) {
    if (!current.remaining || !current.utilization) return 'unknown';
    
    const utilizationRate = this._calculateSlope(history.slice(-5).map(h => parseFloat(h.utilization || 0)));
    const timeToExhaustion = utilizationRate > 0 ? current.remaining / (utilizationRate * 24) : Infinity;
    
    if (timeToExhaustion === Infinity) return 'no_immediate_risk';
    if (timeToExhaustion < 1) return 'within_24_hours';
    if (timeToExhaustion < 7) return 'within_week';
    return 'safe';
  }

  _calculateOddsAPIReset() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.toISOString();
  }

  _calculateDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    return tomorrow.toISOString();
  }
}

export const rateLimitService = new EnterpriseRateLimitService();
export default rateLimitService;
