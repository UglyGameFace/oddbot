// src/services/redisService.js - ENHANCED VERSION
import IORedis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';

class RedisService {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.connectionEstablished = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.lastError = null;

    if (env.REDIS_URL) {
      console.log('🔄 RedisService: Initializing Redis connection...');
      // Don't auto-connect - let the application control connection timing
    } else {
      console.warn('🟡 RedisService: REDIS_URL not found, Redis disabled.');
    }
  }

  async connect() {
    // If we're already connected or connecting, return the existing client/promise
    if (this.client && this.client.status === 'ready') {
      return this.client;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionAttempts++;
    this.lastError = null;

    console.log(`🔄 RedisService: Attempting connection (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})...`);

    this.connectionPromise = new Promise(async (resolve, reject) => {
      try {
        const newClient = new IORedis(env.REDIS_URL, {
          connectTimeout: 5000, // Reduced from 10000 for faster failure
          commandTimeout: 3000, // Reduced from 5000
          maxRetriesPerRequest: 1, // Reduced from 2
          retryDelayOnFailover: 50, // Reduced from 100
          lazyConnect: false, // Changed to false for immediate connection
          // Critical: Don't reconnect on syntax errors
          reconnectOnError: (err) => {
            const errorMessage = err.message.toLowerCase();
            if (errorMessage.includes('syntax error') || errorMessage.includes('unknown command')) {
              return false;
            }
            return true;
          }
        });

        // Apply minimal safety wrappers
        this.applyCommandSafetyWrappers(newClient);

        newClient.on('error', (error) => {
          const errorMessage = error.message.toLowerCase();
          
          // Suppress syntax error logging
          if (errorMessage.includes('syntax error') || errorMessage.includes('unknown command')) {
            return;
          }
          
          console.error('❌ RedisService: Client Error:', error.message);
          this.lastError = error.message;
          this.connectionEstablished = false;
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

        newClient.on('close', () => {
          console.warn('🟡 RedisService: Connection closed');
          this.connectionEstablished = false;
        });

        newClient.on('end', () => {
          console.warn('🟡 RedisService: Connection ended');
          this.connectionEstablished = false;
          this.client = null;
        });

        // Connection will happen automatically since lazyConnect is false
        
      } catch (error) {
        console.error('❌ RedisService: Initial connection failed:', error.message);
        this.isConnecting = false;
        this.lastError = error.message;
        
        if (this.connectionAttempts < this.maxConnectionAttempts) {
          console.log(`🔄 RedisService: Retrying connection in 1 second...`);
          setTimeout(() => {
            this.connect().then(resolve).catch(reject);
          }, 1000);
        } else {
          console.error('❌ RedisService: Max connection attempts reached, giving up.');
          this.isConnecting = false;
          reject(error);
        }
      }
    });

    return this.connectionPromise;
  }

  applyCommandSafetyWrappers(client) {
    if (!client) return;

    // Completely disable problematic commands
    client.memory = async function() {
      return null; // Silent fail
    };

    console.log('✅ RedisService: Command safety wrappers applied');
  }

  async getClient() {
    // If no REDIS_URL, return null immediately
    if (!env.REDIS_URL) {
      return null;
    }

    // If we have a ready client, return it
    if (this.client && this.client.status === 'ready') {
      return this.client;
    }

    // Otherwise, connect
    return this.connect();
  }

  async healthCheck() {
    try {
      const client = await this.getClient();
      if (!client) {
        return {
          healthy: false,
          error: 'Redis not configured',
          timestamp: new Date().toISOString()
        };
      }

      const startTime = Date.now();
      const reply = await client.ping();
      const latency = Date.now() - startTime;

      return {
        healthy: reply === 'PONG',
        latency: latency,
        status: client.status,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  isConnected() {
    return this.connectionEstablished && this.client && this.client.status === 'ready';
  }

  // Quick check for health checks
  isReady() {
    return this.isConnected();
  }
}

const redisServiceInstance = new RedisService();
export default redisServiceInstance;
