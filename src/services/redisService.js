// src/services/redisService.js - BULLETPROOF VERSION
import IORedis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

class RedisService {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.connectionEstablished = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;

    if (env.REDIS_URL) {
      console.log('🔄 RedisService: Initializing Redis connection...');
      this.connect();
    } else {
      console.warn('🟡 RedisService: REDIS_URL not found, Redis disabled.');
    }
  }

  async connect() {
    if (this.isConnecting) {
      console.log('🔄 RedisService: Connection already in progress, returning existing promise...');
      return this.connectionPromise;
    }

    if (this.client && this.client.status === 'ready') {
      console.log('✅ RedisService: Client already connected and ready.');
      return Promise.resolve(this.client);
    }

    this.isConnecting = true;
    this.connectionAttempts++;

    console.log(`🔄 RedisService: Attempting connection (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})...`);

    this.connectionPromise = new Promise(async (resolve, reject) => {
      try {
        const newClient = new IORedis(env.REDIS_URL, {
          connectTimeout: 10000,
          commandTimeout: 5000,
          maxRetriesPerRequest: 3,
          retryDelayOnFailover: 100,
          lazyConnect: true,
          reconnectOnError: (err) => {
            console.log('🔁 RedisService: Reconnect on error check:', err.message);
            return true;
          }
        });

        newClient.on('error', (error) => {
          console.error('❌ RedisService: Client Error:', error.message);
          if (error.code === 'ECONNREFUSED') {
            sentryService.captureError(error, { 
              component: 'redis_service', 
              operation: 'connection_refused',
              attempt: this.connectionAttempts
            });
          }
          this.connectionEstablished = false;
          
          if (!this.isConnecting) {
            reject(error);
          }
        });

        newClient.on('connect', () => {
          console.log('🔄 RedisService: Connecting to Redis...');
        });

        newClient.on('ready', () => {
          console.log('✅ RedisService: Client connected and ready!');
          this.connectionEstablished = true;
          this.client = newClient;
          this.isConnecting = false;
          this.connectionAttempts = 0;
          resolve(this.client);
        });

        newClient.on('reconnecting', (delay) => {
          console.log(`🔁 RedisService: Reconnecting in ${delay}ms...`);
        });

        newClient.on('close', () => {
          console.warn('🟡 RedisService: Connection closed');
          this.connectionEstablished = false;
        });

        newClient.on('end', () => {
          console.warn('🟡 RedisService: Connection ended');
          this.connectionEstablished = false;
          this.client = null;
        });

        await newClient.connect();
        
      } catch (error) {
        console.error('❌ RedisService: Initial connection failed:', error.message);
        this.isConnecting = false;
        
        if (this.connectionAttempts < this.maxConnectionAttempts) {
          console.log(`🔄 RedisService: Retrying connection in 2 seconds...`);
          setTimeout(() => {
            this.connect().then(resolve).catch(reject);
          }, 2000);
        } else {
          console.error('❌ RedisService: Max connection attempts reached, giving up.');
          this.isConnecting = false;
          reject(error);
        }
      }
    });

    return this.connectionPromise;
  }

  async getClient() {
    if (this.client && this.client.status === 'ready') {
      return this.client;
    }

    if (!env.REDIS_URL) {
      console.warn('🟡 RedisService: Redis disabled, returning null client.');
      return null;
    }

    if (this.isConnecting) {
      console.log('🔄 RedisService: Waiting for existing connection...');
      return this.connectionPromise;
    }

    console.log('🔄 RedisService: Getting new client connection...');
    return this.connect();
  }

  async testConnection() {
    try {
      const client = await this.getClient();
      if (!client) {
        return { 
          connected: false, 
          latency: -1, 
          error: 'Redis client not available' 
        };
      }

      const startTime = Date.now();
      const reply = await client.ping();
      const endTime = Date.now();
      
      const isConnected = reply === 'PONG';
      const latency = endTime - startTime;

      if (isConnected) {
        console.log(`✅ RedisService: Connection test PASSED (${latency}ms)`);
      } else {
        console.error('❌ RedisService: Connection test FAILED - unexpected PING response');
      }

      return { 
        connected: isConnected, 
        latency: latency,
        status: client.status 
      };
    } catch (error) {
      console.error('❌ RedisService: Connection test FAILED:', error.message);
      return { 
        connected: false, 
        latency: -1, 
        error: error.message 
      };
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.quit();
        console.log('✅ RedisService: Client disconnected gracefully.');
      } catch (error) {
        console.error('❌ RedisService: Error during disconnection:', error.message);
      } finally {
        this.client = null;
        this.connectionEstablished = false;
        this.isConnecting = false;
        this.connectionPromise = null;
      }
    }
  }

  async getStats() {
    try {
      const client = await this.getClient();
      if (!client) {
        return {
          status: 'disabled',
          error: 'Redis URL not configured',
          timestamp: new Date().toISOString()
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

      const dbSize = await client.dbsize();
      
      return {
        status: this.connectionEstablished ? 'connected' : 'disconnected',
        uptime_in_seconds: parsedInfo.uptime_in_seconds || '0',
        used_memory_human: parsedInfo.used_memory_human || '0B',
        total_keys: dbSize,
        connected_clients: parsedInfo.connected_clients || '0',
        redis_version: parsedInfo.redis_version || 'unknown',
        last_updated: new Date().toISOString(),
        connection_attempts: this.connectionAttempts
      };
    } catch (error) {
      console.error('❌ RedisService: Failed to get stats:', error.message);
      return {
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  isConnected() {
    return this.connectionEstablished && this.client && this.client.status === 'ready';
  }
}

const redisServiceInstance = new RedisService();

export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient();
