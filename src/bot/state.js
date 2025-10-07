// src/bot/state.js - COMPLETE FIXED VERSION
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { getRedisClient } from '../services/redisService.js';
import databaseService from '../services/databaseService.js';

const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;
const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, f) => { try { return JSON.parse(s); } catch (e) { sentryService.captureError(e, { component: 'state', op: 'parse' }); return f; } };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms: ${label}`)), ms))]);

const setWithTTL = async (c, k, v, ttl) => {
  if (!c) return;
  if (!ttl) return c.set(k, v);
  return c.set(k, v, 'EX', ttl);
};

export async function setUserState(chatId, state, ttl = 3600) {
  const redis = await getRedisClient();
  if (!redis) return;
  await withTimeout(setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state), ttl), 3000, 'setUserState');
}

export async function getUserState(chatId) {
  const redis = await getRedisClient();
  if (!redis) return {};
  const data = await withTimeout(redis.get(`${STATE_PREFIX}${chatId}`), 3000, 'getUserState');
  return data ? safeParse(data, {}) : {};
}

export async function getParlaySlip(chatId) {
  const redis = await getRedisClient();
  if (!redis) return { ...DEFAULT_SLIP };
  const data = await withTimeout(redis.get(`${SLIP_PREFIX}${chatId}`), 3000, 'getParlaySlip');
  return data ? safeParse(data, { ...DEFAULT_SLIP }) : { ...DEFAULT_SLIP };
}

export async function setParlaySlip(chatId, slip) {
  const redis = await getRedisClient();
  if (!redis) return;
  await withTimeout(setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip), 86400), 3000, 'setParlaySlip');
}

async function getConfig(telegramId, type) {
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

export async function setValidationState(chatId, sportKey, validationData) {
  const state = await getUserState(chatId);
  state.validation = {
    sportKey,
    lastValidation: new Date().toISOString(),
    ...validationData
  };
  await setUserState(chatId, state);
}

export async function getValidationState(chatId) {
  const state = await getUserState(chatId);
  return state.validation || null;
}

const tokenPrefix = `${PREFIX}token:`;
export async function saveToken(type, payload, ttl = 600) {
  const redis = await getRedisClient();
  if (!redis) return null;
  const tok = `${type}_${Math.random().toString(36).slice(2, 10)}`;
  await withTimeout(setWithTTL(redis, `${tokenPrefix}${tok}`, JSON.stringify(payload), ttl), 3000, 'saveToken');
  return tok;
}

export async function loadToken(type, tok) {
  const redis = await getRedisClient();
  if (!redis || !tok?.startsWith(`${type}_`)) return null;
  const key = `${tokenPrefix}${tok}`;
  const data = await withTimeout(redis.get(key), 3000, 'loadToken.get');
  await withTimeout(redis.del(key), 3000, 'loadToken.del');
  return data ? safeParse(data, null) : null;
}

export async function clearUserState(chatId) {
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    await Promise.all([
      redis.del(`${STATE_PREFIX}${chatId}`),
      redis.del(`${SLIP_PREFIX}${chatId}`)
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
    return null;
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
    const keys = await redis.keys(`${STATE_PREFIX}*`);
    
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
    console.error('Error getting active sessions:', error);
    return [];
  }
}
