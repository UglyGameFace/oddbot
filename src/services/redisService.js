// src/services/redisService.js - PRODUCTION PROVEN VERSION
import Redis from 'ioredis';
import env from '../config/env.js';

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.MAX_RETRIES = 3;
  }

  async connect() {
    if (this.isConnected && this.client) return this.client;
    if (this.connectionAttempts >= this.MAX_RETRIES) return null;

    try {
      console.log('🔌 Connecting to Redis...');
      
      this.client = new Redis(env.REDIS_URL, {
        // SIMPLIFIED: Let ioredis handle reconnections with sane defaults
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        commandTimeout: 3000,
        lazyConnect: true,
        
        // CRITICAL: Use built-in retry strategy instead of custom complex logic
        retryStrategy(times) {
          if (times > 3) {
            console.log('🔄 Redis retries exhausted');
            return null;
          }
          return Math.min(times * 100, 3000);
        }
      });

      // SIMPLIFIED: Handle only essential events
      this.client.on('connect', () => {
        console.log('🔄 Redis connecting...');
      });

      this.client.on('ready', () => {
        console.log('✅ Redis ready');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
        this.isConnected = false;
        
        // Only log to Sentry for non-connection errors
        if (!err.message.includes('ECONNREFUSED') && 
            !err.message.includes('ETIMEDOUT')) {
          // sentryService.captureError(err, { component: 'redis_service' });
        }
      });

      this.client.on('end', () => {
        console.log('🛑 Redis connection closed');
        this.isConnected = false;
      });

      await this.client.connect();
      this.connectionAttempts = 0;
      return this.client;

    } catch (error) {
      this.connectionAttempts++;
      console.error(`❌ Redis connection failed (attempt ${this.connectionAttempts}):`, error.message);
      
      if (this.connectionAttempts >= this.MAX_RETRIES) {
        console.warn('⚠️ Redis disabled after max retries');
        this.client = null;
      }
      return null;
    }
  }

  async getClient() {
    if (!this.client || !this.isConnected) {
      return await this.connect();
    }
    
    // Quick health check
    try {
      await this.client.ping();
      return this.client;
    } catch (error) {
      console.warn('🔄 Redis health check failed, reconnecting...');
      this.isConnected = false;
      return await this.connect();
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

// SINGLETON PATTERN - One connection per application
export const redisService = new RedisService();
export default redisService;
