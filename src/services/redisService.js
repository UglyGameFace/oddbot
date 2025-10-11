// src/services/redisService.js - CORRECTED FOR IOREDIS & PRESERVING ORIGINAL STRUCTURE
import IORedis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

class RedisService {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.connectionEstablished = false;
    if (env.REDIS_URL) {
      this.connect();
    } else {
      console.warn('🟡 Redis URL not found, Redis service is disabled.');
    }
  }

  async connect() {
    // If already connecting, return the existing promise to avoid race conditions.
    if (this.isConnecting) {
      console.log('🔄 Redis connection attempt already in progress...');
      return this.connectionPromise;
    }

    if (this.client && this.client.status === 'ready') {
        return Promise.resolve(this.client);
    }

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve) => {
      console.log('🔄 Attempting to connect to Redis with ioredis...');
      
      const newClient = new IORedis(env.REDIS_URL, {
        connectTimeout: 8000,
        // ioredis has a robust built-in exponential backoff retry strategy
        maxRetriesPerRequest: 5, 
        lazyConnect: true // Explicitly connect
      });

      newClient.on('error', (error) => {
        console.error('❌ Redis Client Error:', error.message);
        if (error.code === 'ECONNREFUSED') {
          sentryService.captureError(error, { component: 'redis_service', operation: 'connection_error' });
        }
        this.connectionEstablished = false; // Mark as disconnected
      });

      newClient.on('connect', () => console.log('🔄 Redis: connecting...'));
      
      newClient.on('ready', () => {
        if (!this.connectionEstablished) {
          console.log('✅ Redis client connected and ready.');
          this.connectionEstablished = true;
          this.client = newClient; // Assign client only when ready
          this.isConnecting = false;
          resolve(this.client);
        }
      });

      newClient.on('reconnecting', () => console.log('🔄 Redis: reconnecting...'));
      
      newClient.on('end', () => {
        console.warn('🟡 Redis connection closed.');
        this.connectionEstablished = false;
        this.client = null; // Important to nullify on disconnection
      });

      newClient.connect().catch(err => {
          console.error('❌ Failed to establish initial Redis connection:', err.message);
          this.isConnecting = false;
          // Let the robust retry strategy handle it from here.
      });
    });

    return this.connectionPromise;
  }

  /**
   * Centralized client retrieval with validation.
   * Ensures the client is connected and ready before use.
   */
  async getClient() {
    if (!this.client || this.client.status !== 'ready') {
      if (env.REDIS_URL) {
        return this.connect(); // This will return the connection promise
      } else {
        return null; // Redis is disabled
      }
    }
    return this.client;
  }

  async testConnection() {
    try {
      const client = await this.getClient();
      if (!client) return { connected: false, latency: -1 };

      const startTime = Date.now();
      const reply = await client.ping();
      const endTime = Date.now();
      
      const isConnected = reply === 'PONG';
      if (isConnected) {
        console.log('✅ Redis connection test PASSED.');
      } else {
        console.error('❌ Redis connection test FAILED.');
      }
      return { connected: isConnected, latency: endTime - startTime };
    } catch (error) {
      console.error('❌ Redis PING command failed:', error.message);
      return { connected: false, latency: -1, error: error.message };
    }
  }

  /**
   * Gracefully disconnect from Redis
   */
  async disconnect() {
    if (this.client) {
      try {
        await this.client.quit();
        console.log('✅ Redis client disconnected gracefully.');
      } catch (error) {
        console.error('❌ Error during Redis disconnection:', error.message);
      } finally {
        this.client = null;
        this.connectionEstablished = false;
      }
    }
  }
  
  /**
    * Get Redis memory usage and other stats.
    */
  async getStats() {
    try {
      const client = await this.getClient();
      if (!client) {
          return {
              status: 'disabled',
              error: 'Redis URL not configured'
          };
      }

      const info = await client.info();
      const parsedInfo = {};
      info.split('\r\n').forEach(line => {
          if (line && !line.startsWith('#')) {
              const [key, value] = line.split(':');
              if (key && value) {
                parsedInfo[key] = value;
              }
          }
      });
      
      return {
        status: this.connectionEstablished ? 'connected' : 'disconnected',
        uptime_in_seconds: parsedInfo.uptime_in_seconds,
        used_memory_human: parsedInfo.used_memory_human,
        total_keys: (await client.dbsize()),
        connected_clients: parsedInfo.connected_clients,
        redis_version: parsedInfo.redis_version,
        last_updated: new Date().toISOString()
      };
    } catch (error) {
        console.error('❌ Failed to get Redis stats:', error.message);
        return {
            status: 'error',
            error: error.message
        };
    }
  }
}

const redisServiceInstance = new RedisService();
// FIX: Export the instance directly and a getter function for compatibility
export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient();
