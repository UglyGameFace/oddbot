// src/services/cacheService.js - ENHANCED VERSION
import { sentryService } from './sentryService.js';
import { sleep, safeJsonParse } from '../utils/asyncUtils.js';

export default function makeCache(redis) {
  const DEFAULT_LOCK_MS = 8000;
  const DEFAULT_RETRY_MS = 150;

  async function getOrSetJSON(key, ttlSec, loader, { 
    lockMs = DEFAULT_LOCK_MS, 
    retryMs = DEFAULT_RETRY_MS,
    context = {},
    fallbackOnError = true
  } = {}) {
    
    try {
      // Try to get cached data first
      const cached = await redis.get(key);
      if (cached) {
        try {
          const parsed = safeJsonParse(cached);
          if (parsed !== null) {
            return parsed;
          }
        } catch (parseError) {
          console.warn(`❌ Failed to parse cached JSON for key: ${key}`, parseError);
          // If cached data is corrupt, continue to refresh it
        }
      }

      const lockKey = `lock:${key}`;
      
      // Try to acquire lock
      const gotLock = await redis.set(lockKey, '1', 'PX', lockMs, 'NX');

      if (gotLock === 'OK') {
        try {
          const data = await loader();
          if (data !== undefined && data !== null) {
            await redis.set(key, JSON.stringify(data), 'EX', ttlSec);
          }
          return data;
        } catch (loaderError) {
          console.error(`❌ Loader failed for cache key: ${key}`, loaderError);
          sentryService.captureError(loaderError, {
            component: 'cache_service',
            operation: 'getOrSetJSON_loader',
            cacheKey: key,
            ...context
          });
          
          if (fallbackOnError && cached) {
            console.log('🔄 Using cached data despite loader error');
            return safeJsonParse(cached, null);
          }
          throw loaderError;
        } finally {
          await redis.del(lockKey).catch(delError => {
            console.warn(`⚠️ Failed to delete lock key: ${lockKey}`, delError);
          });
        }
      } else {
        // Wait for the lock holder to complete
        const deadline = Date.now() + lockMs;
        while (Date.now() < deadline) {
          await sleep(retryMs);
          const again = await redis.get(key);
          if (again) {
            const parsed = safeJsonParse(again);
            if (parsed !== null) {
              return parsed;
            }
            break;
          }
        }
        
        // If we get here, either deadline passed or data was corrupt
        const data = await loader();
        if (data !== undefined && data !== null) {
          await redis.set(key, JSON.stringify(data), 'EX', ttlSec);
        }
        return data;
      }
    } catch (error) {
      console.error(`❌ Cache operation failed for key: ${key}`, error);
      sentryService.captureError(error, {
        component: 'cache_service',
        operation: 'getOrSetJSON',
        cacheKey: key,
        ...context
      });
      
      // If cache fails, still try to return fresh data
      if (fallbackOnError) {
        try {
          return await loader();
        } catch (fallbackError) {
          console.error(`❌ Fallback loader also failed for key: ${key}`, fallbackError);
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async function getJSON(key, fallback = null) {
    try {
      const cached = await redis.get(key);
      return safeJsonParse(cached, fallback);
    } catch (error) {
      console.error(`❌ Cache get failed for key: ${key}`, error);
      return fallback;
    }
  }

  async function setJSON(key, value, ttlSec = 3600) {
    try {
      if (value === undefined || value === null) {
        await redis.del(key);
        return true;
      }
      await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
      return true;
    } catch (error) {
      console.error(`❌ Cache set failed for key: ${key}`, error);
      return false;
    }
  }

  async function deleteKey(key) {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error(`❌ Failed to delete cache key: ${key}`, error);
      sentryService.captureError(error, {
        component: 'cache_service',
        operation: 'deleteKey',
        cacheKey: key
      });
      return false;
    }
  }

  async function getKeys(pattern) {
    try {
      return await redis.keys(pattern);
    } catch (error) {
      console.error(`❌ Failed to get keys for pattern: ${pattern}`, error);
      sentryService.captureError(error, {
        component: 'cache_service',
        operation: 'getKeys',
        pattern
      });
      return [];
    }
  }

  async function flushPattern(pattern) {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`🧹 Flushed ${keys.length} keys matching: ${pattern}`);
        return keys.length;
      }
      return 0;
    } catch (error) {
      console.error(`❌ Failed to flush pattern: ${pattern}`, error);
      sentryService.captureError(error, {
        component: 'cache_service',
        operation: 'flushPattern',
        pattern
      });
      return 0;
    }
  }

  async function getCacheInfo() {
    try {
      const info = await redis.info();
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
        const keys = await redis.keys(pattern);
        patternCounts[pattern] = keys.length;
      }

      // Get memory usage
      const memoryInfo = await redis.info('memory');
      const memoryLines = memoryInfo.split('\r\n');
      const memoryData = {};
      for (const line of memoryLines) {
        if (line && !line.startsWith('#')) {
          const [key, value] = line.split(':');
          if (key && value) {
            memoryData[key] = value;
          }
        }
      }

      return {
        ...cacheInfo,
        pattern_distribution: patternCounts,
        total_cached_keys: Object.values(patternCounts).reduce((sum, count) => sum + count, 0),
        memory_usage: memoryData.used_memory_human || 'unknown',
        memory_peak: memoryData.used_memory_peak_human || 'unknown',
        hit_rate: cacheInfo.keyspace_hits && cacheInfo.keyspace_misses ? 
          (parseInt(cacheInfo.keyspace_hits) / (parseInt(cacheInfo.keyspace_hits) + parseInt(cacheInfo.keyspace_misses))).toFixed(4) : 0
      };
    } catch (error) {
      console.error('❌ Failed to get cache info:', error);
      sentryService.captureError(error, {
        component: 'cache_service',
        operation: 'getCacheInfo'
      });
      return { error: error.message };
    }
  }

  async function keyInfo(key) {
    try {
      const [exists, ttl, type, memory] = await Promise.all([
        redis.exists(key),
        redis.ttl(key),
        redis.type(key),
        redis.memory('USAGE', key).catch(() => null)
      ]);
      
      return {
        exists: exists === 1,
        ttl,
        type,
        memory_usage: memory ? `${memory} bytes` : 'unknown',
        ttl_human: ttl > 0 ? `${ttl} seconds` : 'no TTL',
        status: exists ? (ttl > 0 ? 'active' : 'persistent') : 'not_found'
      };
    } catch (error) {
      console.error(`❌ Failed to get key info for: ${key}`, error);
      return {
        exists: false,
        error: error.message
      };
    }
  }

  async function increment(key, value = 1, ttlSec = null) {
    try {
      const result = await redis.incrby(key, value);
      if (ttlSec && ttlSec > 0) {
        await redis.expire(key, ttlSec);
      }
      return result;
    } catch (error) {
      console.error(`❌ Failed to increment key: ${key}`, error);
      return null;
    }
  }

  async function decrement(key, value = 1, ttlSec = null) {
    try {
      const result = await redis.decrby(key, value);
      if (ttlSec && ttlSec > 0) {
        await redis.expire(key, ttlSec);
      }
      return result;
    } catch (error) {
      console.error(`❌ Failed to decrement key: ${key}`, error);
      return null;
    }
  }

  async function setWithTTL(key, value, ttlSec) {
    try {
      if (ttlSec && ttlSec > 0) {
        await redis.set(key, value, 'EX', ttlSec);
      } else {
        await redis.set(key, value);
      }
      return true;
    } catch (error) {
      console.error(`❌ Failed to set with TTL for key: ${key}`, error);
      return false;
    }
  }

  async function getWithTTL(key) {
    try {
      const [value, ttl] = await Promise.all([
        redis.get(key),
        redis.ttl(key)
      ]);
      return { value, ttl };
    } catch (error) {
      console.error(`❌ Failed to get with TTL for key: ${key}`, error);
      return { value: null, ttl: -2 };
    }
  }

  async function healthCheck() {
    try {
      const startTime = Date.now();
      const testKey = `health_check_${startTime}`;
      
      // Test write
      await redis.setex(testKey, 10, 'health_check_value');
      
      // Test read
      const value = await redis.get(testKey);
      
      // Test delete
      await redis.del(testKey);
      
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: value === 'health_check_value',
        response_time: responseTime,
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
