// src/services/healthService.js - FINAL ABSOLUTE FIXED VERSION
import { getRedisClient } from './redisService.js';
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import { rateLimitService } from './rateLimitService.js';
import { sentryService } from './sentryService.js';
import { withTimeout } from '../utils/asyncUtils.js';

const HEALTH_CHECK_TIMEOUT = 10000;
const CACHE_TTL_HEALTH = 30;

class ServiceHealthChecker {
  static async checkRedis() {
    const checkStart = Date.now();
    
    try {
      const redis = await getRedisClient();
      
      if (!redis) {
        return {
          healthy: false,
          status: 'not_configured',
          error: 'Redis not configured',
          timestamp: new Date().toISOString(),
          latency: {
            total: Date.now() - checkStart
          }
        };
      }

      const pingStart = Date.now();
      const pingResult = await redis.ping();
      const pingTime = Date.now() - pingStart;

      const infoStart = Date.now();
      const info = await redis.info();
      const infoTime = Date.now() - infoStart;

      const testKey = `health_test_${Date.now()}`;
      const writeStart = Date.now();
      await redis.setex(testKey, 10, 'health_check_value');
      const writeTime = Date.now() - writeStart;

      const readStart = Date.now();
      const readValue = await redis.get(testKey);
      const readTime = Date.now() - readStart;

      await redis.del(testKey);

      const totalTime = Date.now() - checkStart;

      const parsedInfo = this.parseRedisInfo(info);

      return {
        healthy: pingResult === 'PONG' && readValue === 'health_check_value',
        status: 'connected',
        latency: {
          ping: pingTime,
          read: readTime,
          write: writeTime,
          total: totalTime
        },
        metrics: {
          connected_clients: parseInt(parsedInfo.connected_clients) || 0,
          used_memory: parsedInfo.used_memory_human,
          keyspace_hits: parseInt(parsedInfo.keyspace_hits) || 0,
          keyspace_misses: parseInt(parsedInfo.keyspace_misses) || 0,
          hit_rate: parsedInfo.keyspace_hits && parsedInfo.keyspace_misses ? 
            (parseInt(parsedInfo.keyspace_hits) / (parseInt(parsedInfo.keyspace_hits) + parseInt(parsedInfo.keyspace_misses))).toFixed(4) : 0,
          uptime: parsedInfo.uptime_in_seconds
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        status: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: Date.now() - checkStart
        }
      };
    }
  }

  static async checkDatabase() {
    const checkStart = Date.now();
    
    try {
      const connectionStart = Date.now();
      const sports = await databaseService.getDistinctSports();
      const connectionTime = Date.now() - connectionStart;

      const statsStart = Date.now();
      const dbStats = await databaseService.getDatabaseStats();
      const statsTime = Date.now() - statsStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(sports) && dbStats?.status === 'healthy',
        status: 'connected',
        latency: {
          connection: connectionTime,
          statistics: statsTime,
          total: totalTime
        },
        metrics: {
          total_sports: sports?.length || 0,
          total_games: dbStats?.total_games || 0,
          total_users: dbStats?.total_users || 0,
          last_updated: dbStats?.last_updated
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        status: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: Date.now() - checkStart
        }
      };
    }
  }

  static async checkOddsService() {
    const checkStart = Date.now();
    
    try {
      const oddsStart = Date.now();
      const nbaOdds = await withTimeout(
        oddsService.getSportOdds('basketball_nba', { useCache: false }),
        HEALTH_CHECK_TIMEOUT,
        'OddsService_NBA'
      );
      const oddsTime = Date.now() - oddsStart;

      const statusStart = Date.now();
      const serviceStatus = await oddsService.getServiceStatus();
      const statusTime = Date.now() - statusStart;

      const freshnessStart = Date.now();
      const freshness = await oddsService.getDataFreshness('basketball_nba');
      const freshnessTime = Date.now() - freshnessStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(nbaOdds) && serviceStatus?.status === 'healthy',
        status: serviceStatus?.status || 'unknown',
        latency: {
          odds_fetch: oddsTime,
          status_check: statusTime,
          freshness_check: freshnessTime,
          total: totalTime
        },
        metrics: {
          games_available: nbaOdds?.length || 0,
          data_freshness: freshness?.overall?.status || 'unknown',
          providers_healthy: Object.values(freshness?.providers || {}).filter(p => p.status === 'active').length,
          total_providers: Object.keys(freshness?.providers || {}).length
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: Date.now() - checkStart
        }
      };
    }
  }

  static async checkGamesService() {
    const checkStart = Date.now();
    
    try {
      const sportsStart = Date.now();
      const sports = await gamesService.getAvailableSports();
      const sportsTime = Date.now() - sportsStart;

      const gamesStart = Date.now();
      const nbaGames = await gamesService.getGamesForSport('basketball_nba', { useCache: false });
      const gamesTime = Date.now() - gamesStart;

      const statusStart = Date.now();
      const serviceStatus = await gamesService.getServiceStatus();
      const statusTime = Date.now() - statusStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(sports) && Array.isArray(nbaGames) && serviceStatus?.status === 'healthy',
        status: serviceStatus?.status || 'unknown',
        latency: {
          sports_fetch: sportsTime,
          games_fetch: gamesTime,
          status_check: statusTime,
          total: totalTime
        },
        metrics: {
          total_sports: sports?.length || 0,
          games_available: nbaGames?.length || 0,
          cache_status: serviceStatus?.cache?.enabled ? 'enabled' : 'disabled',
          data_sources: Object.keys(serviceStatus?.sources || {}).filter(k => serviceStatus.sources[k] === 'active').length
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: Date.now() - checkStart
        }
      };
    }
  }

  static async checkRateLimitService() {
    const checkStart = Date.now();
    
    try {
      const testIdentifier = `health_test_${Date.now()}`;
      
      const limitStart = Date.now();
      const limitCheck = await rateLimitService.checkRateLimit(testIdentifier, 'user', 'health_check');
      const limitTime = Date.now() - limitStart;

      const quotaStart = Date.now();
      const oddsQuota = await rateLimitService.getProviderQuota('theodds');
      const quotaTime = Date.now() - quotaStart;

      const healthStart = Date.now();
      const providerHealth = await rateLimitService.getAllProvidersHealth();
      const healthTime = Date.now() - healthStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: limitCheck.allowed !== undefined && oddsQuota !== undefined,
        status: 'operational',
        latency: {
          limit_check: limitTime,
          quota_check: quotaTime,
          health_check: healthTime,
          total: totalTime
        },
        metrics: {
          rate_limiting_working: limitCheck.allowed !== undefined,
          provider_quotas_available: oddsQuota ? 1 : 0,
          providers_health: providerHealth.overall,
          test_remaining: limitCheck.remaining
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: Date.now() - checkStart
        }
      };
    }
  }

  static parseRedisInfo(infoString) {
    const lines = (infoString || '').split('\r\n');
    const info = {};
    
    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          info[key] = value;
        }
      }
    }
    
    return info;
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

    const healthy = redis.healthy && database.healthy; // Core services
    
    return {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      processing_time_ms: Date.now() - startTime,
      services: {
        redis: { ok: redis.healthy },
        database: { ok: database.healthy },
        odds: { ok: odds.healthy },
        games: { ok: games.healthy },
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
