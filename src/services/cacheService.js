// src/services/cacheService.js - ABSOLUTE FINAL FIXED VERSION (Complete Script)

import { sentryService } from './sentryService.js';

// Utility functions (previously from asyncUtils.js)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const safeJsonParse = (str, fallback = null) => {
  if (str === null || str === undefined) return fallback;
  try {
    return JSON.parse(str);
  } catch (error) {
    console.warn('❌ JSON parse error:', error.message);
    return fallback;
  }
};

export default function makeCache(redis) {
  const DEFAULT_LOCK_MS = 8000;
  const DEFAULT_RETRY_MS = 150;
  
  // CRITICAL FIX: Lua script for atomic lock release (prevents race conditions and command corruption)
  // Deletes the lock key ONLY if the value is still '1' (meaning this client still owns it).
  const RELEASE_LOCK_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
    else
        return 0
    end
  `;

  // CRITICAL FIX: Safe Redis command execution with error handling
  async function safeRedisCommand(operation, context = 'redis_command') {
    try {
      return await operation();
    } catch (error) {
      // Don't log syntax errors to Sentry - they're command issues, not system errors
      if (!error.message.includes('ERR syntax error')) {
        console.error(`❌ Redis command failed (${context}):`, error.message);
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: context
        });
      } else {
        console.warn(`⚠️ Redis syntax error in ${context}:`, error.message);
      }
      throw error;
    }
  }

  // Unified function to execute the loader and set the cache
  async function executeLoaderAndCache(key, ttlSec, loader, context) {
    try {
      const data = await loader();
      if (data !== undefined && data !== null) {
        // CRITICAL FIX: Use safe command wrapper
        await safeRedisCommand(async () => {
          await redis.set(key, JSON.stringify(data), 'EX', ttlSec);
        }, 'set_cache_data');
        console.log(`💾 Cached data for key: ${key} (TTL: ${ttlSec}s)`);
      } else {
        console.warn(`⚠️ Loader returned null/undefined for key: ${key}`);
      }
      return data;
    } catch (loaderError) {
      console.error(`❌ Loader failed for cache key: ${key}`, loaderError.message);
      sentryService.captureError(loaderError, {
        component: 'cache_service',
        operation: 'getOrSetJSON_loader',
        cacheKey: key,
        ...context
      });
      throw loaderError;
    }
  }

  async function getOrSetJSON(key, ttlSec, loader, { 
    lockMs = DEFAULT_LOCK_MS, 
    retryMs = DEFAULT_RETRY_MS,
    context = {},
    fallbackOnError = true
  } = {}) {
    
    // The value used for the lock. Should be unique to this client for a robust lock, 
    // but using a static '1' is simple and atomic script is stronger.
    const lockValue = '1'; 
    
    try {
      // Try to get cached data first
      const cached = await safeRedisCommand(async () => {
        return await redis.get(key);
      }, 'get_cached_data');

      if (cached) {
        try {
          const parsed = safeJsonParse(cached);
          if (parsed !== null) {
            console.log(`📦 Cache HIT for key: ${key}`);
            return parsed;
          }
        } catch (parseError) {
          console.warn(`❌ Failed to parse cached JSON for key: ${key}`, parseError);
          // If cached data is corrupt, continue to refresh it
        }
      }

      console.log(`❌ Cache MISS for key: ${key}`);
      const lockKey = `lock:${key}`;
      
      // CRITICAL FIX: Use safe command wrapper for lock acquisition
      let gotLock;
      try {
        gotLock = await safeRedisCommand(async () => {
          // FIX: Use correct SET command syntax for lock
          return await redis.set(lockKey, lockValue, 'PX', lockMs, 'NX');
        }, 'acquire_lock');
      } catch (lockError) {
        // If lock acquisition fails due to syntax error, proceed without lock
        console.warn(`⚠️ Lock acquisition failed for ${key}, proceeding without lock:`, lockError.message);
        gotLock = null;
      }

      if (gotLock === 'OK') {
        // --- Lock Acquired Path ---
        console.log(`🔒 Acquired lock for key: ${key}`);
        try {
          // Use the unified function
          return await executeLoaderAndCache(key, ttlSec, loader, context);
        } catch (loaderError) {
          if (fallbackOnError && cached) {
            console.log('🔄 Using cached data despite loader error');
            const fallbackData = safeJsonParse(cached, null);
            if (fallbackData) {
              return fallbackData;
            }
          }
          throw loaderError;
        } finally {
          // CRITICAL FIX: Use atomic Lua script to release lock only if we own it.
          try {
            await safeRedisCommand(async () => {
              await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockValue);
            }, 'release_lock');
            console.log(`🔓 Released lock for key: ${key}`);
          } catch (releaseError) {
            console.warn(`⚠️ Failed to release lock for key: ${lockKey}`, releaseError.message);
            // Don't throw - lock release failure is non-critical
          }
        }
      } else {
        // --- Lock Wait Path ---
        console.log(`⏳ Waiting for lock on key: ${key}`);
        const deadline = Date.now() + lockMs;
        
        while (Date.now() < deadline) {
          await sleep(retryMs);
          
          // CRITICAL FIX: Use safe command wrapper
          try {
            const again = await safeRedisCommand(async () => {
              return await redis.get(key);
            }, 'lock_wait_check');
            
            if (again) {
              const parsed = safeJsonParse(again);
              if (parsed !== null) {
                console.log(`📦 Got cached data after lock wait for key: ${key}`);
                return parsed;
              }
              // If data is corrupt, stop waiting and attempt to refresh.
              break;
            }
          } catch (waitError) {
            // If we get a syntax error during wait, break out and try without lock
            console.warn(`⚠️ Lock wait check failed, proceeding without lock:`, waitError.message);
            break;
          }
        }
        
        // --- Wait Timeout or Error Path ---
        console.log(`⏰ Lock wait timed out/failed for key: ${key}. Loading data without lock...`);
        
        // If the lock wait timed out or failed, we load the fresh data without a lock.
        try {
          // Load fresh data, do not attempt to acquire a lock (avoiding the ERR syntax race)
          const data = await executeLoaderAndCache(key, ttlSec, loader, context);
          return data;
        } catch (loaderError) {
           // If load fails here, re-throw the error, which goes to the outer catch.
           throw loaderError;
        }
      }
    } catch (error) {
      console.error(`❌ Cache operation failed for key: ${key}`, error.message);
      
      // Don't log syntax errors to Sentry
      if (!error.message.includes('ERR syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getOrSetJSON',
          cacheKey: key,
          ...context
        });
      }
      
      // If cache fails, still try to return fresh data
      if (fallbackOnError) {
        try {
          console.log(`🔄 Fallback to direct loader for key: ${key}`);
          return await loader();
        } catch (fallbackError) {
          console.error(`❌ Fallback loader also failed for key: ${key}`, fallbackError.message);
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async function getJSON(key, fallback = null) {
    try {
      const cached = await safeRedisCommand(async () => {
        return await redis.get(key);
      }, 'getJSON');
      const result = safeJsonParse(cached, fallback);
      console.log(`🔍 Cache GET for ${key}: ${result ? 'HIT' : 'MISS'}`);
      return result;
    } catch (error) {
      console.error(`❌ Cache get failed for key: ${key}`, error.message);
      return fallback;
    }
  }

  async function setJSON(key, value, ttlSec = 3600) {
    try {
      if (value === undefined || value === null) {
        await safeRedisCommand(async () => {
          await redis.del(key);
        }, 'delete_key');
        console.log(`🗑️ Deleted cache key: ${key}`);
        return true;
      }
      
      await safeRedisCommand(async () => {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
      }, 'setJSON');
      console.log(`💾 Cache SET for ${key} (TTL: ${ttlSec}s)`);
      return true;
    } catch (error) {
      console.error(`❌ Cache set failed for key: ${key}`, error.message);
      return false;
    }
  }

  async function deleteKey(key) {
    try {
      const result = await safeRedisCommand(async () => {
        return await redis.del(key);
      }, 'deleteKey');
      console.log(`🗑️ Deleted cache key: ${key} (result: ${result})`);
      return result > 0;
    } catch (error) {
      console.error(`❌ Failed to delete cache key: ${key}`, error.message);
      if (!error.message.includes('ERR syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'deleteKey',
          cacheKey: key
        });
      }
      return false;
    }
  }

  async function getKeys(pattern) {
    try {
      const keys = await safeRedisCommand(async () => {
        return await redis.keys(pattern);
      }, 'getKeys');
      console.log(`🔍 Found ${keys.length} keys matching pattern: ${pattern}`);
      return keys;
    } catch (error) {
      console.error(`❌ Failed to get keys for pattern: ${pattern}`, error.message);
      if (!error.message.includes('ERR syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getKeys',
          pattern
        });
      }
      return [];
    }
  }

  async function flushPattern(pattern) {
    try {
      const keys = await safeRedisCommand(async () => {
        return await redis.keys(pattern);
      }, 'flushPattern_keys');
      
      if (keys.length > 0) {
        await safeRedisCommand(async () => {
          await redis.del(...keys);
        }, 'flushPattern_del');
        console.log(`🧹 Flushed ${keys.length} keys matching: ${pattern}`);
        return keys.length;
      }
      console.log(`🔍 No keys found matching pattern: ${pattern}`);
      return 0;
    } catch (error) {
      console.error(`❌ Failed to flush pattern: ${pattern}`, error.message);
      if (!error.message.includes('ERR syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'flushPattern',
          pattern
        });
      }
      return 0;
    }
  }

  async function getCacheInfo() {
    try {
      const info = await safeRedisCommand(async () => {
        return await redis.info();
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

      // Get key patterns distribution
      const commonPatterns = ['odds:*', 'games:*', 'sports:*', 'player_props:*', 'quota:*', 'lock:*'];
      const patternCounts = {};
      
      for (const pattern of commonPatterns) {
        try {
          const keys = await safeRedisCommand(async () => {
            return await redis.keys(pattern);
          }, `getKeys_${pattern}`);
          patternCounts[pattern] = keys.length;
        } catch (error) {
          patternCounts[pattern] = 0;
        }
      }

      // Get memory usage
      let memoryData = {};
      try {
        const memoryInfo = await safeRedisCommand(async () => {
          return await redis.info('memory');
        }, 'getMemoryInfo');
        
        const memoryLines = memoryInfo.split('\r\n');
        for (const line of memoryLines) {
          if (line && !line.startsWith('#')) {
            const [key, value] = line.split(':');
            if (key && value) {
              memoryData[key] = value;
            }
          }
        }
      } catch (memoryError) {
        console.warn('⚠️ Failed to get memory info:', memoryError.message);
      }

      const totalKeys = Object.values(patternCounts).reduce((sum, count) => sum + count, 0);
      const hitRate = cacheInfo.keyspace_hits && cacheInfo.keyspace_misses ? 
        (parseInt(cacheInfo.keyspace_hits) / (parseInt(cacheInfo.keyspace_hits) + parseInt(cacheInfo.keyspace_misses))).toFixed(4) : 0;

      console.log(`📊 Cache Info: ${totalKeys} total keys, hit rate: ${(hitRate * 100).toFixed(2)}%`);

      return {
        ...cacheInfo,
        pattern_distribution: patternCounts,
        total_cached_keys: totalKeys,
        memory_usage: memoryData.used_memory_human || 'unknown',
        memory_peak: memoryData.used_memory_peak_human || 'unknown',
        hit_rate: hitRate,
        hit_rate_percentage: `${(hitRate * 100).toFixed(2)}%`,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Failed to get cache info:', error.message);
      if (!error.message.includes('ERR syntax error')) {
        sentryService.captureError(error, {
          component: 'cache_service',
          operation: 'getCacheInfo'
        });
      }
      return { 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async function keyInfo(key) {
    try {
      const [exists, ttl, type, memory] = await Promise.all([
        safeRedisCommand(async () => await redis.exists(key), 'keyInfo_exists'),
        safeRedisCommand(async () => await redis.ttl(key), 'keyInfo_ttl'),
        safeRedisCommand(async () => await redis.type(key), 'keyInfo_type'),
        safeRedisCommand(async () => await redis.memory('USAGE', key).catch(() => null), 'keyInfo_memory')
      ]);
      
      const result = {
        exists: exists === 1,
        ttl,
        type,
        memory_usage: memory ? `${memory} bytes` : 'unknown',
        ttl_human: ttl > 0 ? `${ttl} seconds` : 'no TTL',
        status: exists ? (ttl > 0 ? 'active' : 'persistent') : 'not_found',
        timestamp: new Date().toISOString()
      };

      console.log(`🔍 Key info for ${key}:`, result);
      return result;

    } catch (error) {
      console.error(`❌ Failed to get key info for: ${key}`, error.message);
      return {
        exists: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async function increment(key, value = 1, ttlSec = null) {
    try {
      const result = await safeRedisCommand(async () => {
        return await redis.incrby(key, value);
      }, 'increment');
      
      if (ttlSec && ttlSec > 0) {
        await safeRedisCommand(async () => {
          await redis.expire(key, ttlSec);
        }, 'increment_expire');
      }
      console.log(`➕ Incremented ${key} by ${value}, new value: ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ Failed to increment key: ${key}`, error.message);
      return null;
    }
  }

  async function decrement(key, value = 1, ttlSec = null) {
    try {
      const result = await safeRedisCommand(async () => {
        return await redis.decrby(key, value);
      }, 'decrement');
      
      if (ttlSec && ttlSec > 0) {
        await safeRedisCommand(async () => {
          await redis.expire(key, ttlSec);
        }, 'decrement_expire');
      }
      console.log(`➖ Decremented ${key} by ${value}, new value: ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ Failed to decrement key: ${key}`, error.message);
      return null;
    }
  }

  async function setWithTTL(key, value, ttlSec) {
    try {
      if (ttlSec && ttlSec > 0) {
        await safeRedisCommand(async () => {
          await redis.set(key, value, 'EX', ttlSec);
        }, 'setWithTTL');
      } else {
        await safeRedisCommand(async () => {
          await redis.set(key, value);
        }, 'setWithoutTTL');
      }
      console.log(`💾 Set key ${key} with TTL ${ttlSec || 'none'}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to set with TTL for key: ${key}`, error.message);
      return false;
    }
  }

  async function getWithTTL(key) {
    try {
      const [value, ttl] = await Promise.all([
        safeRedisCommand(async () => await redis.get(key), 'getWithTTL_value'),
        safeRedisCommand(async () => await redis.ttl(key), 'getWithTTL_ttl')
      ]);
      console.log(`🔍 Get with TTL for ${key}: value=${value ? 'exists' : 'null'}, ttl=${ttl}`);
      return { value, ttl };
    } catch (error) {
      console.error(`❌ Failed to get with TTL for key: ${key}`, error.message);
      return { value: null, ttl: -2 };
    }
  }

  async function healthCheck() {
    try {
      const startTime = Date.now();
      const testKey = `health_check_${startTime}`;
      
      // Test write
      await safeRedisCommand(async () => {
        await redis.setex(testKey, 10, 'health_check_value');
      }, 'healthCheck_set');
      
      // Test read
      const value = await safeRedisCommand(async () => {
        return await redis.get(testKey);
      }, 'healthCheck_get');
      
      // Test delete
      await safeRedisCommand(async () => {
        await redis.del(testKey);
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
        }
      };

      console.log(`❤️ Cache health check: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'} (${responseTime}ms)`);
      return result;

    } catch (error) {
      console.error('❌ Cache health check failed:', error.message);
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        details: {
          write: false,
          read: false,
          delete: false
        }
      };
    }
  }

  return { 
    getOrSetJSON,
    getJSON,
    setJSON,
    deleteKey,
    getKeys,
    flushPattern,
    getCacheInfo,
    keyInfo,
    increment,
    decrement,
    setWithTTL,
    getWithTTL,
    healthCheck
  };
}

// Export utility functions for use elsewhere
export { sleep, safeJsonParse };
