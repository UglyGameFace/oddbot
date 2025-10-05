// src/services/healthService.js - FIXED STRUCTURE
import redisClient from './redisService.js';
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import { rateLimitService } from './rateLimitService.js';
import { sentryService } from './sentryService.js';
import { withTimeout } from '../utils/asyncUtils.js';

// Health check configuration
const HEALTH_CHECK_TIMEOUT = 10000;
const CACHE_TTL_HEALTH = 30;

// Service health checkers
class ServiceHealthChecker {
  static async checkRedis() {
    const checkStart = Date.now();
    
    try {
      const redis = await redisClient;
      
      // Test basic connectivity
      const pingStart = Date.now();
      const pingResult = await redis.ping();
      const pingTime = Date.now() - pingStart;

      // Get Redis info
      const infoStart = Date.now();
      const info = await redis.info();
      const infoTime = Date.now() - infoStart;

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

      // Parse Redis info
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
      // Test basic connection and query
      const connectionStart = Date.now();
      const sports = await databaseService.getDistinctSports();
      const connectionTime = Date.now() - connectionStart;

      // Get database statistics
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
      // Test basic odds fetching
      const oddsStart = Date.now();
      const nbaOdds = await oddsService.getSportOdds('basketball_nba', { useCache: false });
      const oddsTime = Date.now() - oddsStart;

      // Get service status - FIXED: Handle missing method
      let serviceStatus = { status: 'unknown' };
      try {
        if (typeof oddsService.getServiceStatus === 'function') {
          serviceStatus = await oddsService.getServiceStatus();
        }
      } catch (e) {
        console.warn('Odds service status check not available');
      }

      const statusTime = Date.now() - oddsStart;

      // Get data freshness - FIXED: Handle missing method
      let freshness = { overall: { status: 'unknown' }, providers: {} };
      try {
        if (typeof oddsService.getDataFreshness === 'function') {
          freshness = await oddsService.getDataFreshness('basketball_nba');
        }
      } catch (e) {
        console.warn('Odds data freshness check not available');
      }

      const freshnessTime = Date.now() - oddsStart;

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
      // Test sports list fetching
      const sportsStart = Date.now();
      const sports = await gamesService.getAvailableSports();
      const sportsTime = Date.now() - sportsStart;

      // Test game fetching
      const gamesStart = Date.now();
      const nbaGames = await gamesService.getGamesForSport('basketball_nba', { useCache: false });
      const gamesTime = Date.now() - gamesStart;

      // Get service status - FIXED: Handle missing method
      let serviceStatus = { status: 'unknown', cache: { enabled: true }, sources: {} };
      try {
        if (typeof gamesService.getServiceStatus === 'function') {
          serviceStatus = await gamesService.getServiceStatus();
        }
      } catch (e) {
        console.warn('Games service status check not available');
      }

      const statusTime = Date.now() - gamesStart;

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
      // Test rate limit functionality
      const testIdentifier = `health_test_${Date.now()}`;
      
      const limitStart = Date.now();
      const limitCheck = await rateLimitService.checkRateLimit(testIdentifier, 'user', 'health_check');
      const limitTime = Date.now() - limitStart;

      // Test provider quota checks - FIXED: Handle missing method
      let oddsQuota = null;
      let quotaTime = 0;
      try {
        if (typeof rateLimitService.getProviderQuota === 'function') {
          const quotaStart = Date.now();
          oddsQuota = await rateLimitService.getProviderQuota('theodds');
          quotaTime = Date.now() - quotaStart;
        }
      } catch (e) {
        console.warn('Provider quota check not available');
      }

      // Test provider health - FIXED: Handle missing method
      let providerHealth = { overall: 'unknown' };
      let healthTime = 0;
      try {
        if (typeof rateLimitService.getAllProvidersHealth === 'function') {
          const healthStart = Date.now();
          providerHealth = await rateLimitService.getAllProvidersHealth();
          healthTime = Date.now() - healthStart;
        }
      } catch (e) {
        console.warn('Provider health check not available');
      }

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
}

// Health history manager
class HealthHistoryManager {
  constructor() {
    this.historyKey = 'health_check_history';
    this.maxHistoryEntries = 100;
  }

  async saveHealthReport(healthReport) {
    try {
      const redis = await redisClient;
      const reportWithId = {
        ...healthReport,
        id: `health_${Date.now()}`,
        saved_at: new Date().toISOString()
      };

      // Store in history (keep last N entries)
      await redis.lpush(this.historyKey, JSON.stringify(reportWithId));
      await redis.ltrim(this.historyKey, 0, this.maxHistoryEntries - 1);

      // Cache current report
      await redis.setex('health_report_current', CACHE_TTL_HEALTH, JSON.stringify(healthReport));

      return true;
    } catch (error) {
      console.warn('Failed to save health report:', error);
      return false;
    }
  }

  async getHealthHistory(hours = 24) {
    try {
      const redis = await redisClient;
      const recentChecks = await redis.lrange(this.historyKey, 0, Math.min(hours * 12, this.maxHistoryEntries));
      
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

      return this.analyzeHealthHistory(parsedChecks, hours);

    } catch (error) {
      console.error('Health history retrieval failed:', error);
      return {
        period_hours: hours,
        total_checks: 0,
        error: error.message
      };
    }
  }

  analyzeHealthHistory(healthChecks, hours) {
    if (healthChecks.length === 0) {
      return {
        period_hours: hours,
        total_checks: 0,
        statistics: { availability: 0, average_response_time: 0 },
        trends: { trend: 'insufficient_data', confidence: 'low' }
      };
    }

    // Calculate availability statistics
    const healthyChecks = healthChecks.filter(check => check.overall?.healthy);
    const availability = (healthyChecks.length / healthChecks.length) * 100;
    
    const totalResponseTime = healthChecks.reduce((sum, check) => 
      sum + (check.overall?.processing_time_ms || 0), 0
    );
    const averageResponseTime = totalResponseTime / healthChecks.length;

    // Analyze trends
    const trends = this.calculateHealthTrends(healthChecks);

    // Service-specific statistics
    const serviceStats = this.calculateServiceStatistics(healthChecks);

    return {
      period_hours: hours,
      total_checks: healthChecks.length,
      healthy_checks: healthyChecks.length,
      unhealthy_checks: healthChecks.length - healthyChecks.length,
      statistics: {
        availability: Math.round(availability * 100) / 100,
        average_response_time: Math.round(averageResponseTime),
        p95_response_time: this.calculatePercentile(healthChecks.map(c => c.overall?.processing_time_ms || 0), 95),
        p99_response_time: this.calculatePercentile(healthChecks.map(c => c.overall?.processing_time_ms || 0), 99)
      },
      trends,
      service_statistics: serviceStats,
      recent_checks: healthChecks.slice(0, 10)
    };
  }

  calculateHealthTrends(healthChecks) {
    if (healthChecks.length < 2) {
      return { trend: 'insufficient_data', confidence: 'low' };
    }

    const recent = healthChecks.slice(0, 5);
    const older = healthChecks.slice(5, 10);

    const recentHealth = recent.filter(check => check.overall?.healthy).length / recent.length;
    const olderHealth = older.filter(check => check.overall?.healthy).length / older.length;

    let trend = 'stable';
    if (recentHealth > olderHealth + 0.1) trend = 'improving';
    if (recentHealth < olderHealth - 0.1) trend = 'deteriorating';

    return {
      trend,
      recent_health: Math.round(recentHealth * 100),
      previous_health: Math.round(olderHealth * 100),
      confidence: healthChecks.length >= 10 ? 'high' : 'medium',
      change_percentage: Math.round((recentHealth - olderHealth) * 100)
    };
  }

  calculateServiceStatistics(healthChecks) {
    const services = ['redis', 'database', 'odds', 'games', 'rate_limiting'];
    const stats = {};

    services.forEach(service => {
      const serviceChecks = healthChecks.map(check => check.services?.[service]);
      const healthyCount = serviceChecks.filter(s => s?.healthy).length;
      
      stats[service] = {
        availability: Math.round((healthyCount / serviceChecks.length) * 100),
        average_latency: Math.round(serviceChecks.reduce((sum, s) => sum + (s?.latency?.total || 0), 0) / serviceChecks.length),
        total_checks: serviceChecks.length
      };
    });

    return stats;
  }

  calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    const sorted = values.sort((a, b) => a - b);
    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }
}

// Health recommendations generator
class HealthRecommendationsGenerator {
  static generate(services) {
    const recommendations = [];

    // Redis recommendations
    if (!services.redis.healthy) {
      recommendations.push({
        service: 'redis',
        priority: 'critical',
        message: 'Redis connection failed',
        action: 'Verify REDIS_URL environment variable and Redis server status',
        impact: 'Caching and rate limiting will be disabled'
      });
    } else if (services.redis.metrics?.hit_rate < 0.8) {
      recommendations.push({
        service: 'redis',
        priority: 'low',
        message: 'Redis cache hit rate is low',
        action: 'Consider increasing cache TTLs or reviewing cache keys',
        impact: 'Reduced cache effectiveness'
      });
    }

    // Database recommendations
    if (!services.database.healthy) {
      recommendations.push({
        service: 'database',
        priority: 'critical',
        message: 'Database connection failed',
        action: 'Verify SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables',
        impact: 'User data and game storage will be unavailable'
      });
    } else if (services.database.metrics?.total_games === 0) {
      recommendations.push({
        service: 'database',
        priority: 'medium',
        message: 'No games found in database',
        action: 'Check game ingestion processes and API connections',
        impact: 'Limited game data availability'
      });
    }

    // Odds service recommendations
    if (!services.odds.healthy) {
      recommendations.push({
        service: 'odds',
        priority: 'high',
        message: 'Odds service experiencing issues',
        action: 'Check API keys for The Odds API and SportRadar',
        impact: 'Live odds and player props may be unavailable'
      });
    } else if (services.odds.metrics?.providers_healthy === 0) {
      recommendations.push({
        service: 'odds',
        priority: 'high',
        message: 'All odds providers are unhealthy',
        action: 'Verify API keys and provider status',
        impact: 'No odds data available'
      });
    }

    // Games service recommendations
    if (!services.games.healthy) {
      recommendations.push({
        service: 'games',
        priority: 'medium',
        message: 'Games service degraded',
        action: 'Verify external API connections and cache status',
        impact: 'Game schedules and sports lists may be incomplete'
      });
    }

    // Performance recommendations
    const slowServices = Object.entries(services).filter(([_, service]) => 
      service.latency?.total > 5000
    );
    
    if (slowServices.length > 0) {
      recommendations.push({
        service: 'performance',
        priority: 'medium',
        message: `${slowServices.length} services are responding slowly`,
        action: 'Investigate service performance and consider scaling',
        impact: 'Reduced user experience and potential timeouts'
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { critical: 3, high: 2, medium: 1, low: 0 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }
}

// Main Health Service Class
class EnhancedHealthService {
  constructor() {
    this.historyManager = new HealthHistoryManager();
    this.serviceDependencies = {
      redis: ['odds', 'games', 'rate-limiting', 'caching'],
      database: ['user-data', 'game-storage', 'sports-metadata'],
      odds: ['live-odds', 'player-props', 'sports-discovery'],
      games: ['sports-list', 'game-schedules', 'live-scores']
    };
  }

  async getHealth(includeDetails = false) {
    const healthCheckId = `health_${Date.now()}`;
    console.log(`🩺 Starting comprehensive health check (${healthCheckId})...`);
    
    try {
      const startTime = Date.now();
      
      // Run all health checks in parallel
      const healthResults = await Promise.all([
        ServiceHealthChecker.checkRedis(),
        ServiceHealthChecker.checkDatabase(),
        ServiceHealthChecker.checkOddsService(),
        ServiceHealthChecker.checkGamesService(),
        ServiceHealthChecker.checkRateLimitService()
      ]);

      const processingTime = Date.now() - startTime;

      const [redisHealth, databaseHealth, oddsHealth, gamesHealth, rateLimitHealth] = healthResults;

      // Determine overall system status
      const criticalServices = [redisHealth, databaseHealth];
      const allCriticalHealthy = criticalServices.every(service => service.healthy);
      const degradedServices = healthResults.filter(service => !service.healthy);

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
        recommendations: HealthRecommendationsGenerator.generate({
          redis: redisHealth,
          database: databaseHealth,
          odds: oddsHealth,
          games: gamesHealth,
          rate_limiting: rateLimitHealth
        })
      };

      // Save to history
      await this.historyManager.saveHealthReport(healthReport);

      console.log(`✅ Health check completed in ${processingTime}ms - Status: ${overallStatus.status}`);
      
      // FIXED: Return structure that matches what system.js expects
      const simplifiedReport = {
        ok: overallStatus.healthy,
        status: overallStatus.status,
        timestamp: overallStatus.timestamp,
        processing_time_ms: processingTime,
        services: {
          redis: { ok: redisHealth.healthy, status: redisHealth.status },
          database: { ok: databaseHealth.healthy, status: databaseHealth.status },
          odds: { ok: oddsHealth.healthy, status: oddsHealth.status },
          games: { ok: gamesHealth.healthy, status: gamesHealth.status },
          rate_limiting: { ok: rateLimitHealth.healthy, status: rateLimitHealth.status }
        },
        recommendations: healthReport.recommendations
      };

      return includeDetails ? healthReport : simplifiedReport;

    } catch (error) {
      console.error('❌ Health check failed:', error);
      sentryService.captureError(error, { 
        component: 'health_service', 
        operation: 'getHealth',
        healthCheckId 
      });

      return this.generateEmergencyHealthReport(error);
    }
  }

  async getQuickHealth() {
    try {
      const [redisOk, databaseOk] = await Promise.all([
        this.checkRedisBasic(),
        this.checkDatabaseBasic()
      ]);

      return {
        ok: redisOk && databaseOk,
        status: redisOk && databaseOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          redis: { ok: redisOk },
          database: { ok: databaseOk }
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }

  async getServiceHealth(serviceName) {
    const serviceCheckers = {
      redis: () => ServiceHealthChecker.checkRedis(),
      database: () => ServiceHealthChecker.checkDatabase(),
      odds: () => ServiceHealthChecker.checkOddsService(),
      games: () => ServiceHealthChecker.checkGamesService(),
      'rate-limiting': () => ServiceHealthChecker.checkRateLimitService()
    };

    const checker = serviceCheckers[serviceName];
    if (!checker) {
      return {
        ok: false,
        status: 'unknown_service',
        error: `Unknown service: ${serviceName}`
      };
    }

    try {
      const result = await checker();
      return {
        ok: result.healthy,
        status: result.status,
        ...result
      };
    } catch (error) {
      console.error(`Service health check failed for ${serviceName}:`, error);
      return {
        ok: false,
        status: 'check_failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async getHealthHistory(hours = 24) {
    return await this.historyManager.getHealthHistory(hours);
  }

  // ========== PRIVATE METHODS ==========

  async checkRedisBasic() {
    try {
      const redis = await redisClient;
      const result = await redis.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async checkDatabaseBasic() {
    try {
      const sports = await databaseService.getDistinctSports();
      return Array.isArray(sports);
    } catch (error) {
      return false;
    }
  }

  summarizeHealth(healthReport) {
    const { overall, services } = healthReport;
    
    return {
      ok: overall.healthy,
      status: overall.status,
      timestamp: overall.timestamp,
      processing_time_ms: overall.processing_time_ms,
      services: {
        redis: { ok: services.redis.healthy, status: services.redis.status },
        database: { ok: services.database.healthy, status: services.database.status },
        odds: { ok: services.odds.healthy, status: services.odds.status },
        games: { ok: services.games.healthy, status: services.games.status },
        rate_limiting: { ok: services.rate_limiting.healthy, status: services.rate_limiting.status }
      }
    };
  }

  generateEmergencyHealthReport(error) {
    return {
      ok: false,
      status: 'emergency',
      timestamp: new Date().toISOString(),
      error: error.message,
      services: {
        redis: { ok: false, status: 'unknown' },
        database: { ok: false, status: 'unknown' },
        odds: { ok: false, status: 'unknown' },
        games: { ok: false, status: 'unknown' },
        rate_limiting: { ok: false, status: 'unknown' }
      },
      emergency: true,
      message: 'Health check system failure - manual investigation required'
    };
  }
}

// Create and export singleton instance
const healthServiceInstance = new EnhancedHealthService();
export default healthServiceInstance;
