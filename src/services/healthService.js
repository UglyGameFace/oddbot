// src/services/healthService.js - ENTERPRISE HEALTH MONITORING WITH SENTRY INTEGRATION
import os from 'os';
import pidusage from 'pidusage';
import sentryService from './sentryService.js';
import DatabaseService from './databaseService.js';
import rateLimitService from './rateLimitService.js';

class EnterpriseHealthService {
  constructor() {
    this.healthChecks = new Map();
    this.metricsHistory = [];
    this.alertThresholds = this.initializeAlertThresholds();
    
    this.setupContinuousMonitoring();
    this.initializeHealthCheckEndpoints();
  }

  initializeAlertThresholds() {
    return {
      memory: 0.85, // 85% memory usage
      cpu: 0.90,    // 90% CPU usage
      eventLoopDelay: 1000, // 1 second
      responseTime: 5000,   // 5 seconds
      errorRate: 0.05,      // 5% error rate
      databaseLatency: 1000 // 1 second
    };
  }

  setupContinuousMonitoring() {
    // System metrics collection
    setInterval(() => {
      this.collectSystemMetrics();
    }, 30000); // Every 30 seconds

    // Health check execution
    setInterval(() => {
      this.executeHealthChecks();
    }, 60000); // Every minute

    // Alert checking
    setInterval(() => {
      this.checkAlertConditions();
    }, 120000); // Every 2 minutes
  }

  async collectSystemMetrics() {
    const metrics = {
      timestamp: new Date().toISOString(),
      system: await this.getSystemMetrics(),
      process: await this.getProcessMetrics(),
      application: await this.getApplicationMetrics(),
      database: await this.getDatabaseMetrics(),
      redis: await this.getRedisMetrics()
    };

    this.metricsHistory.push(metrics);
    
    // Keep only last 100 data points
    if (this.metricsHistory.length > 100) {
      this.metricsHistory = this.metricsHistory.slice(-100);
    }

    // Send critical metrics to Sentry
    this.sendMetricsToSentry(metrics);
  }

