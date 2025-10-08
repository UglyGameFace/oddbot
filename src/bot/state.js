// src/bot/state.js - COMPLETE ABSOLUTE FIXED VERSION (Fixing SET command syntax)
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { getRedisClient } from '../services/redisService.js';
import databaseService from '../services/databaseService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';

const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;
const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, f) => { try { return JSON.parse(s); } catch (e) { sentryService.captureError(e, { component: 'state', op: 'parse' }); return f; } };

// CRITICAL FIX: Correct the command syntax for set with TTL.
const setWithTTL = async (c, k, v, ttl) => {
  if (!c) return;
  if (!ttl) return c.set(k, v);
  // FIX APPLIED: Removed the duplicate 'v' argument to match SET key value EX seconds syntax.
  return c.set(k, v, 'EX', ttl); 
};

// --- CORE REDIS STATE FUNCTIONS ---

export async function setUserState(chatId, state, ttl = 3600) {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await withTimeout(setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state), ttl), 3000, 'setUserState');

  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ setUserState CRITICAL error:', error.message);
      throw error; // Re-throw critical Redis errors
    }
  }
}

export async function getUserState(chatId) {
  try {
    const redis = await getRedisClient();
    if (!redis) return {};
    const data = await withTimeout(redis.get(`${STATE_PREFIX}${chatId}`), 3000, 'getUserState');
    return data ? safeParse(data, {}) : {};
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ getUserState CRITICAL error:', error.message);
      throw error; // Re-throw critical Redis errors
    }
    return {}; // Return empty state only on timeout or if Redis is unavailable
  }
}

export async function getParlaySlip(chatId) {
  try {
    const redis = await getRedisClient();
    if (!redis) return { ...DEFAULT_SLIP };
    const data = await withTimeout(redis.get(`${SLIP_PREFIX}${chatId}`), 3000, 'getParlaySlip');
    return data ? safeParse(data, { ...DEFAULT_SLIP }) : { ...DEFAULT_SLIP };
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ getParlaySlip CRITICAL error:', error.message);
      throw error; // Re-throw critical Redis errors
    }
    return { ...DEFAULT_SLIP }; // Return default slip only on timeout or if Redis is unavailable
  }
}

export async function setParlaySlip(chatId, slip) {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await withTimeout(setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip), 86400), 3000, 'setParlaySlip');
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ setParlaySlip CRITICAL error:', error.message);
      throw error; // Re-throw critical Redis errors
    }
  }
}

// --- CONFIGURATION MANAGEMENT ---

async function getConfig(telegramId, type) {
    // databaseService.getUserSettings will throw if the database is critically down,
    // which is the intended behavior to fail the health check.
    const settings = await databaseService.getUserSettings(telegramId);
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
            fallbackOnNoGames: true
        },
        builder: { 
            minOdds: -200, 
            maxOdds: 500, 
            avoidSameGame: true, 
            cutoffHours: 48,
            excludedTeams: [],
            requireVerifiedGames: true
        },
    };
    return { ...defaults[type], ...(settings[type] || {}) };
}

async function setConfig(telegramId, type, newConfigData) {
    // databaseService.getUserSettings/updateUserSettings will throw if the database is critically down,
    // which is the intended behavior to fail the health check.
    const currentSettings = await databaseService.getUserSettings(telegramId);
    const updatedSettings = JSON.parse(JSON.stringify(currentSettings));

    if (!updatedSettings[type]) {
        updatedSettings[type] = {};
    }

    Object.assign(updatedSettings[type], newConfigData);

    await databaseService.updateUserSettings(telegramId, updatedSettings);
}

export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);

export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);

// --- OTHER STATE MANAGEMENT FUNCTIONS ---

export async function setValidationState(chatId, sportKey, validationData) {
  const state = await getUserState(chatId);
  state.validation = {
    sportKey,
    lastValidation: new Date().toISOString(),
    ...validationData
  };
  // getUserState handles errors, but setUserState can still fail
  await setUserState(chatId, state);
}

export async function getValidationState(chatId) {
  const state = await getUserState(chatId);
  return state.validation || null;
}

const tokenPrefix = `${PREFIX}token:`;
export async function saveToken(type, payload, ttl = 600) {
  try {
    const redis = await getRedisClient();
    if (!redis) return null;
    const tok = `${type}_${Math.random().toString(36).slice(2, 10)}`;
    await withTimeout(setWithTTL(redis, `${tokenPrefix}${tok}`, JSON.stringify(payload), ttl), 3000, 'saveToken');
    return tok;
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ saveToken CRITICAL error:', error.message);
      throw error;
    }
    return null;
  }
}

export async function loadToken(type, tok) {
  try {
    const redis = await getRedisClient();
    if (!redis || !tok?.startsWith(`${type}_`)) return null;
    const key = `${tokenPrefix}${tok}`;
    const data = await withTimeout(redis.get(key), 3000, 'loadToken.get');
    // Deliberately do not wait for DEL, or wrap it in a catch, as deletion failure is non-critical.
    redis.del(key).catch((e) => console.warn(`Token deletion failed for ${key}: ${e.message}`)); 
    return data ? safeParse(data, null) : null;
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ loadToken CRITICAL error:', error.message);
      throw error;
    }
    return null;
  }


}


export async function clearUserState(chatId) {
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    await Promise.all([
      redis.del(`${STATE_PREFIX}${chatId}`).catch(() => {}),
      redis.del(`${SLIP_PREFIX}${chatId}`).catch(() => {})
    ]);
    return true;
  } catch (error) {
    console.error('Error clearing user state:', error);
    return false;
  }
}

export async function getUserActivityStats(telegramId) {
  try {
    const user = await databaseService.findOrCreateUser(telegramId);
    // getUserState handles its own critical errors by returning {}.
    const state = await getUserState(telegramId); 
    
    return {
      user_id: telegramId,
      preferences: user?.preferences || {},
      active_state: Boolean(state && Object.keys(state).length > 0),
      last_active: user?.preferences?.last_active,
      parlay_count: user?.preferences?.parlay_count || 0,
      state_keys: state ? Object.keys(state) : []
    };
  } catch (error) {
    console.error('Error getting user activity stats:', error);
    throw error;
  }
}

export async function hasActiveAISession(chatId) {
  const state = await getUserState(chatId);
  return !!(state?.sportKey && state?.numLegs);
}

export async function getAllActiveSessions() {
  try {
    const redis = await getRedisClient();
    if (!redis) return [];
    
    // NOTE: This .keys() operation can be slow on large Redis instances, 
    // but the error handling is now correct.
    const keys = await withTimeout(redis.keys(`${STATE_PREFIX}*`), 5000, 'getAllActiveKeys');
    
    const sessions = [];
    for (const key of keys) {
      const chatId = key.replace(STATE_PREFIX, '');
      const state = await getUserState(chatId);
      if (state && Object.keys(state).length > 0) {
        sessions.push({
          chatId,
          state,
          keyCount: Object.keys(state).length
        });
      }
    }
    
    return sessions;
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      console.error('❌ getAllActiveSessions CRITICAL error:', error);
      throw error;
    }
    return [];
  }
}
