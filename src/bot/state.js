// src/bot/state.js - FIXED VERSION (Complete)
import env from '../config/env.js';
import { getRedisClient } from '../services/redisService.js';
import StateManager from './stateManager.js'; // Import the default export

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
      // Ensure newConfigData is stringified before setting
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
    return false;
  }
}

// Export config functions directly
export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);

export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);

// Re-export state manager functions correctly bound to the instance
export const setUserState = StateManager.setUserState.bind(StateManager);
export const getUserState = StateManager.getUserState.bind(StateManager);
export const getParlaySlip = StateManager.getParlaySlip.bind(StateManager);
export const setParlaySlip = StateManager.setParlaySlip.bind(StateManager);
export const setValidationState = StateManager.setValidationState.bind(StateManager);
export const getValidationState = StateManager.getValidationState.bind(StateManager);
export const saveToken = StateManager.saveToken.bind(StateManager);
export const loadToken = StateManager.loadToken.bind(StateManager);
export const clearUserState = StateManager.clearUserState.bind(StateManager);
export const getUserActivityStats = StateManager.getUserActivityStats.bind(StateManager);
export const hasActiveAISession = StateManager.hasActiveAISession.bind(StateManager);
export const getAllActiveSessions = StateManager.getAllActiveSessions.bind(StateManager);

// ** FIX: Added the missing closing brace for the file scope **
