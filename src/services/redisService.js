// src/services/redisService.js - COMPLETE FIXED VERSION
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
    this.maxConnectionAttempts = 5; // Increased attempts
    this.syntaxErrorCount = 0;

    if (env.REDIS_URL) {
      console.log('🔄 RedisService: Initializing Redis connection...');
      this.connect();
    } else {
      console.warn('🟡 RedisService: REDIS_URL not found, Redis disabled.');
    }
  }

  async connect() {
    if (this.isConnecting) {
      return this.connectionPromise;
    }

    if (this.client && this.client.status === 'ready') {
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
          retryStrategy: (times) => {
            const delay = Math.min(times * 100, 2000); // Reconnect with increasing delay
            return delay;
          },
          reconnectOnError: (err) => {
            const targetError = 'read ECONNRESET';
            if (err.message.includes(targetError)) {
              return true; // Attempt to reconnect on ECONNRESET
            }
            return false;
          },
          lazyConnect: true,
        });

        this.applyCommandSafetyWrappers(newClient);

        newClient.on('error', (error) => {
          const errorMessage = (error && error.message) ? error.message.toLowerCase() : '';
          
          if (errorMessage.includes('syntax error')) {
            this.syntaxErrorCount++;
            return;
          }
          
          console.error('❌ RedisService: Unhandled Client Error:', (error && error.message) ? error.message : String(error));
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

  applyCommandSafetyWrappers(client) {
    if (!client) return;

    const originalEval = client.eval;
    client.eval = async function(script, numKeys, ...args) {
      try {
        if (typeof script !== 'string' || script.trim().length === 0) throw new Error('Invalid Lua script');
        const keysCount = parseInt(numKeys, 10);
        if (isNaN(keysCount) || keysCount < 0) throw new Error(`Invalid keys count: ${numKeys}`);
        return await originalEval.apply(this, [script, keysCount, ...args]);
      } catch (error) {
        if (error && error.message && error.message.includes('ERR syntax error')) {
          this.syntaxErrorCount++;
          console.error('❌ RedisService: EVAL syntax error:', error.message);
          throw new Error(`Lua script execution failed: ${error.message}`);
        }
        throw error;
      }
    }.bind(this);

    console.log('✅ RedisService: Command safety wrappers applied');
  }

  async getClient() {
    if (this.client && this.client.status === 'ready') {
      return this.client;
    }

    if (!env.REDIS_URL) {
      return null;
    }

    if (this.isConnecting) {
      return this.connectionPromise;
    }

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

  isConnected() {
    return this.connectionEstablished && this.client && this.client.status === 'ready';
  }

  getSyntaxErrorCount() {
    return this.syntaxErrorCount;
  }

  resetSyntaxErrorCount() {
    this.syntaxErrorCount = 0;
  }
}

const redisServiceInstance = new RedisService();
export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient();
