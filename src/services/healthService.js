// src/services/healthService.js - COMPLETE RESILIENT VERSION WITH FIXED ODDS CHECK

import { getRedisClient } from './redisService.js';
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import { rateLimitService } from './rateLimitService.js';
import { sentryService } from './sentryService.js';
import { withTimeout } from '../utils/asyncUtils.js';

const HEALTH_CHECK_TIMEOUT = 10000;

class ServiceHealthChecker {
  static async checkRedis() {
    const checkStart = Date.now();
    try {
      const redis = await getRedisClient();
      if (!redis) return { healthy: false, error: 'Redis not configured' };
      
      // Use a simpler ping test that doesn't rely on complex Redis operations
      const pingResult = await withTimeout(redis.ping(), 3000, 'Redis_Ping');
      return { 
        healthy: pingResult === 'PONG', 
        latency: Date.now() - checkStart,
        status: redis.status 
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message, 
        latency: Date.now() - checkStart 
      };
    }
  }

  static async checkDatabase() {
    const checkStart = Date.now();
    try {
      const isConnected = await withTimeout(
        databaseService.testConnection(), 
        5000, 
        'Database_Health_Check'
      );
      return { 
        healthy: !!isConnected, 
        latency: Date.now() - checkStart 
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message, 
        latency: Date.now() - checkStart 
      };
    }
  }

  static async checkOddsService() {
    const checkStart = Date.now();
    try {
      // Use a simpler check that doesn't trigger API calls
      const isInitialized = oddsService.initialized;
      const activeProviders = oddsService.getActiveProviders ? oddsService.getActiveProviders() : [];
      
      return { 
        healthy: isInitialized && activeProviders.length > 0, 
        latency: Date.now() - checkStart,
        providers: activeProviders.length
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message, 
        latency: Date.now() - checkStart 
      };
    }
  }

  static async checkGamesService() {
    const checkStart = Date.now();
    try {
      // Simple check without triggering complex operations
      const isInitialized = gamesService.initialized;
      return { 
        healthy: isInitialized, 
        latency: Date.now() - checkStart 
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message, 
        latency: Date.now() - checkStart 
      };
    }
  }

  static async checkCacheService() {
    const checkStart = Date.now();
    try {
      // Simple cache service check without complex Redis operations
      const cacheService = await import('./cacheService.js');
      const isAvailable = cacheService.default.isAvailable ? cacheService.default.isAvailable() : false;
      return { 
        healthy: isAvailable, 
        latency: Date.now() - checkStart 
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message, 
        latency: Date.now() - checkStart 
      };
    }
  }
}

class EnhancedHealthService {
  constructor() {
    this.lastHealthCheck = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
  }

  async getHealth() {
    const startTime = Date.now();
    
    try {
      const [redis, database, odds, games, cache] = await Promise.allSettled([
        ServiceHealthChecker.checkRedis(),
        ServiceHealthChecker.checkDatabase(),
        ServiceHealthChecker.checkOddsService(),
        ServiceHealthChecker.checkGamesService(),
        ServiceHealthChecker.checkCacheService()
      ]);

      const results = {
        redis: redis.status === 'fulfilled' ? redis.value : { healthy: false, error: redis.reason?.message || 'Unknown error' },
        database: database.status === 'fulfilled' ? database.value : { healthy: false, error: database.reason?.message || 'Unknown error' },
        odds: odds.status === 'fulfilled' ? odds.value : { healthy: false, error: odds.reason?.message || 'Unknown error' },
        games: games.status === 'fulfilled' ? games.value : { healthy: false, error: games.reason?.message || 'Unknown error' },
        cache: cache.status === 'fulfilled' ? cache.value : { healthy: false, error: cache.reason?.message || 'Unknown error' }
      };

      const allHealthy = Object.values(results).every(service => service.healthy);
      
      if (allHealthy) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }

      const healthReport = {
        ok: allHealthy && this.consecutiveFailures < this.maxConsecutiveFailures,
        status: allHealthy ? 'healthy' : 'degraded',
        processing_time_ms: Date.now() - startTime,
        consecutive_failures: this.consecutiveFailures,
        timestamp: new Date().toISOString(),
        services: {
          redis: { 
            ok: results.redis.healthy, 
            latency: results.redis.latency,
            error: results.redis.error,
            status: results.redis.status
          },
          database: { 
            ok: results.database.healthy, 
            latency: results.database.latency,
            error: results.database.error 
          },
          odds: { 
            ok: results.odds.healthy, 
            latency: results.odds.latency,
            error: results.odds.error,
            providers: results.odds.providers
          },
          games: { 
            ok: results.games.healthy, 
            latency: results.games.latency,
            error: results.games.error 
          },
          cache: { 
            ok: results.cache.healthy, 
            latency: results.cache.latency,
            error: results.cache.error 
          }
        }
      };

      this.lastHealthCheck = healthReport;
      return healthReport;

    } catch (error) {
      console.error('❌ HealthService: Comprehensive health check failed:', error.message);
      
      const errorReport = {
        ok: false,
        status: 'error',
        processing_time_ms: Date.now() - startTime,
        error: error.message,
        timestamp: new Date().toISOString(),
        services: {
          redis: { ok: false, error: 'Health check system error' },
          database: { ok: false, error: 'Health check system error' },
          odds: { ok: false, error: 'Health check system error' },
          games: { ok: false, error: 'Health check system error' },
          cache: { ok: false, error: 'Health check system error' }
        }
      };

      this.lastHealthCheck = errorReport;
      return errorReport;
    }
  }

  async waitForReady(timeoutMs = 60000) {
    const startTime = Date.now();
    const checkInterval = 2000;
    
    console.log(`⏳ HealthService: Waiting for services to be ready (timeout: ${timeoutMs}ms)...`);
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const report = await this.getHealth();
        
        if (report.ok) {
          console.log(`✅ HealthService: All services are ready!`);
          return true;
        }
        
        // Log which services are failing
        const failingServices = Object.entries(report.services)
          .filter(([_, service]) => !service.ok)
          .map(([name, _]) => name);
          
        if (failingServices.length > 0) {
          console.log(`⏳ HealthService: Waiting for services: ${failingServices.join(', ')}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (error) {
        console.error(`❌ HealthService: Error during readiness check:`, error.message);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }
    
    console.error(`❌ HealthService: Startup timeout of ${timeoutMs}ms reached. Services are still degraded.`);
    return false;
  }

  getLastHealthCheck() {
    return this.lastHealthCheck;
  }

  resetFailureCount() {
    this.consecutiveFailures = 0;
  }
}

const healthServiceInstance = new EnhancedHealthService();
export default healthServiceInstance;
