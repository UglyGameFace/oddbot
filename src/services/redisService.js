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
    this.maxConnectionAttempts = 5;
    this.syntaxErrorCount = 0;
    this.lastSyntaxError = null;

    if (env.REDIS_URL) {
      console.log('🔄 RedisService: Initializing Redis connection...');
      this.connect();
    } else {
      console.warn('⚠️ RedisService: REDIS_URL not found, Redis disabled.');
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
            const delay = Math.min(times * 100, 2000);
            return delay;
          },
          reconnectOnError: (err) => {
            const targetError = 'read ECONNRESET';
            if (err.message.includes(targetError)) {
              return true;
            }
            return false;
          },
          lazyConnect: true,
          showFriendlyErrorStack: true, // Better error messages
          enableAutoPipelining: false, // Disable to avoid syntax issues
        });

        // Apply command safety wrappers
        this.applyCommandSafetyWrappers(newClient);

        newClient.on('error', (error) => {
          const errorMessage = error?.message?.toLowerCase() || '';
          
          if (errorMessage.includes('syntax error')) {
            this.syntaxErrorCount++;
            this.lastSyntaxError = {
              message: error.message,
              timestamp: new Date().toISOString(),
              stack: error.stack
            };
            console.error('❌ RedisService: Syntax Error:', error.message);
            return;
          }
          
          // Don't log connection errors during initial connection attempts
          if (!errorMessage.includes('connect') || this.connectionEstablished) {
            console.error('❌ RedisService: Client Error:', error.message);
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
          console.log(`🔄 RedisService: Reconnecting in ${delay}ms...`);
        });

        newClient.on('close', () => {
          console.warn('⚠️ RedisService: Connection closed');
          this.connectionEstablished = false;
        });

        newClient.on('end', () => {
          console.warn('⚠️ RedisService: Connection ended');
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

    // Store original methods
    const originalEval = client.eval;
    const originalKeys = client.keys;
    const originalScan = client.scan;
    const originalDel = client.del;

    // Wrap EVAL command
    client.eval = async function(script, numKeys, ...args) {
      try {
        if (typeof script !== 'string' || script.trim().length === 0) {
          throw new Error('Invalid Lua script');
        }
        const keysCount = parseInt(numKeys, 10);
        if (isNaN(keysCount) || keysCount < 0) {
          throw new Error(`Invalid keys count: ${numKeys}`);
        }
        return await originalEval.apply(this, [script, keysCount, ...args]);
      } catch (error) {
        if (error?.message?.includes('ERR syntax error')) {
          this.syntaxErrorCount++;
          this.lastSyntaxError = {
            message: error.message,
            timestamp: new Date().toISOString(),
            operation: 'eval',
            script: script.substring(0, 100) + '...'
          };
          console.error('❌ RedisService: EVAL syntax error:', error.message);
        }
        throw error;
      }
    }.bind(this);

    // Wrap KEYS command
    client.keys = async function(pattern) {
      try {
        // Validate pattern
        if (typeof pattern !== 'string') {
          throw new Error('Pattern must be a string');
        }
        if (pattern.length > 500) {
          throw new Error('Pattern too long');
        }
        return await originalKeys.call(this, pattern);
      } catch (error) {
        if (error?.message?.includes('ERR syntax error')) {
          this.syntaxErrorCount++;
          this.lastSyntaxError = {
            message: error.message,
            timestamp: new Date().toISOString(),
            operation: 'keys',
            pattern: pattern
          };
          console.error('❌ RedisService: KEYS syntax error:', error.message);
        }
        throw error;
      }
    }.bind(this);

    // Wrap SCAN command
    client.scan = async function(cursor, ...args) {
      try {
        // Validate cursor
        if (typeof cursor !== 'string' && typeof cursor !== 'number') {
          throw new Error('Cursor must be string or number');
        }
        return await originalScan.call(this, cursor, ...args);
      } catch (error) {
        if (error?.message?.includes('ERR syntax error')) {
          this.syntaxErrorCount++;
          this.lastSyntaxError = {
            message: error.message,
            timestamp: new Date().toISOString(),
            operation: 'scan',
            cursor: cursor,
            args: args
          };
          console.error('❌ RedisService: SCAN syntax error:', error.message);
        }
        throw error;
      }
    }.bind(this);

    // Wrap DEL command
    client.del = async function(...keys) {
      try {
        // Validate keys
        if (keys.length === 0) {
          throw new Error('No keys provided for deletion');
        }
        if (keys.length > 1000) {
          console.warn('⚠️ RedisService: Large DEL operation, consider batching');
        }
        return await originalDel.call(this, ...keys);
      } catch (error) {
        if (error?.message?.includes('ERR syntax error')) {
          this.syntaxErrorCount++;
          this.lastSyntaxError = {
            message: error.message,
            timestamp: new Date().toISOString(),
            operation: 'del',
            keyCount: keys.length,
            firstKey: keys[0]
          };
          console.error('❌ RedisService: DEL syntax error:', error.message);
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
        status: client.status,
        syntaxErrors: this.syntaxErrorCount
      };
    } catch (error) {
      console.error('❌ RedisService: Connection test FAILED:', error.message);
      return { 
        connected: false, 
        latency: -1, 
        error: error.message,
        syntaxErrors: this.syntaxErrorCount
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

  getLastSyntaxError() {
    return this.lastSyntaxError;
  }

  resetSyntaxErrorCount() {
    this.syntaxErrorCount = 0;
    this.lastSyntaxError = null;
  }

  // Method to get detailed connection status
  getConnectionStatus() {
    return {
      connected: this.isConnected(),
      status: this.client?.status || 'disconnected',
      connectionAttempts: this.connectionAttempts,
      syntaxErrorCount: this.syntaxErrorCount,
      lastSyntaxError: this.lastSyntaxError,
      timestamp: new Date().toISOString()
    };
  }

  // Safe command execution with error handling
  async executeCommand(command, ...args) {
    try {
      const client = await this.getClient();
      if (!client) {
        throw new Error('Redis client not available');
      }
      
      // Validate command exists
      if (typeof client[command] !== 'function') {
        throw new Error(`Invalid Redis command: ${command}`);
      }
      
      return await client[command](...args);
    } catch (error) {
      console.error(`❌ RedisService: Command ${command} failed:`, error.message);
      
      // Capture to Sentry if it's not a syntax error
      if (!error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'redis_service',
          operation: command,
          args: args.slice(0, 3) // Limit args for privacy
        });
      }
      
      throw error;
    }
  }
}

const redisServiceInstance = new RedisService();
export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient();
