// src/services/cacheService.js - COMPLETE FIXED VERSION
import { sentryService } from './sentryService.js';

export default function makeCache(redis) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function getOrSetJSON(key, ttlSec, loader, { 
    lockMs = 8000, 
    retryMs = 150,
    context = {} 
  } = {}) {
    
    try {
      const cached = await redis.get(key);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch (parseError) {
          console.warn(`❌ Failed to parse cached JSON for key: ${key}`, parseError);
          // If cached data is corrupt, continue to refresh it
        }
      }

      const lockKey = `lock:${key}`;
      const gotLock = await redis.set(lockKey, '1', { NX: true, PX: lockMs });

      if (gotLock) {
        try {
          const data = await loader();
          if (data !== undefined && data !== null) {
            await redis.set(key, JSON.stringify(data), { EX: ttlSec });
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
          throw loaderError; // Re-throw to let caller handle
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
            try {
              return JSON.parse(again);
            } catch (parseError) {
              console.warn(`❌ Failed to parse cached JSON during retry for key: ${key}`);
              break; // Break out of retry loop if data is corrupt
            }
          }
        }
        
        // If we get here, either deadline passed or data was corrupt
        // Compute the data ourselves
        const data = await loader();
        if (data !== undefined && data !== null) {
          await redis.set(key, JSON.stringify(data), { EX: ttlSec });
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
      try {
        return await loader();
      } catch (fallbackError) {
        console.error(`❌ Fallback loader also failed for key: ${key}`, fallbackError);
        throw fallbackError;
      }
    }
  }

  // Additional cache utility methods
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

  // Get cache information and statistics
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

      // Get some key patterns to show cache distribution
      const commonPatterns = ['odds:*', 'games:*', 'sports:*', 'player_props:*', 'quota:*'];
      const patternCounts = {};
      
      for (const pattern of commonPatterns) {
        const keys = await redis.keys(pattern);
        patternCounts[pattern] = keys.length;
      }

      return {
        ...cacheInfo,
        pattern_distribution: patternCounts,
        total_cached_keys: Object.values(patternCounts).reduce((sum, count) => sum + count, 0)
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

  // Check if a key exists and get TTL
  async function keyInfo(key) {
    try {
      const [exists, ttl] = await Promise.all([
        redis.exists(key),
        redis.ttl(key)
      ]);
      
      return {
        exists: exists === 1,
        ttl,
        ttl_human: ttl > 0 ? `${ttl} seconds` : 'no TTL'
      };
    } catch (error) {
      console.error(`❌ Failed to get key info for: ${key}`, error);
      return {
        exists: false,
        error: error.message
      };
    }
  }

  return { 
    getOrSetJSON,
    deleteKey,
    getKeys,
    flushPattern,
    getCacheInfo,
    keyInfo
  };
}
