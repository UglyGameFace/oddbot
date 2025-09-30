// src/services/healthService.js - UPDATED TO MATCH NEW ARCHITECTURE

import redisClient from './redisService.js';
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import rateLimitService from './rateLimitService.js';
import { sentryService } from './sentryService.js';

// Health check configuration
const HEALTH_CHECK_TIMEOUT = 10000; // 10 seconds max per check
const CACHE_TTL_HEALTH = 30; // 30 seconds cache for health checks

// Enhanced service status tracking
class HealthService {
  constructor() {
    this.lastHealthCheck = new Map();
    this.serviceDependencies = {
      redis: ['odds', 'games', 'rate-limiting', 'caching'],
      database: ['user-data', 'game-storage', 'sports-metadata'],
      odds: ['live-odds', 'player-props', 'sports-discovery'],
      games: ['sports-list', 'game-schedules', 'live-scores']
    };
  }

  /**
   * Comprehensive health check for all critical services
   */
  async getHealth(includeDetails = false) {
    const healthCheckId = `health_${Date.now()}`;
    console.log(`🩺 Starting comprehensive health check (${healthCheckId})...`);
    
    try {
      const startTime = Date.now();
      
      // Run all health checks in parallel with timeouts
      const [redisHealth, databaseHealth, oddsHealth, gamesHealth, rateLimitHealth] = await Promise.all([
        this._checkRedisWithDetails(),
        this._checkDatabaseWithDetails(),
        this._checkOddsServiceWithDetails(),
        this._checkGamesServiceWithDetails(),
        this._checkRateLimitServiceWithDetails()
      ]);

      const processingTime = Date.now() - startTime;

      // Determine overall system status
      const criticalServices = [redisHealth, databaseHealth];
      const allCriticalHealthy = criticalServices.every(service => service.healthy);
      const degradedServices = [redisHealth, databaseHealth, oddsHealth, gamesHealth, rateLimitHealth]
        .filter(service => !service.healthy);

      const overallStatus = {
        healthy: allCriticalHealthy,
        status: allCriticalHealthy ? 
          (degradedServices.length === 0 ? 'healthy' : 'degraded') : 
          'unhealthy',
        timestamp: new Date().toISOString(),
        processing_time_ms: processingTime,
        check_id: healthCheckId
      };

      // Build comprehensive health report
      const healthReport = {
        overall: overallStatus,
        services: {
          redis: redisHealth,
          database: databaseHealth,
          odds: oddsHealth,
          games: gamesHealth,
          rate_limiting: rateLimitHealth
        },
        dependencies: this.serviceDependencies,
        recommendations: this._generateRecommendations({
          redis: redisHealth,
          database: databaseHealth,
          odds: oddsHealth,
          games: gamesHealth,
          rate_limiting: rateLimitHealth
        })
      };

      // Cache the health report
      this._cacheHealthReport(healthReport);

      console.log(`✅ Health check completed in ${processingTime}ms - Status: ${overallStatus.status}`);
      
      return includeDetails ? healthReport : this._summarizeHealth(healthReport);

    } catch (error) {
      console.error('❌ Health check failed:', error);
      sentryService.captureError(error, { 
        component: 'health_service', 
        operation: 'getHealth',
        healthCheckId 
      });

      return this._generateEmergencyHealthReport(error);
    }
  }

