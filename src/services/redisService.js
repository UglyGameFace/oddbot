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
    this.syntaxErrorCount = 0;
    this.maxSyntaxErrors = 10;

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
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          lazyConnect: true,
          reconnectOnError: (err) => {
            const errorMessage = err.message.toLowerCase();
            if (errorMessage.includes('syntax error')) {
              this.syntaxErrorCount++;
              console.warn(`⚠️ RedisService: Syntax error detected (${this.syntaxErrorCount}/${this.maxSyntaxErrors})`);
              
              if (this.syntaxErrorCount >= this.maxSyntaxErrors) {
                console.error('❌ RedisService: Max syntax errors reached, disabling problematic commands');
                this.disableProblematicCommands(newClient);
                return false; // Don't reconnect for syntax errors
              }
            }
            return true;
          }
        });

        // Apply safety wrappers to prevent syntax errors
        this.applyCommandSafetyWrappers(newClient);

        newClient.on('error', (error) => {
          const errorMessage = error.message.toLowerCase();
          
          if (errorMessage.includes('syntax error')) {
            console.warn(`⚠️ RedisService: Syntax error: ${error.message}`);
            this.syntaxErrorCount++;
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
          this.syntaxErrorCount = 0;
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
          console.error('❌ RedisService: EVAL syntax error:', error.message);
          console.log('📜 Script snippet:', script.substring(0, 100) + '...');
          throw new Error(`Lua script execution failed: ${error.message}`);
        }
        throw error;
      }
    };

    // Wrap INFO command to handle parsing errors
    const originalInfo = client.info;
    client.info = async function(section) {
      try {
        const info = await originalInfo.apply(this, [section]);
        return info;
      } catch (error) {
        if (error.message.includes('ERR syntax error')) {
          console.warn('⚠️ RedisService: INFO command syntax error, trying without section...');
          try {
            return await originalInfo.apply(this, []);
          } catch (fallbackError) {
            console.error('❌ RedisService: INFO command completely failed:', fallbackError.message);
            return '';
          }
        }
        throw error;
      }
    };

    console.log('✅ RedisService: Command safety wrappers applied');
  }

  disableProblematicCommands(client) {
    if (!client) return;

    // Replace problematic commands with safe versions
    client.memory = async function() {
      console.warn('⚠️ RedisService: MEMORY command disabled due to syntax errors');
      return null;
    };

    console.log('✅ RedisService: Problematic commands disabled');
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
        status: client.status,
        syntax_errors: this.syntaxErrorCount
      };
    } catch (error) {
      console.error('❌ RedisService: Connection test FAILED:', error.message);
      return { 
        connected: false, 
        latency: -1, 
        error: error.message,
        syntax_errors: this.syntaxErrorCount
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
        this.syntaxErrorCount = 0;
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
      
      if (info && typeof info === 'string') {
        info.split('\r\n').forEach(line => {
          if (line && !line.startsWith('#')) {
            const [key, value] = line.split(':');
            if (key && value) {
              parsedInfo[key] = value;
            }
          }
        });
      }

      const dbSize = await client.dbsize();
      
      return {
        status: this.connectionEstablished ? 'connected' : 'disconnected',
        uptime_in_seconds: parsedInfo.uptime_in_seconds || '0',
        used_memory_human: parsedInfo.used_memory_human || '0B',
        total_keys: dbSize,
        connected_clients: parsedInfo.connected_clients || '0',
        redis_version: parsedInfo.redis_version || 'unknown',
        last_updated: new Date().toISOString(),
        connection_attempts: this.connectionAttempts,
        syntax_errors: this.syntaxErrorCount
      };
    } catch (error) {
      console.error('❌ RedisService: Failed to get stats:', error.message);
      return {
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
        syntax_errors: this.syntaxErrorCount
      };
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
    console.log('✅ RedisService: Syntax error count reset');
  }
}

const redisServiceInstance = new RedisService();

export default redisServiceInstance;
export const getRedisClient = () => redisServiceInstance.getClient();