  async getSystemMetrics() {
    return {
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        usage: (os.totalmem() - os.freemem()) / os.totalmem()
      },
      cpu: {
        load: os.loadavg(),
        cores: os.cpus().length,
        usage: await this.getCPUUsage()
      },
      uptime: os.uptime(),
      platform: os.platform(),
      arch: os.arch()
    };
  }

  async getProcessMetrics() {
    try {
      const stats = await pidusage(process.pid);
      return {
        memory: stats.memory,
        cpu: stats.cpu,
        pid: process.pid,
        uptime: process.uptime(),
        version: process.version,
        eventLoopDelay: await this.getEventLoopDelay()
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async getApplicationMetrics() {
    return {
      nodeEnv: process.env.NODE_ENV,
      featureFlags: this.getFeatureFlagStatus(),
      activeUsers: await this.getActiveUserCount(),
      requestRate: await this.getRequestRate(),
      errorRate: await this.getErrorRate(),
      responseTimes: await this.getResponseTimeMetrics()
    };
  }

  async getDatabaseMetrics() {
    try {
      const startTime = Date.now();
      // Test database connection and performance
      await DatabaseService.healthCheck();
      const latency = Date.now() - startTime;

      return {
        status: 'healthy',
        latency,
        connectionPool: await this.getConnectionPoolStatus(),
        queryPerformance: await this.getQueryPerformance()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        latency: null
      };
    }
  }

  async getRedisMetrics() {
    try {
      return await rateLimitService.healthCheck();
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async executeHealthChecks() {
    const healthChecks = {
      database: await this.checkDatabaseHealth(),
      redis: await this.checkRedisHealth(),
      external_apis: await this.checkExternalAPIsHealth(),
      storage: await this.checkStorageHealth(),
      network: await this.checkNetworkHealth()
    };

    const overallStatus = this.calculateOverallHealth(healthChecks);
    
    // Record health status
    sentryService.trackBusinessMetric('health.check', 1, {
      status: overallStatus,
      checks: Object.keys(healthChecks).filter(key => healthChecks[key].status === 'healthy').length
    });

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks: healthChecks
    };
  }

  async checkDatabaseHealth() {
    try {
      const startTime = Date.now();
      await DatabaseService.healthCheck();
      const latency = Date.now() - startTime;

      return {
        status: latency < this.alertThresholds.databaseLatency ? 'healthy' : 'degraded',
        latency,
        message: 'Database connection stable'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        message: 'Database connection failed'
      };
    }
  }

  async checkExternalAPIsHealth() {
    const apis = [
      { name: 'Telegram', check: this.checkTelegramAPI },
      { name: 'Google Gemini', check: this.checkGeminiAPI },
      { name: 'Perplexity', check: this.checkPerplexityAPI },
      { name: 'The Odds API', check: this.checkOddsAPI }
    ];

    const results = await Promise.all(
      apis.map(async api => ({
        name: api.name,
        ...await api.check()
      }))
    );

    return {
      status: results.every(r => r.status === 'healthy') ? 'healthy' : 'degraded',
      apis: results
    };
  }

  async checkTelegramAPI() {
    try {
      // Simple Telegram API check
      const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
      return {
        status: response.ok ? 'healthy' : 'degraded',
        latency: response.duration,
        message: response.ok ? 'Telegram API accessible' : 'Telegram API issues'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        message: 'Telegram API unreachable'
      };
    }
  }

  checkAlertConditions() {
    const recentMetrics = this.metricsHistory.slice(-10); // Last 10 data points
    
    recentMetrics.forEach(metrics => {
      this.checkMemoryAlerts(metrics);
      this.checkCPUAlerts(metrics);
      this.checkErrorRateAlerts(metrics);
      this.checkLatencyAlerts(metrics);
    });
  }

  checkMemoryAlerts(metrics) {
    const memoryUsage = metrics.system.memory.usage;
    
    if (memoryUsage > this.alertThresholds.memory) {
      sentryService.captureMessage('High memory usage detected', {
        level: 'warning',
        extra: {
          usage: memoryUsage,
          threshold: this.alertThresholds.memory,
          timestamp: metrics.timestamp
        },
        tags: { type: 'memory_alert', severity: 'high' }
      });
    }
  }

  checkErrorRateAlerts(metrics) {
    const errorRate = metrics.application.errorRate;
    
    if (errorRate > this.alertThresholds.errorRate) {
      sentryService.captureMessage('High error rate detected', {
        level: 'error',
        extra: {
          errorRate,
          threshold: this.alertThresholds.errorRate,
          timestamp: metrics.timestamp
        },
        tags: { type: 'error_rate_alert', severity: 'high' }
      });
    }
  }

  sendMetricsToSentry(metrics) {
    // Send critical metrics as Sentry metrics
    Sentry.metrics.gauge('system.memory.usage', metrics.system.memory.usage);
    Sentry.metrics.gauge('system.cpu.usage', metrics.system.cpu.usage);
    Sentry.metrics.gauge('process.event_loop_delay', metrics.process.eventLoopDelay);
    Sentry.metrics.gauge('database.latency', metrics.database.latency);
    
    // Alert if any metric exceeds thresholds
    if (metrics.system.memory.usage > 0.9) {
      sentryService.captureMessage('Critical memory usage', {
        level: 'error',
        extra: { usage: metrics.system.memory.usage }
      });
    }
  }

  initializeHealthCheckEndpoints() {
    // This would integrate with Express or similar if needed
    this.endpoints = {
      '/health': this.getHealthStatus.bind(this),
      '/health/metrics': this.getDetailedMetrics.bind(this),
      '/health/readiness': this.getReadinessStatus.bind(this),
      '/health/liveness': this.getLivenessStatus.bind(this)
    };
  }

  async getHealthStatus() {
    const [healthChecks, currentMetrics] = await Promise.all([
      this.executeHealthChecks(),
      this.getCurrentMetrics()
    ]);

    return {
      status: healthChecks.status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      checks: healthChecks.checks,
      metrics: currentMetrics
    };
  }

  async getReadinessStatus() {
    const healthChecks = await this.executeHealthChecks();
    
    // Application is ready if critical services are healthy
    const criticalServices = ['database', 'redis'];
    const isReady = criticalServices.every(
      service => healthChecks.checks[service]?.status === 'healthy'
    );

    return {
      ready: isReady,
      timestamp: new Date().toISOString(),
      checks: healthChecks.checks
    };
  }

  async getLivenessStatus() {
    // Basic liveness check - is the process responding?
    return {
      alive: true,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime()
    };
  }

  // UTILITY METHODS
  async getEventLoopDelay() {
    return new Promise((resolve) => {
      const start = process.hrtime();
      setImmediate(() => {
        const delta = process.hrtime(start);
        const nanoseconds = delta[0] * 1e9 + delta[1];
        resolve(nanoseconds / 1e6); // Convert to milliseconds
      });
    });
  }

  calculateOverallHealth(healthChecks) {
    const checkResults = Object.values(healthChecks);
    
    if (checkResults.every(check => check.status === 'healthy')) {
      return 'healthy';
    } else if (checkResults.some(check => check.status === 'unhealthy')) {
      return 'unhealthy';
    } else {
      return 'degraded';
    }
  }
}

// Create singleton instance
const healthService = new EnterpriseHealthService();
export default healthService;