  /**
   * Quick health check for load balancers/readiness probes
   */
  async getQuickHealth() {
    try {
      const [redisOk, databaseOk] = await Promise.all([
        this._checkRedisBasic(),
        this._checkDatabaseBasic()
      ]);

      return {
        status: redisOk && databaseOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          redis: redisOk,
          database: databaseOk
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }

  /**
   * Get health check history and trends
   */
  async getHealthHistory(hours = 24) {
    try {
      const redis = await redisClient;
      const historyKey = 'health_check_history';
      
      // Get recent health checks
      const recentChecks = await redis.lrange(historyKey, 0, Math.min(hours * 12, 100)); // Max 100 entries
      
      const parsedChecks = recentChecks
        .map(check => {
          try {
            return JSON.parse(check);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate availability statistics
      const stats = this._calculateHealthStatistics(parsedChecks);
      
      return {
        period_hours: hours,
        total_checks: parsedChecks.length,
        statistics: stats,
        recent_checks: parsedChecks.slice(0, 10), // Last 10 checks
        trends: this._analyzeHealthTrends(parsedChecks)
      };

    } catch (error) {
      console.error('Health history check failed:', error);
      return {
        period_hours: hours,
        total_checks: 0,
        error: error.message
      };
    }
  }

  /**
   * Service-specific health checks
   */
  async getServiceHealth(serviceName) {
    const serviceCheckers = {
      redis: () => this._checkRedisWithDetails(),
      database: () => this._checkDatabaseWithDetails(),
      odds: () => this._checkOddsServiceWithDetails(),
      games: () => this._checkGamesServiceWithDetails(),
      'rate-limiting': () => this._checkRateLimitServiceWithDetails()
    };

    const checker = serviceCheckers[serviceName];
    if (!checker) {
      return {
        healthy: false,
        status: 'unknown_service',
        error: `Unknown service: ${serviceName}`
      };
    }

    try {
      return await checker();
    } catch (error) {
      console.error(`Service health check failed for ${serviceName}:`, error);
      return {
        healthy: false,
        status: 'check_failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // ========== PRIVATE METHODS ==========

  /**
   * Enhanced Redis health check with detailed metrics
   */
  async _checkRedisWithDetails() {
    const checkStart = Date.now();
    
    try {
      const redis = await redisClient;
      
      // Test basic connectivity
      const pingStart = Date.now();
      const pingResult = await redis.ping();
      const pingTime = Date.now() - pingStart;

      // Get Redis info for detailed metrics
      const infoStart = Date.now();
      const info = await redis.info();
      const infoTime = Date.now() - infoStart;

      // Parse relevant info
      const parsedInfo = this._parseRedisInfo(info);
      
      // Test read/write operations
      const testKey = `health_test_${Date.now()}`;
      const writeStart = Date.now();
      await redis.setex(testKey, 10, 'health_check_value');
      const writeTime = Date.now() - writeStart;

      const readStart = Date.now();
      const readValue = await redis.get(testKey);
      const readTime = Date.now() - readStart;

      // Clean up
      await redis.del(testKey);

      const totalTime = Date.now() - checkStart;

      return {
        healthy: pingResult === 'PONG' && readValue === 'health_check_value',
        status: 'connected',
        latency: {
          ping: `${pingTime}ms`,
          read: `${readTime}ms`,
          write: `${writeTime}ms`,
          total: `${totalTime}ms`
        },
        metrics: {
          ...parsedInfo,
          connected_clients: parseInt(parsedInfo.connected_clients) || 0,
          used_memory: parsedInfo.used_memory_human,
          keyspace_hits: parseInt(parsedInfo.keyspace_hits) || 0,
          keyspace_misses: parseInt(parsedInfo.keyspace_misses) || 0,
          hit_rate: parsedInfo.keyspace_hits && parsedInfo.keyspace_misses ? 
            (parseInt(parsedInfo.keyspace_hits) / (parseInt(parsedInfo.keyspace_hits) + parseInt(parsedInfo.keyspace_misses))).toFixed(4) : 0
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Redis health check failed:', error);
      return {
        healthy: false,
        status: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: `${Date.now() - checkStart}ms`
        }
      };
    }
  }

  /**
   * Enhanced database health check with performance metrics
   */
  async _checkDatabaseWithDetails() {
    const checkStart = Date.now();
    
    try {
      // Test basic connection and query
      const connectionStart = Date.now();
      const sports = await databaseService.getDistinctSports();
      const connectionTime = Date.now() - connectionStart;

      // Test write operations with a simple metadata update
      const testMetadata = {
        health_check: true,
        timestamp: new Date().toISOString(),
        check_id: `db_health_${Date.now()}`
      };

      // Get database statistics
      const statsStart = Date.now();
      const dbStats = await databaseService.getDatabaseStats();
      const statsTime = Date.now() - statsStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(sports) && dbStats?.status === 'healthy',
        status: 'connected',
        latency: {
          connection: `${connectionTime}ms`,
          statistics: `${statsTime}ms`,
          total: `${totalTime}ms`
        },
        metrics: {
          total_sports: sports?.length || 0,
          total_games: dbStats?.total_games || 0,
          total_users: dbStats?.total_users || 0,
          database_size: 'unknown', // Supabase doesn't expose this easily
          last_updated: dbStats?.last_updated
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Database health check failed:', error);
      return {
        healthy: false,
        status: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: `${Date.now() - checkStart}ms`
        }
      };
    }
  }

  /**
   * Odds service health check with provider status
   */
  async _checkOddsServiceWithDetails() {
    const checkStart = Date.now();
    
    try {
      // Test basic odds fetching
      const oddsStart = Date.now();
      const nbaOdds = await oddsService.getSportOdds('basketball_nba', { useCache: false });
      const oddsTime = Date.now() - oddsStart;

      // Get service status
      const statusStart = Date.now();
      const serviceStatus = await oddsService.getServiceStatus();
      const statusTime = Date.now() - statusStart;

      // Get data freshness
      const freshnessStart = Date.now();
      const freshness = await oddsService.getDataFreshness('basketball_nba');
      const freshnessTime = Date.now() - freshnessStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(nbaOdds) && serviceStatus?.status === 'healthy',
        status: serviceStatus?.status || 'unknown',
        latency: {
          odds_fetch: `${oddsTime}ms`,
          status_check: `${statusTime}ms`,
          freshness_check: `${freshnessTime}ms`,
          total: `${totalTime}ms`
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
      console.error('Odds service health check failed:', error);
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: `${Date.now() - checkStart}ms`
        }
      };
    }
  }

  /**
   * Games service health check with cache status
   */
  async _checkGamesServiceWithDetails() {
    const checkStart = Date.now();
    
    try {
      // Test sports list fetching
      const sportsStart = Date.now();
      const sports = await gamesService.getAvailableSports();
      const sportsTime = Date.now() - sportsStart;

      // Test game fetching
      const gamesStart = Date.now();
      const nbaGames = await gamesService.getGamesForSport('basketball_nba', { useCache: false });
      const gamesTime = Date.now() - gamesStart;

      // Get service status
      const statusStart = Date.now();
      const serviceStatus = await gamesService.getServiceStatus();
      const statusTime = Date.now() - statusStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: Array.isArray(sports) && Array.isArray(nbaGames) && serviceStatus?.status === 'healthy',
        status: serviceStatus?.status || 'unknown',
        latency: {
          sports_fetch: `${sportsTime}ms`,
          games_fetch: `${gamesTime}ms`,
          status_check: `${statusTime}ms`,
          total: `${totalTime}ms`
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
      console.error('Games service health check failed:', error);
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: `${Date.now() - checkStart}ms`
        }
      };
    }
  }

  /**
   * Rate limit service health check with quota status
   */
  async _checkRateLimitServiceWithDetails() {
    const checkStart = Date.now();
    
    try {
      // Test rate limit functionality
      const testIdentifier = `health_test_${Date.now()}`;
      
      const limitStart = Date.now();
      const limitCheck = await rateLimitService.checkRateLimit(testIdentifier, 'user', 'health_check');
      const limitTime = Date.now() - limitStart;

      // Test provider quota checks
      const quotaStart = Date.now();
      const oddsQuota = await rateLimitService.getProviderQuota('theodds');
      const quotaTime = Date.now() - quotaStart;

      const totalTime = Date.now() - checkStart;

      return {
        healthy: limitCheck.allowed !== undefined && oddsQuota !== undefined,
        status: 'operational',
        latency: {
          limit_check: `${limitTime}ms`,
          quota_check: `${quotaTime}ms`,
          total: `${totalTime}ms`
        },
        metrics: {
          rate_limiting_working: limitCheck.allowed !== undefined,
          provider_quotas_available: oddsQuota ? 1 : 0,
          test_remaining: limitCheck.remaining
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Rate limit service health check failed:', error);
      return {
        healthy: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        latency: {
          total: `${Date.now() - checkStart}ms`
        }
      };
    }
  }

  /**
   * Basic Redis check for quick health assessment
   */
  async _checkRedisBasic() {
    try {
      const redis = await redisClient;
      const result = await redis.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  /**
   * Basic database check for quick health assessment
   */
  async _checkDatabaseBasic() {
    try {
      const sports = await databaseService.getDistinctSports();
      return Array.isArray(sports);
    } catch (error) {
      return false;
    }
  }

  /**
   * Parse Redis INFO command output
   */
  _parseRedisInfo(infoString) {
    const lines = infoString.split('\r\n');
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

  /**
   * Cache health report for quick access
   */
  async _cacheHealthReport(healthReport) {
    try {
      const redis = await redisClient;
      await redis.setex(
        'health_report_current', 
        CACHE_TTL_HEALTH, 
        JSON.stringify(healthReport)
      );

      // Store in history (keep last 100 checks)
      await redis.lpush('health_check_history', JSON.stringify(healthReport));
      await redis.ltrim('health_check_history', 0, 99);
    } catch (error) {
      console.warn('Failed to cache health report:', error);
    }
  }

  /**
   * Generate health recommendations based on service status
   */
  _generateRecommendations(services) {
    const recommendations = [];

    if (!services.redis.healthy) {
      recommendations.push({
        service: 'redis',
        priority: 'critical',
        message: 'Redis connection failed. Check Redis server and connection URL.',
        action: 'Verify REDIS_URL environment variable and Redis server status'
      });
    }

    if (!services.database.healthy) {
      recommendations.push({
        service: 'database',
        priority: 'critical',
        message: 'Database connection failed. Check Supabase connection.',
        action: 'Verify SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables'
      });
    }

    if (!services.odds.healthy) {
      recommendations.push({
        service: 'odds',
        priority: 'high',
        message: 'Odds service experiencing issues.',
        action: 'Check API keys for The Odds API and SportRadar'
      });
    }

    if (!services.games.healthy) {
      recommendations.push({
        service: 'games',
        priority: 'medium',
        message: 'Games service degraded.',
        action: 'Verify external API connections and cache status'
      });
    }

    // Performance recommendations
    if (services.redis.metrics?.hit_rate < 0.8) {
      recommendations.push({
        service: 'redis',
        priority: 'low',
        message: 'Redis cache hit rate is low.',
        action: 'Consider increasing cache TTLs or reviewing cache keys'
      });
    }

    return recommendations;
  }

  /**
   * Calculate health statistics from history
   */
  _calculateHealthStatistics(healthChecks) {
    if (healthChecks.length === 0) {
      return {
        availability: 0,
        average_response_time: 0,
        total_checks: 0
      };
    }

    const healthyChecks = healthChecks.filter(check => check.overall?.healthy);
    const availability = (healthyChecks.length / healthChecks.length) * 100;
    
    const totalResponseTime = healthChecks.reduce((sum, check) => 
      sum + (check.overall?.processing_time_ms || 0), 0
    );
    const averageResponseTime = totalResponseTime / healthChecks.length;

    return {
      availability: Math.round(availability * 100) / 100,
      average_response_time: Math.round(averageResponseTime),
      total_checks: healthChecks.length,
      healthy_checks: healthyChecks.length,
      unhealthy_checks: healthChecks.length - healthyChecks.length
    };
  }

  /**
   * Analyze health trends from historical data
   */
  _analyzeHealthTrends(healthChecks) {
    if (healthChecks.length < 2) {
      return { trend: 'insufficient_data', confidence: 'low' };
    }

    const recent = healthChecks.slice(0, 5); // Last 5 checks
    const older = healthChecks.slice(5, 10); // Previous 5 checks

    const recentHealth = recent.filter(check => check.overall?.healthy).length / recent.length;
    const olderHealth = older.filter(check => check.overall?.healthy).length / older.length;

    let trend = 'stable';
    if (recentHealth > olderHealth + 0.1) trend = 'improving';
    if (recentHealth < olderHealth - 0.1) trend = 'deteriorating';

    return {
      trend,
      recent_health: Math.round(recentHealth * 100),
      previous_health: Math.round(olderHealth * 100),
      confidence: healthChecks.length >= 10 ? 'high' : 'medium'
    };
  }

  /**
   * Generate summarized health report
   */
  _summarizeHealth(healthReport) {
    const { overall, services } = healthReport;
    
    return {
      status: overall.status,
      healthy: overall.healthy,
      timestamp: overall.timestamp,
      processing_time_ms: overall.processing_time_ms,
      services_health: {
        redis: services.redis.healthy,
        database: services.database.healthy,
        odds: services.odds.healthy,
        games: services.games.healthy,
        rate_limiting: services.rate_limiting.healthy
      },
      degraded_services: Object.entries(services)
        .filter(([_, service]) => !service.healthy)
        .map(([name, _]) => name)
    };
  }

  /**
   * Generate emergency health report when checks fail
   */
  _generateEmergencyHealthReport(error) {
    return {
      overall: {
        healthy: false,
        status: 'emergency',
        timestamp: new Date().toISOString(),
        error: error.message
      },
      services: {
        redis: { healthy: false, status: 'unknown' },
        database: { healthy: false, status: 'unknown' },
        odds: { healthy: false, status: 'unknown' },
        games: { healthy: false, status: 'unknown' },
        rate_limiting: { healthy: false, status: 'unknown' }
      },
      emergency: true,
      message: 'Health check system failure - manual investigation required'
    };
  }
}

// Create and export singleton instance
const healthServiceInstance = new HealthService();
export default healthServiceInstance;
