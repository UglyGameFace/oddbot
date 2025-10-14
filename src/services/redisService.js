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
    this.maxConnectionAttempts = 3;
    this.syntaxErrorCount = 0; // Add syntax error counter

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
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          lazyConnect: true,
          reconnectOnError: (err) => {
            const errorMessage = err.message.toLowerCase();
            if (errorMessage.includes('syntax error')) {
              this.syntaxErrorCount++; // Increment on syntax error
              return false; // Don't reconnect for syntax errors
            }
            return true;
          }
        });

        // Apply safety wrappers to prevent syntax errors
        this.applyCommandSafetyWrappers(newClient);

        newClient.on('error', (error) => {
          const errorMessage = error.message.toLowerCase();
          
          if (errorMessage.includes('syntax error')) {
            this.syntaxErrorCount++; // Increment on syntax error
            return; // Don't treat syntax errors as connection failures
          }
          
          console.error('❌ RedisService: Client Error:', error.message);
          if (error.code === 'ECONNREFUSED') {
            sentryService.captureError(error, { 
              component: 'redis_service', 
              operation: 'connection_refused',
              attempt: this.connectionAttempts
            });
          }
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

    // Wrap MEMORY command to handle syntax errors
    const originalMemory = client.memory;
    client.memory = async function(...args) {
      try {
        return await originalMemory.apply(this, args);
      } catch (error) {
        if (error.message.includes('ERR syntax error') || error.message.includes('unknown command')) {
          console.warn('⚠️ RedisService: MEMORY command not available, using fallback');
          return null;
        }
        throw error;
      }
    };

    // Wrap EVAL command with better error handling
    const originalEval = client.eval;
    client.eval = async function(script, numKeys, ...args) {
      try {
        // Validate script before execution
        if (typeof script !== 'string' || script.trim().length === 0) {
          throw new Error('Invalid Lua script: empty or non-string');
        }
        
        // Ensure numKeys is a valid number
        const keysCount = parseInt(numKeys, 10);
        if (isNaN(keysCount) || keysCount < 0) {
          throw new Error(`Invalid keys count: ${numKeys}`);
        }
        
        return await originalEval.apply(this, [script, keysCount, ...args]);
      } catch (error) {
        if (error.message.includes('ERR syntax error')) {
          this.syntaxErrorCount++; // Increment on syntax error
          console.error('❌ RedisService: EVAL syntax error:', error.message);
          throw new Error(`Lua script execution failed: ${error.message}`);
        }
        throw error;
      }
    }.bind(this); // Bind 'this' to access syntaxErrorCount

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

// FIXED: Add the missing export that rateLimitService needs
const redisServiceInstance = new RedisService();
export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient(); // THIS WAS MISSING!
