// src/services/healthService.js - FINAL SIMPLIFIED VERSION

import { getRedisClient } from './redisService.js';
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import { sentryService } from './sentryService.js';
import { withTimeout } from '../utils/asyncUtils.js';

class ServiceHealthChecker {
  static async checkRedis() {
    const checkStart = Date.now();
    try {
      const redis = await getRedisClient();
      if (!redis) return { healthy: false, error: 'Redis not configured' };
      
      const pingResult = await withTimeout(redis.ping(), 5000, 'Redis_Ping');
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
      // SIMPLIFIED: Just check if odds service exists and has providers
      const isHealthy = oddsService && oddsService.providers && oddsService.providers.length > 0;
      
      return { 
        healthy: isHealthy,
        latency: Date.now() - checkStart,
        providers: oddsService.providers?.length || 0,
        initialized: !!oddsService.initialized
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
      // SIMPLIFIED: Just check if games service exists and is initialized
      const isHealthy = gamesService && gamesService.initialized;
      
      return { 
        healthy: isHealthy, 
        latency: Date.now() - checkStart,
        initialized: !!gamesService.initialized
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
      const [redis, database, odds, games] = await Promise.allSettled([
        ServiceHealthChecker.checkRedis(),
        ServiceHealthChecker.checkDatabase(),
        ServiceHealthChecker.checkOddsService(),
        ServiceHealthChecker.checkGamesService()
      ]);

      const results = {
        redis: redis.status === 'fulfilled' ? redis.value : { healthy: false, error: redis.reason?.message || 'Unknown error' },
        database: database.status === 'fulfilled' ? database.value : { healthy: false, error: database.reason?.message || 'Unknown error' },
        odds: odds.status === 'fulfilled' ? odds.value : { healthy: false, error: odds.reason?.message || 'Unknown error' },
        games: games.status === 'fulfilled' ? games.value : { healthy: false, error: games.reason?.message || 'Unknown error' }
      };

      // SIMPLIFIED: Only require database and redis to be healthy for overall health
      const criticalServicesHealthy = results.database.healthy && results.redis.healthy;
      
      if (criticalServicesHealthy) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }

      const healthReport = {
        ok: criticalServicesHealthy && this.consecutiveFailures < this.maxConsecutiveFailures,
        status: criticalServicesHealthy ? 'healthy' : 'degraded',
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
            providers: results.odds.providers,
            initialized: results.odds.initialized
          },
          games: { 
            ok: results.games.healthy, 
            latency: results.games.latency,
            error: results.games.error,
            initialized: results.games.initialized
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
          games: { ok: false, error: 'Health check system error' }
        }
      };

      this.lastHealthCheck = errorReport;
      return errorReport;
    }
  }

  async waitForReady(timeoutMs = 30000) {
    const startTime = Date.now();
    const checkInterval = 2000;
    
    console.log(`⏳ HealthService: Waiting for services to be ready (timeout: ${timeoutMs}ms)...`);
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const report = await this.getHealth();
        
        // SIMPLIFIED: Only wait for database and Redis to be ready
        // Games and Odds services can start in degraded mode
        const criticalServicesReady = report.services.database.ok && report.services.redis.ok;
        
        if (criticalServicesReady) {
          console.log(`✅ HealthService: Critical services ready! Starting application...`);
          return true;
        }
        
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
