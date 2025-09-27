// src/services/healthService.js - ENTERPRISE HEALTH MONITORING (Corrected)
import os from 'os';
import pidusage from 'pidusage';
import sentryService from './sentryService.js';
import DatabaseService from './databaseService.js';
import redis from './redisService.js';

class EnterpriseHealthService {
  // We pass the express app in the constructor
  constructor(app) {
    if (!app) {
      throw new Error("HealthService requires an Express app instance.");
    }
    this.app = app;
    // The setup is now called MANUALLY after all services are ready.
  }

  // This will be called from bot.js
  initializeHealthCheckEndpoints() {
    this.app.get('/health/liveness', (_req, res) => {
      res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
    });

    this.app.get('/health/readiness', async (_req, res) => {
      const checks = await this.runAllChecks();
      const isReady = checks.every(check => check.status === 'healthy');
      
      if (isReady) {
        res.status(200).json({ status: 'ready', checks });
      } else {
        res.status(503).json({ status: 'not_ready', checks });
      }
    });

    this.app.get('/health/metrics', async (_req, res) => {
        try {
            const processStats = await pidusage(process.pid);
            const metrics = {
                timestamp: new Date().toISOString(),
                uptime_seconds: process.uptime(),
                cpu_usage_percent: processStats.cpu,
                memory_usage_bytes: processStats.memory,
            };
            res.status(200).json(metrics);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get process metrics' });
        }
    });
    console.log('✅ Health Check Endpoints Initialized.');
  }

  async runAllChecks() {
    const checkPromises = [
      this.checkDatabase(),
      this.checkRedis(),
    ];
    return Promise.all(checkPromises);
  }

  async checkDatabase() {
    const startTime = Date.now();
    try {
      await DatabaseService.healthCheck();
      return {
        name: 'database',
        status: 'healthy',
        latency_ms: Date.now() - startTime,
      };
    } catch (error) {
      return { name: 'database', status: 'unhealthy', error: error.message };
    }
  }

  async checkRedis() {
    const startTime = Date.now();
    try {
      const pingResponse = await redis.ping();
      if (pingResponse !== 'PONG') throw new Error('Invalid Redis ping response');
      return { name: 'redis', status: 'healthy', latency_ms: Date.now() - startTime };
    } catch (error) {
      return { name: 'redis', status: 'unhealthy', error: error.message };
    }
  }
}

// IMPORTANT: We now export the class itself, not an instance.
export default EnterpriseHealthService;
