// src/services/healthService.js - COMPLETE RESILIENT VERSION

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
      const pingResult = await redis.ping();
      return { healthy: pingResult === 'PONG', latency: Date.now() - checkStart };
    } catch (error) {
      return { healthy: false, error: error.message, latency: Date.now() - checkStart };
    }
  }

  static async checkDatabase() {
    const checkStart = Date.now();
    try {
      const isConnected = await databaseService.testConnection();
      return { healthy: isConnected, latency: Date.now() - checkStart };
    } catch (error) {
      return { healthy: false, error: error.message, latency: Date.now() - checkStart };
    }
  }

  static async checkOddsService() {
    const checkStart = Date.now();
    try {
      // --- CHANGE START: QUOTA SAVER ---
      // This health check should not make a live API call. 
      // It will now check if sports are available (likely from cache) to verify service health.
      const availableSports = await withTimeout(
        oddsService.getAvailableSports(),
        HEALTH_CHECK_TIMEOUT,
        'OddsService_Health_Check'
      );
      const isHealthy = availableSports && availableSports.length > 0;
      if (!isHealthy) {
          console.warn('⚠️ Health Check: No available sports found from odds service to test against.');
      }
      return { healthy: isHealthy, latency: Date.now() - checkStart };
      // --- CHANGE END ---
    } catch (error) {
      return { healthy: false, error: error.message, latency: Date.now() - checkStart };
    }
  }

  static async checkGamesService() {
    const checkStart = Date.now();
    try {
      const status = await gamesService.getServiceStatus();
      return { healthy: status.status === 'healthy', latency: Date.now() - checkStart };
    } catch (error) {
      return { healthy: false, error: error.message, latency: Date.now() - checkStart };
    }
  }
}

class EnhancedHealthService {
  async getHealth() {
    const startTime = Date.now();
    
    const [redis, database, odds, games] = await Promise.all([
      ServiceHealthChecker.checkRedis(),
      ServiceHealthChecker.checkDatabase(),
      ServiceHealthChecker.checkOddsService(),
      ServiceHealthChecker.checkGamesService()
    ]);

    const healthy = redis.healthy && database.healthy && odds.healthy && games.healthy;
    
    return {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      processing_time_ms: Date.now() - startTime,
      services: {
        redis: { ok: redis.healthy, error: redis.error },
        database: { ok: database.healthy, error: database.error },
        odds: { ok: odds.healthy, error: odds.error },
        games: { ok: games.healthy, error: games.error },
      }
    };
  }

  async waitForReady(timeoutMs = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const report = await this.getHealth();
      if (report.ok) {
        console.log(`✅ Health check passed: All services are ready.`);
        return true; 
      }
      console.log(`⏳ Services not ready yet. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    console.error(`❌ Startup timeout of ${timeoutMs}ms reached. Services are still degraded.`);
    return false;
  }
}

const healthServiceInstance = new EnhancedHealthService();
export default healthServiceInstance;
