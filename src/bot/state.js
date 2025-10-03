// src/bot/state.js - UPDATED WITH VALIDATION PREFERENCES
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import redisClient from '../services/redisService.js';
import databaseService from '../services/databaseService.js';

const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;
const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, f) => { try { return JSON.parse(s); } catch (e) { sentryService.captureError(e, { component: 'state', op: 'parse' }); return f; } };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms: ${label}`)), ms))]);

// --- VERIFIED FIX: Use older, more compatible Redis syntax for SET with TTL ---
const setWithTTL = async (c, k, v, ttl) => {
  if (!ttl) return c.set(k, v);
  // Use 'EX' flag in a flat list instead of an options object
  return c.set(k, v, 'EX', ttl);
};

// --- Conversational state (remains in Redis for speed) ---
export async function setUserState(chatId, state, ttl = 3600) {
  const redis = await redisClient;
  await withTimeout(setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state), ttl), 3000, 'setUserState');
}
export async function getUserState(chatId) {
  const redis = await redisClient;
  const data = await withTimeout(redis.get(`${STATE_PREFIX}${chatId}`), 3000, 'getUserState');
  return data ? safeParse(data, {}) : {};
}

// --- Parlay slips (remains in Redis as it's temporary) ---
export async function getParlaySlip(chatId) {
  const redis = await redisClient;
  const data = await withTimeout(redis.get(`${SLIP_PREFIX}${chatId}`), 3000, 'getParlaySlip');
  return data ? safeParse(data, { ...DEFAULT_SLIP }) : { ...DEFAULT_SLIP };
}
export async function setParlaySlip(chatId, slip) {
  const redis = await redisClient;
  await withTimeout(setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip), 86400), 3000, 'setParlaySlip');
}

// --- User Configs (MOVED TO DATABASE) ---
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
            // NEW: Validation preferences
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
            // NEW: Validation preferences  
            requireVerifiedGames: true
        },
    };
    // Return the specific config type, merged with defaults
    return { ...defaults[type], ...(settings[type] || {}) };
}

async function setConfig(telegramId, type, newConfigData) {
    const currentSettings = await databaseService.getUserSettings(telegramId);
    // Create a deep copy to avoid mutation issues if settings object is reused
    const updatedSettings = JSON.parse(JSON.stringify(currentSettings));

    // Ensure the config type object exists
    if (!updatedSettings[type]) {
        updatedSettings[type] = {};
    }

    // Merge new data into the specific config type
    Object.assign(updatedSettings[type], newConfigData);

    await databaseService.updateUserSettings(telegramId, updatedSettings);
}

export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);

export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);

// --- Validation-specific state management ---
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

// --- Tokens (unchanged, good use for Redis) ---
const tokenPrefix = `${PREFIX}token:`;
export async function saveToken(type, payload, ttl = 600) {
  const redis = await redisClient;
  const tok = `${type}_${Math.random().toString(36).slice(2, 10)}`;
  await withTimeout(setWithTTL(redis, `${tokenPrefix}${tok}`, JSON.stringify(payload), ttl), 3000, 'saveToken');
  return tok;
}
export async function loadToken(type, tok) {
  const redis = await redisClient;
  if (!tok?.startsWith(`${type}_`)) return null;
  const key = `${tokenPrefix}${tok}`;
  const data = await withTimeout(redis.get(key), 3000, 'loadToken.get');
  await withTimeout(redis.del(key), 3000, 'loadToken.del');
  return data ? safeParse(data, null) : null;
}
