// src/services/redisService.js - COMPLETE REWRITE
import { createClient } from 'redis';
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
    // FIX: If already connecting, return the existing promise to avoid race conditions.
    if (this.isConnecting) {
      console.log('🔄 Redis connection attempt already in progress...');
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = new Promise(async (resolve, reject) => {
      console.log('🔄 Attempting to connect to Redis...');
      
      this.client = createClient({
        url: env.REDIS_URL,
        socket: {
          connectTimeout: 8000,
          reconnectStrategy: (retries) => {
            // FIX: Implement exponential backoff for reconnection to avoid spamming.
            if (retries > 10) {
              console.error('❌ Redis: Max connection retries reached. Giving up.');
              return new Error('Max retries reached');
            }
            // Wait 250ms, 500ms, 1s, 2s, 4s, etc.
            const delay = Math.min(retries * 250, 5000); 
            console.log(`🔌 Redis: Reconnecting in ${delay}ms (attempt ${retries + 1})`);
            return delay;
          }
        }
      });

      this.client.on('error', (error) => {
        console.error('❌ Redis Client Error:', error.message);
        // FIX: Capture critical Redis errors (e.g., auth failure) in Sentry
        // but avoid capturing routine connection errors which are handled by reconnectStrategy.
        if (error.code === 'ECONNREFUSED' || error.message.includes('AUTH')) {
          sentryService.captureError(error, { component: 'redis_service', operation: 'connection_error' });
        }
        this.connectionEstablished = false; // Mark as disconnected
      });

      this.client.on('connect', () => console.log('🔄 Redis: connecting...'));
      this.client.on('ready', () => {
        if (!this.connectionEstablished) {
          console.log('✅ Redis client connected and ready.');
          this.connectionEstablished = true;
          this.isConnecting = false;
          resolve(this.client);
        }
      });
      this.client.on('reconnecting', () => console.log('🔄 Redis: reconnecting...'));
      this.client.on('end', () => {
        console.warn('🟡 Redis connection closed.');
        this.connectionEstablished = false;
      });

      try {
        await this.client.connect();
      } catch (error) {
        console.error('❌ Failed to establish initial Redis connection:', error.message);
        this.isConnecting = false;
        this.connectionEstablished = false;
        // Do not resolve or reject, let the reconnectStrategy handle it.
      }
    });

    return this.connectionPromise;
  }

  /**
   * FIX: Centralized client retrieval with validation.
   * Ensures the client is connected and ready before use.
   */
  async getClient() {
    if (!this.client || !this.client.isOpen) {
      if (env.REDIS_URL) {
        await this.connect();
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
    if (this.client && this.client.isOpen) {
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
              const parts = line.split(':');
              parsedInfo[parts[0]] = parts[1];
          }
      });
      
      return {
        status: this.connectionEstablished ? 'connected' : 'disconnected',
        uptime_in_seconds: parsedInfo.uptime_in_seconds,
        used_memory_human: parsedInfo.used_memory_human,
        total_keys: (await client.dbSize()),
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

export default new RedisService();
