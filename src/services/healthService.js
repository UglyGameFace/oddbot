// src/services/healthService.js

import redisClient from './redisService.js';
import databaseService from './databaseService.js';
import { sentryService } from './sentryService.js';

class HealthService {
  
  /**
   * Checks the health of the Redis connection by sending a PING command.
   * @returns {Promise<Object>} An object with the status and latency.
   */
  async _checkRedis() {
    try {
      const redis = await redisClient;
      const startTime = Date.now();
      const reply = await redis.ping();
      const endTime = Date.now();

      if (reply === 'PONG') {
        return { ok: true, status: 'Connected', latency: `${endTime - startTime}ms` };
      }
      return { ok: false, status: 'Unresponsive' };
    } catch (error) {
      sentryService.captureError(error, { component: 'health_service', check: 'redis' });
      return { ok: false, status: 'Disconnected', error: error.message };
    }
  }

  /**
   * Checks the health of the Supabase connection by running a simple query.
   * @returns {Promise<Object>} An object with the status.
   */
  async _checkDatabase() {
    try {
      // We use a lightweight RPC call that we know exists.
      // If it returns without error, the database is healthy.
      const data = await databaseService.getDistinctSports();
      if (data) { // Will be an array, even if empty
        return { ok: true, status: 'Connected' };
      }
      // This case should ideally not be hit if the RPC call is set up
      return { ok: false, status: 'Query Failed' };
    } catch (error) {
      sentryService.captureError(error, { component: 'health_service', check: 'database' });
      return { ok: false, status: 'Disconnected', error: error.message };
    }
  }

  /**
   * Gathers health information from all critical services.
   * @returns {Promise<Object>} A comprehensive health report.
   */
  async getHealth() {
    const [redisHealth, databaseHealth] = await Promise.all([
      this._checkRedis(),
      this._checkDatabase()
    ]);

    return {
      ok: redisHealth.ok && databaseHealth.ok,
      redis: redisHealth,
      database: databaseHealth,
    };
  }
}

const healthServiceInstance = new HealthService();
export default healthServiceInstance;
