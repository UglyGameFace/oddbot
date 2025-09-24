// src/services/rateLimitService.js - ENTERPRISE-GRADE RATE LIMITING WITH SENTRY ALERTING
import Redis from 'ioredis';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class EnterpriseRateLimitService {
  constructor() {
    this.redis = new Redis(env.REDIS_URL, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 10000
    });
    
    this.limits = this.initializeRateLimits();
    this.suspiciousActivities = new Map();
    this.adaptiveLimits = new Map();
    
    this.setupRedisEventHandlers();
    this.initializeAdaptiveRateLimiting();
  }

  initializeRateLimits() {
    return {
      // Per-user limits
      user: {
        points: env.RATE_LIMIT_REQUESTS,
        duration: env.RATE_LIMIT_TIME_WINDOW,
        blockDuration: 300000, // 5 minutes
        type: 'sliding_window'
      },
      
      // Per-IP limits (more restrictive)
      ip: {
        points: env.RATE_LIMIT_REQUESTS * 5, // Higher limit for IP
        duration: env.RATE_LIMIT_TIME_WINDOW,
        blockDuration: 600000, // 10 minutes
        type: 'fixed_window'
      },
      
      // Specific endpoint limits
      endpoints: {
        '/parlay': {
          points: 30,
          duration: 60000, // 1 minute
          blockDuration: 300000
        },
        '/odds': {
          points: 100,
          duration: 60000,
          blockDuration: 300000
        },
        '/ai': {
          points: 20,
          duration: 60000,
          blockDuration: 300000
        }
      },
      
      // Burst protection
      burst: {
        points: 10,
        duration: 10000, // 10 seconds
        blockDuration: 60000
      }
    };
  }

  async checkRateLimit(identifier, type = 'user', endpoint = null) {
    const key = this.generateRedisKey(identifier, type, endpoint);
    const limitConfig = this.getLimitConfig(type, endpoint);
    
    try {
      const current = await this.redis.get(key);
      const currentCount = parseInt(current) || 0;
      
      if (currentCount >= limitConfig.points) {
        await this.handleRateLimitExceeded(identifier, type, endpoint, currentCount);
        return { allowed: false, remaining: 0, retryAfter: limitConfig.blockDuration };
      }
      
      // Increment counter
      const multi = this.redis.multi();
      multi.incr(key);
      
      if (currentCount === 0) {
        multi.pexpire(key, limitConfig.duration);
      }
      
      await multi.exec();
      
      const remaining = Math.max(0, limitConfig.points - (currentCount + 1));
      
      // Check for suspicious patterns
      await this.checkSuspiciousActivity(identifier, type, endpoint, currentCount + 1);
      
      return { allowed: true, remaining, retryAfter: 0 };
      
    } catch (error) {
      // If Redis fails, fail open but log the issue
      sentryService.captureError(error, {
        component: 'rate_limit_service',
        operation: 'check_rate_limit',
        identifier,
        type,
        endpoint
      });
      
      return { allowed: true, remaining: Infinity, retryAfter: 0 };
    }
  }

  async handleRateLimitExceeded(identifier, type, endpoint, count) {
    const exceedanceData = {
      identifier,
      type,
      endpoint,
      count,
      timestamp: new Date().toISOString(),
      limit: this.getLimitConfig(type, endpoint).points
    };
    
    // Log to Sentry
    sentryService.captureMessage('Rate limit exceeded', {
      level: 'warning',
      extra: exceedanceData,
      tags: {
        type: 'rate_limit',
        identifier_type: type,
        endpoint: endpoint || 'general'
      }
    });
    
    // Track for adaptive limiting
    await this.trackRateLimitExceedance(exceedanceData);
    
    // Implement progressive backoff
    await this.applyProgressiveBackoff(identifier, type);
  }

  async checkSuspiciousActivity(identifier, type, endpoint, count) {
    const activityKey = `suspicious:${identifier}:${type}`;
    const window = 60000; // 1 minute window
    
    const recentActivity = await this.redis.get(activityKey);
    const activityCount = parseInt(recentActivity) || 0;
    
    if (activityCount > 10) { // More than 10 requests in 1 minute
      await this.flagSuspiciousActivity(identifier, type, endpoint, count);
    }
    
    // Increment activity counter
    const multi = this.redis.multi();
    multi.incr(activityKey);
    
    if (activityCount === 0) {
      multi.pexpire(activityKey, window);
    }
    
    await multi.exec();
  }

  async flagSuspiciousActivity(identifier, type, endpoint, count) {
    const suspiciousData = {
      identifier,
      type,
      endpoint,
      requestCount: count,
      timestamp: new Date().toISOString(),
      severity: this.calculateSuspiciousSeverity(count)
    };
    
    // Critical security alert
    sentryService.captureSecurityEvent('suspicious_activity', 'high', suspiciousData);
    
    // Apply temporary restrictions
    await this.applyTemporaryRestrictions(identifier, type, suspiciousData.severity);
  }

  // ADAPTIVE RATE LIMITING
  initializeAdaptiveRateLimiting() {
    setInterval(() => {
      this.adjustLimitsBasedOnLoad();
    }, 300000); // Adjust every 5 minutes
  }

  async adjustLimitsBasedOnLoad() {
    const systemLoad = await this.calculateSystemLoad();
    const errorRate = await this.calculateErrorRate();
    
    Object.keys(this.limits).forEach(limitType => {
      const adjustment = this.calculateLimitAdjustment(limitType, systemLoad, errorRate);
      this.applyLimitAdjustment(limitType, adjustment);
    });
  }

  calculateLimitAdjustment(limitType, systemLoad, errorRate) {
    let adjustment = 1.0;
    
    // Reduce limits under high load
    if (systemLoad > 0.8) {
      adjustment *= 0.7; // Reduce by 30%
    }
    
    // Reduce limits when error rate is high
    if (errorRate > 0.1) {
      adjustment *= 0.8; // Reduce by 20%
    }
    
    // Increase limits during low activity
    if (systemLoad < 0.3 && errorRate < 0.05) {
      adjustment *= 1.2; // Increase by 20%
    }
    
    return adjustment;
  }

  // ADVANCED FEATURES
  async getRateLimitMetrics(timeframe = '1h') {
    const metrics = {
      totalRequests: await this.getTotalRequests(timeframe),
      rateLimitHits: await this.getRateLimitHits(timeframe),
      topOffenders: await this.getTopOffenders(timeframe),
      systemLoad: await this.calculateSystemLoad(),
      adaptiveAdjustments: Array.from(this.adaptiveLimits.entries())
    };
    
    // Send metrics to Sentry for monitoring
    sentryService.trackBusinessMetric('rate_limit.metrics', 1, {
      timeframe,
      totalRequests: metrics.totalRequests,
      rateLimitHits: metrics.rateLimitHits
    });
    
    return metrics;
  }

  async resetRateLimit(identifier, type) {
    const key = this.generateRedisKey(identifier, type);
    await this.redis.del(key);
    
    sentryService.captureMessage('Rate limit manually reset', {
      level: 'info',
      extra: { identifier, type, timestamp: new Date().toISOString() }
    });
  }

  // UTILITY METHODS
  generateRedisKey(identifier, type, endpoint = null) {
    const baseKey = `ratelimit:${type}:${identifier}`;
    return endpoint ? `${baseKey}:${endpoint}` : baseKey;
  }

  getLimitConfig(type, endpoint) {
    if (endpoint && this.limits.endpoints[endpoint]) {
      return this.limits.endpoints[endpoint];
    }
    return this.limits[type] || this.limits.user;
  }

  setupRedisEventHandlers() {
    this.redis.on('error', (error) => {
      sentryService.captureError(error, {
        component: 'rate_limit_service',
        operation: 'redis_connection',
        severity: 'high'
      });
    });
    
    this.redis.on('connect', () => {
      console.log('✅ Rate Limit Service connected to Redis');
    });
  }

  // HEALTH CHECK
  async healthCheck() {
    try {
      await this.redis.ping();
      const metrics = await this.getRateLimitMetrics('5m');
      
      return {
        status: 'healthy',
        redis: 'connected',
        metrics: {
          totalRequests: metrics.totalRequests,
          rateLimitHits: metrics.rateLimitHits
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        redis: 'disconnected',
        error: error.message
      };
    }
  }
}

// Create singleton instance
const rateLimitService = new EnterpriseRateLimitService();
export default rateLimitService;