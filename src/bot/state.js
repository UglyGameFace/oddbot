// src/bot/state.js - FIXED VERSION
import env from '../config/env.js';
import { getRedisClient } from '../services/redisService.js';

// Cache for in-memory fallback
const memoryCache = new Map();

// --- CORE CONFIGURATION MANAGEMENT ---

async function getConfig(telegramId, type) {
  const cacheKey = `memory:${telegramId}:${type}`;

  console.log(`🔧 getConfig called: ${telegramId}, ${type}`);

  // Try Redis first
  try {
    const redis = await getRedisClient();
    if (redis) {
      const configKey = `user:config:${telegramId}:${type}`;
      const cachedConfig = await redis.get(configKey);

      if (cachedConfig) {
        console.log(`✅ Redis HIT for ${configKey}`);
        try {
          const parsed = JSON.parse(cachedConfig);
          // Update memory cache
          memoryCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
          return parsed;
        } catch (parseError) {
          console.error('❌ JSON parse error for cached config:', parseError);
          // Fall through to defaults
        }
      } else {
        console.log(`🔍 Redis MISS for ${configKey}`);
      }
    } else {
      console.warn('⚠️ Redis not available, using memory cache');
    }
  } catch (error) {
    console.warn('❌ Redis config fetch failed, trying memory:', error.message);
  }

  // Try memory cache
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached && Date.now() - memoryCached.timestamp < 30000) { // 30 second memory cache
    console.log(`✅ Memory HIT for ${cacheKey}`);
    return memoryCached.data;
  }

  // Default configurations
  console.log(`🔄 Using defaults for ${type}`);
  const defaults = {
    ai: {
      mode: 'web',
      model: 'perplexity',
      betType: 'mixed',
      horizonHours: 72,
      quantitativeMode: 'conservative',
      includeProps: false,
      proQuantMode: false,
      enforceRealGames: true,
      maxValidationTime: 10000,
      fallbackOnNoGames: true,
      bookmakers: ['draftkings', 'fanduel']
    },
    builder: {
      minOdds: -200,
      maxOdds: 500,
      avoidSameGame: true,
      cutoffHours: 48,
      excludedTeams: [],
      requireVerifiedGames: true
    }
  };

  const defaultConfig = { ...defaults[type] };
  // Cache in memory
  memoryCache.set(cacheKey, { data: defaultConfig, timestamp: Date.now() });

  return defaultConfig;
}

async function setConfig(telegramId, type, newConfigData) {
  console.log(`🔧 setConfig called: ${telegramId}, ${type}`, newConfigData);

  const cacheKey = `memory:${telegramId}:${type}`;

  try {
    // Update memory cache immediately
    memoryCache.set(cacheKey, { data: newConfigData, timestamp: Date.now() });

    // Try to save to Redis
    const redis = await getRedisClient();
    if (redis) {
      const configKey = `user:config:${telegramId}:${type}`;
      await redis.set(configKey, JSON.stringify(newConfigData), 'EX', 86400); // 24 hours
      console.log(`✅ Redis SET for ${configKey}`);

      // Verify the write
      const verify = await redis.get(configKey);
      if (verify) {
        console.log(`✅ Redis write verified for ${configKey}`);
      } else {
        console.warn(`⚠️ Redis write verification failed for ${configKey}`);
      }
    } else {
      console.warn('⚠️ Redis not available, using memory cache only');
    }

    return true;
  } catch (error) {
    console.error('❌ Config save failed:', error.message);
    // Still keep in memory cache
