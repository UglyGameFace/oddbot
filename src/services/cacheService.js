// src/services/cacheService.js - COMPLETE FIXED VERSION
import { sentryService } from './sentryService.js';
import redisServiceInstance from './redisService.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const safeJsonParse = (str, fallback = null) => {
  if (str === null || str === undefined) return fallback;
  try {
    return JSON.parse(str);
  } catch (error) {
    console.warn('❌ CacheService: JSON parse error:', error.message);
    return fallback;
  }
};

class CacheService {
  constructor() {
    this.redis = null;
    this.isInitialized = false;
    this.initializationPromise = null;
    this.DEFAULT_LOCK_MS = 8000;
    this.DEFAULT_RETRY_MS = 150;

    this.init();
  }

  async init() {
    if (this.isInitialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = new Promise(async (resolve) => {
      console.log('🔄 CacheService: Initializing cache service...');
      
      try {
        this.redis = await redisServiceInstance.getClient();
        
        if (!this.redis) {
          console.warn('⚠️ CacheService: No Redis client available, operating in fallback mode');
          this.isInitialized = true;
          resolve();
          return;
        }

        // Test basic Redis commands to ensure they work
        await this.testRedisCommands();
        
        console.log('✅ CacheService: Successfully initialized with Redis');
        this.isInitialized = true;
        resolve();
      } catch (error) {
        console.error('❌ CacheService: Initialization failed:', error.message);
        this.redis = null;
        this.isInitialized = true;
        resolve();
      }
    });

    return this.initializationPromise;
  }

  async testRedisCommands() {
    if (!this.redis) return;

    try {
      // Test PING
      const pingResult = await this.redis.ping();
      console.log(`✅ CacheService: Redis PING - ${pingResult}`);

      // Test SET/GET
      const testKey = `cache_test_${Date.now()}`;
      await this.redis.set(testKey, 'test_value', 'EX', 5);
      const testValue = await this.redis.get(testKey);
      console.log(`✅ CacheService: Redis SET/GET - ${testValue === 'test_value' ? 'PASS' : 'FAIL'}`);
      
      // Cleanup test key
      await this.redis.del(testKey).catch(() => {});

    } catch (error) {
      console.error('❌ CacheService: Redis command tests failed:', error.message);
      throw error;
    }
  }

  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.init();
    }
  }

  isValidRedisClient() {
    return this.redis && 
           typeof this.redis.get === 'function' && 
           typeof this.redis.set === 'function' &&
           typeof this.redis.del === 'function';
  }

  async safeRedisCommand(operation, context = 'redis_command') {
    await this.ensureInitialized();
    
    if (!this.isValidRedisClient()) {
      console.warn(`⚠️ CacheService: Invalid Redis client in ${context}, skipping operation`);
      throw new Error('Redis client not available');
    }
    
    try {
      return await operation(this.redis);
    } catch (error) {
      const errorMessage = (error instanceof Error && error.message) ? error.message : String(error);
      const errorMsg = errorMessage.toLowerCase();
      
      if (!errorMsg.includes('syntax error')) {
        console.error(`❌ CacheService: Redis command failed (${context}):`, errorMessage);
        
        const errorToReport = error instanceof Error ? error : new Error(errorMessage);
        sentryService.captureError(errorToReport, {
          component: 'cache_service',
          operation: context
        });
      }
      
      throw error || new Error(errorMessage);
    }
  }

  async releaseLock(lockKey, lockValue) {
    await this.ensureInitialized();
    if (!this.isValidRedisClient()) return;
  
    try {
      // Use optimistic locking to release the lock safely.
      await this.redis.watch(lockKey);
      const value = await this.redis.get(lockKey);
  
      if (value === lockValue) {
        const multi = this.redis.multi();
        multi.del(lockKey);
        await multi.exec();
        console.log(`🔓 CacheService: Released lock for key: ${lockKey.replace('lock:','')}`);
      } else {
        // The lock value changed or expired, so we don't need to do anything.
        await this.redis.unwatch();
      }
    } catch (error) {
        const errorMessage = (error instanceof Error && error.message) ? error.message : String(error);
        console.warn(`⚠️ CacheService: Failed to release lock for key: ${lockKey}`, errorMessage);
        // Ensure unwatch is called even on error to clean up the connection state.
        try {
          await this.redis.unwatch();
        } catch (unwatchError) {
          // This might happen if the connection is lost.
        }
    }
  }

  async executeLoaderAndCache(key, ttlSec, loader, context) {
    try {
      const data = await loader();
      if (data !== undefined && data !== null) {
        await this.safeRedisCommand(async (client) => {
          await client.set(key, JSON.stringify(data), 'EX', ttlSec);
        }, 'set_cache_data');
        console.log(`💾 CacheService: Cached data for key: ${key} (TTL: ${ttlSec}s)`);
      } else {
        console.warn(`⚠️ CacheService: Loader returned null/undefined for key: ${key}`);
      }
      return data;
    } catch (loaderError) {
      console.error(`❌ CacheService: Loader failed for cache key: ${key}`, loaderError.message);
      sentryService.captureError(loaderError, {
        component: 'cache_service',
        operation: 'getOrSetJSON_loader',
        cacheKey: key,
        ...context
      });
      throw loaderError;
    }
  }

  async getOrSetJSON(key, ttlSec, loader, { 
    lockMs = this.DEFAULT_LOCK_MS, 
    retryMs = this.DEFAULT_RETRY_MS,
    context = {},
    fallbackOnError = true
  } = {}) {
    
    await this.ensureInitialized();
    const lockValue = `lock_${Date.now()}`;
    
    try {
      const cached = await this.safeRedisCommand(async (client) => {
        return await client.get(key);
      }, 'get_cached_data');

      if (cached) {
        try {
          const parsed = safeJsonParse(cached);
          if (parsed !== null) {
            console.log(`📦 CacheService: Cache HIT for key: ${key}`);
            return parsed;
          }
        } catch (parseError) {
          console.warn(`❌ CacheService: Failed to parse cached JSON for key: ${key}`, parseError);
        }
      }

      console.log(`❌ CacheService: Cache MISS for key: ${key}`);
      const lockKey = `lock:${key}`;
      
      let gotLock;
      try {
        gotLock = await this.safeRedisCommand(async (client) => {
          return await client.set(lockKey, lockValue, 'PX', lockMs, 'NX');
        }, 'acquire_lock');
      } catch (lockError) {
        const errorMessage = (lockError instanceof Error && lockError.message) ? lockError.message : String(lockError);
        console.warn(`⚠️ CacheService: Lock acquisition failed for ${key}, proceeding without lock:`, errorMessage);
        gotLock = null;
      }

      if (gotLock === 'OK') {
        console.log(`🔒 CacheService: Acquired lock for key: ${key}`);
        try {
          return await this.executeLoaderAndCache(key, ttlSec, loader, context);
        } catch (loaderError) {
          if (fallbackOnError && cached) {
            console.log('🔄 CacheService: Using cached data despite loader error');
            const fallbackData = safeJsonParse(cached, null);
            if (fallbackData) {
              return fallbackData;
            }
          }
          throw loaderError;
        } finally {
            await this.releaseLock(lockKey, lockValue);
        }
      } else {
        console.log(`⏳ CacheService: Waiting for lock on key: ${key}`);
        const deadline = Date.now() + lockMs;
        
        while (Date.now() < deadline) {
          await sleep(retryMs);
          
          try {
            const again = await this.safeRedisCommand(async (client) => {
              return await client.get(key);
            }, 'lock_wait_check');
            
            if (again) {
              const parsed = safeJsonParse(again);
              if (parsed !== null) {
                console.log(`📦 CacheService: Got cached data after lock wait for key: ${key}`);
                return parsed;
              }
              break;
            }
          } catch (waitError) {
            console.warn(`⚠️ CacheService: Lock wait check failed, proceeding without lock:`, waitError.message);
            break;
          }
        }
        
        console.log(`⏰ CacheService: Lock wait timed out for key: ${key}. Loading data without lock...`);
        
        try {
          const data = await this.executeLoaderAndCache(key, ttlSec, loader, context);
          return data;
        } catch (loaderError) {
           throw loaderError;
        }
      }
    } catch (error) {
      console.error(`❌ CacheService: Cache operation failed for key: ${key}`, error.message);
      
      if (error && error.message && !error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getOrSetJSON',
          cacheKey: key,
          ...context
        });
      }
      
      if (fallbackOnError) {
        try {
          console.log(`🔄 CacheService: Fallback to direct loader for key: ${key}`);
          return await loader();
        } catch (fallbackError) {
          console.error(`❌ CacheService: Fallback loader also failed for key: ${key}`, fallbackError.message);
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async getJSON(key, fallback = null) {
    await this.ensureInitialized();
    
    try {
      const cached = await this.safeRedisCommand(async (client) => {
        return await client.get(key);
      }, 'getJSON');
      const result = safeJsonParse(cached, fallback);
      console.log(`🔍 CacheService: Cache GET for ${key}: ${result ? 'HIT' : 'MISS'}`);
      return result;
    } catch (error) {
      console.error(`❌ CacheService: Cache get failed for key: ${key}`, error.message);
      return fallback;
    }
  }

  async setJSON(key, value, ttlSec = 3600) {
    await this.ensureInitialized();
    
    try {
      if (value === undefined || value === null) {
        await this.safeRedisCommand(async (client) => {
          await client.del(key);
        }, 'delete_key');
        console.log(`🗑️ CacheService: Deleted cache key: ${key}`);
        return true;
      }
      
      await this.safeRedisCommand(async (client) => {
        await client.set(key, JSON.stringify(value), 'EX', ttlSec);
      }, 'setJSON');
      console.log(`💾 CacheService: Cache SET for ${key} (TTL: ${ttlSec}s)`);
      return true;
    } catch (error) {
      console.error(`❌ CacheService: Cache set failed for key: ${key}`, error.message);
      return false;
    }
  }

  async deleteKey(key) {
    await this.ensureInitialized();
    
    try {
      const result = await this.safeRedisCommand(async (client) => {
        return await client.del(key);
      }, 'deleteKey');
      console.log(`🗑️ CacheService: Deleted cache key: ${key} (result: ${result})`);
      return result > 0;
    } catch (error) {
      console.error(`❌ CacheService: Failed to delete cache key: ${key}`, error.message);
      if (error && error.message && !error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'deleteKey',
          cacheKey: key
        });
      }
      return false;
    }
  }

  async getKeys(pattern) {
    await this.ensureInitialized();
    
    try {
      const keys = await this.safeRedisCommand(async (client) => {
        return await client.keys(pattern);
      }, 'getKeys');
      console.log(`🔍 CacheService: Found ${keys.length} keys matching pattern: ${pattern}`);
      return keys;
    } catch (error) {
      console.error(`❌ CacheService: Failed to get keys for pattern: ${pattern}`, error.message);
      if (error && error.message && !error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getKeys',
          pattern
        });
      }
      return [];
    }
  }

  async flushPattern(pattern) {
    await this.ensureInitialized();
    
    try {
      const keys = await this.safeRedisCommand(async (client) => {
        return await client.keys(pattern);
      }, 'flushPattern_keys');
      
      if (keys.length > 0) {
        await this.safeRedisCommand(async (client) => {
          await client.del(...keys);
        }, 'flushPattern_del');
        console.log(`🧹 CacheService: Flushed ${keys.length} keys matching: ${pattern}`);
        return keys.length;
      }
      console.log(`🔍 CacheService: No keys found matching pattern: ${pattern}`);
      return 0;
    } catch (error) {
      console.error(`❌ CacheService: Failed to flush pattern: ${pattern}`, error.message);
      if (error && error.message && !error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'flushPattern',
          pattern
        });
      }
      return 0;
    }
  }

  async getCacheInfo() {
    await this.ensureInitialized();
    
    try {
      if (!this.isValidRedisClient()) {
        return { 
          status: 'redis_not_available',
          timestamp: new Date().toISOString() 
        };
      }

      const info = await this.safeRedisCommand(async (client) => {
        return await client.info();
      }, 'getCacheInfo');

      const lines = info.split('\r\n');
      const cacheInfo = {};
      
      for (const line of lines) {
        if (line && !line.startsWith('#')) {
          const [key, value] = line.split(':');
          if (key && value) {
            cacheInfo[key] = value;
          }
        }
      }

      const commonPatterns = ['odds:*', 'games:*', 'sports:*', 'player_props:*', 'quota:*', 'lock:*'];
      const patternCounts = {};
      
      for (const pattern of commonPatterns) {
        try {
          const keys = await this.safeRedisCommand(async (client) => {
            return await client.keys(pattern);
          }, `getKeys_${pattern}`);
          patternCounts[pattern] = keys.length;
        } catch (error) {
          patternCounts[pattern] = 0;
        }
      }

      // Get memory info from INFO command instead of MEMORY command
      let memoryData = {};
      try {
        const memoryInfo = await this.safeRedisCommand(async (client) => {
          return await client.info('memory');
        }, 'getMemoryInfo');
        
        if (memoryInfo && typeof memoryInfo === 'string') {
          const memoryLines = memoryInfo.split('\r\n');
          for (const line of memoryLines) {
            if (line && !line.startsWith('#')) {
              const [key, value] = line.split(':');
              if (key && value) {
                memoryData[key] = value;
              }
            }
          }
        }
      } catch (memoryError) {
        console.warn('⚠️ CacheService: Failed to get memory info from INFO command:', memoryError.message);
      }

      const totalKeys = Object.values(patternCounts).reduce((sum, count) => sum + count, 0);
      const hitRate = cacheInfo.keyspace_hits && cacheInfo.keyspace_misses ? 
        (parseInt(cacheInfo.keyspace_hits) / (parseInt(cacheInfo.keyspace_hits) + parseInt(cacheInfo.keyspace_misses))).toFixed(4) : 0;

      console.log(`📊 CacheService: Cache Info - ${totalKeys} total keys, hit rate: ${(hitRate * 100).toFixed(2)}%`);

      return {
        ...cacheInfo,
        pattern_distribution: patternCounts,
        total_cached_keys: totalKeys,
        memory_usage: memoryData.used_memory_human || cacheInfo.used_memory_human || 'unknown',
        memory_peak: memoryData.used_memory_peak_human || cacheInfo.used_memory_peak_human || 'unknown',
        hit_rate: hitRate,
        hit_rate_percentage: `${(hitRate * 100).toFixed(2)}%`,
        timestamp: new Date().toISOString(),
        redis_status: redisServiceInstance.isConnected() ? 'connected' : 'disconnected',
        syntax_errors: redisServiceInstance.getSyntaxErrorCount()
      };
    } catch (error) {
      console.error('❌ CacheService: Failed to get cache info:', error.message);
      if (error && error.message && !error.message.includes('syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getCacheInfo'
        });
      }
      return { 
        error: error.message,
        timestamp: new Date().toISOString(),
        redis_status: 'error'
      };
    }
  }

  async keyInfo(key) {
    await this.ensureInitialized();
    
    try {
      if (!this.isValidRedisClient()) {
        return {
          exists: false,
          error: 'Redis client not available',
          timestamp: new Date().toISOString()
        };
      }

      const [exists, ttl, type] = await Promise.all([
        this.safeRedisCommand(async (client) => await client.exists(key), 'keyInfo_exists'),
        this.safeRedisCommand(async (client) => await client.ttl(key), 'keyInfo_ttl'),
        this.safeRedisCommand(async (client) => await client.type(key), 'keyInfo_type')
      ]);
      
      // Skip memory usage to avoid syntax errors
      const result = {
        exists: exists === 1,
        ttl,
        type,
        memory_usage: 'disabled',
        ttl_human: ttl > 0 ? `${ttl} seconds` : 'no TTL',
        status: exists ? (ttl > 0 ? 'active' : 'persistent') : 'not_found',
        timestamp: new Date().toISOString()
      };

      console.log(`🔍 CacheService: Key info for ${key}:`, result);
      return result;

    } catch (error) {
      console.error(`❌ CacheService: Failed to get key info for: ${key}`, error.message);
      return {
        exists: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async increment(key, value = 1, ttlSec = null) {
    await this.ensureInitialized();
    
    try {
      const result = await this.safeRedisCommand(async (client) => {
        return await client.incrby(key, value);
      }, 'increment');
      
      if (ttlSec && ttlSec > 0) {
        await this.safeRedisCommand(async (client) => {
          await client.expire(key, ttlSec);
        }, 'increment_expire');
      }
      console.log(`➕ CacheService: Incremented ${key} by ${value}, new value: ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ CacheService: Failed to increment key: ${key}`, error.message);
      return null;
    }
  }

  async decrement(key, value = 1, ttlSec = null) {
    await this.ensureInitialized();
    
    try {
      const result = await this.safeRedisCommand(async (client) => {
        return await client.decrby(key, value);
      }, 'decrement');
      
      if (ttlSec && ttlSec > 0) {
        await this.safeRedisCommand(async (client) => {
          await client.expire(key, ttlSec);
        }, 'decrement_expire');
      }
      console.log(`➖ CacheService: Decremented ${key} by ${value}, new value: ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ CacheService: Failed to decrement key: ${key}`, error.message);
      return null;
    }
  }

  async setWithTTL(key, value, ttlSec) {
    await this.ensureInitialized();
    
    try {
      if (ttlSec && ttlSec > 0) {
        await this.safeRedisCommand(async (client) => {
          await client.set(key, value, 'EX', ttlSec);
        }, 'setWithTTL');
      } else {
        await this.safeRedisCommand(async (client) => {
          await client.set(key, value);
        }, 'setWithoutTTL');
      }
      console.log(`💾 CacheService: Set key ${key} with TTL ${ttlSec || 'none'}`);
      return true;
    } catch (error) {
      console.error(`❌ CacheService: Failed to set with TTL for key: ${key}`, error.message);
      return false;
    }
  }

  async getWithTTL(key) {
    await this.ensureInitialized();
    
    try {
      const [value, ttl] = await Promise.all([
        this.safeRedisCommand(async (client) => await client.get(key), 'getWithTTL_value'),
        this.safeRedisCommand(async (client) => await client.ttl(key), 'getWithTTL_ttl')
      ]);
      console.log(`🔍 CacheService: Get with TTL for ${key}: value=${value ? 'exists' : 'null'}, ttl=${ttl}`);
      return { value, ttl };
    } catch (error) {
      console.error(`❌ CacheService: Failed to get with TTL for key: ${key}`, error.message);
      return { value: null, ttl: -2 };
    }
  }

  async healthCheck() {
    await this.ensureInitialized();
    
    try {
      if (!this.isValidRedisClient()) {
        return {
          healthy: false,
          error: 'Redis client not available',
          timestamp: new Date().toISOString(),
          details: {
            write: false,
            read: false,
            delete: false
          }
        };
      }

      const startTime = Date.now();
      const testKey = `health_check_${startTime}`;
      
      await this.safeRedisCommand(async (client) => {
        await client.setex(testKey, 10, 'health_check_value');
      }, 'healthCheck_set');
      
      const value = await this.safeRedisCommand(async (client) => {
        return await client.get(testKey);
      }, 'healthCheck_get');
      
      await this.safeRedisCommand(async (client) => {
        await client.del(testKey);
      }, 'healthCheck_del');
      
      const responseTime = Date.now() - startTime;
      
      const result = {
        healthy: value === 'health_check_value',
        response_time: responseTime,
        timestamp: new Date().toISOString(),
        details: {
          write: true,
          read: true,
          delete: true
        },
        redis_syntax_errors: redisServiceInstance.getSyntaxErrorCount()
      };

      console.log(`❤️ CacheService: Health check: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'} (${responseTime}ms)`);
      return result;

    } catch (error) {
      console.error('❌ CacheService: Health check failed:', error.message);
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        details: {
          write: false,
          read: false,
          delete: false
        },
        redis_syntax_errors: redisServiceInstance.getSyntaxErrorCount()
      };
    }
  }

  isAvailable() {
    return this.isInitialized && this.isValidRedisClient();
  }

  // Method to reset Redis connection if needed
  async resetConnection() {
    if (this.redis) {
      try {
        await this.redis.disconnect();
      } catch (error) {
        // Ignore disconnect errors
      }
    }
    
    this.redis = null;
    this.isInitialized = false;
    this.initializationPromise = null;
    
    // Also reset Redis service syntax errors
    redisServiceInstance.resetSyntaxErrorCount();
    
    console.log('🔄 CacheService: Connection reset, reinitializing...');
    return this.init();
  }
}

const cacheServiceInstance = new CacheService();

export default cacheServiceInstance;
export { sleep, safeJsonParse };
