// src/bot/state.js

import redisClient from '../services/redisService.js';

const STATE_PREFIX = 'user:state:';
const SLIP_PREFIX = 'parlay:slip:';
const CONFIG_PREFIX = 'user:config:';

// --- Core State Management ---

export async function setUserState(chatId, state, ttl = 3600) {
  const redis = await redisClient;
  const key = `${STATE_PREFIX}${chatId}`;
  await redis.set(key, JSON.stringify(state), 'EX', ttl);
}

export async function getUserState(chatId) {
  const redis = await redisClient;
  const key = `${STATE_PREFIX}${chatId}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : {};
}

// --- Parlay Slip Management ---

export async function getParlaySlip(chatId) {
  const redis = await redisClient;
  const key = `${SLIP_PREFIX}${chatId}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : { picks: [], stake: 10, totalOdds: 0, messageId: null };
}

export async function setParlaySlip(chatId, slip) {
  const redis = await redisClient;
  const key = `${SLIP_PREFIX}${chatId}`;
  await redis.set(key, JSON.stringify(slip), 'EX', 86400); // 24-hour TTL for slips
}

// --- User Configuration Management ---

async function getConfig(chatId, configType) {
    const redis = await redisClient;
    const key = `${CONFIG_PREFIX}${configType}:${chatId}`;
    const data = await redis.get(key);
    if (data) return JSON.parse(data);
    
    // Return default configurations
    if (configType === 'ai') return { legs: 2, strategy: 'balanced', includeProps: true, sports: [] };
    if (configType === 'builder') return { minOdds: -500, maxOdds: 500, avoidSameGame: true, cutoffHours: 48 };
    return {};
}

async function setConfig(chatId, configType, config) {
    const redis = await redisClient;
    const key = `${CONFIG_PREFIX}${configType}:${chatId}`;
    await redis.set(key, JSON.stringify(config)); // Persist configs without TTL
}

export const getAIConfig = (chatId) => getConfig(chatId, 'ai');
export const setAIConfig = (chatId, config) => setConfig(chatId, 'ai', config);
export const getBuilderConfig = (chatId) => getConfig(chatId, 'builder');
export const setBuilderConfig = (chatId, config) => setConfig(chatId, 'builder', config);


// --- Token Management for Callbacks (No change needed here) ---
const tokenPrefix = 'token:';
export async function saveToken(type, payload, ttl = 600) {
  const redis = await redisClient;
  const tok = `${type}_${Math.random().toString(36).substring(2, 10)}`;
  await redis.set(`${tokenPrefix}${tok}`, JSON.stringify(payload), 'EX', ttl);
  return tok;
}
export async function loadToken(type, tok) {
  const redis = await redisClient;
  if (!tok.startsWith(`${type}_`)) return null;
  const key = `${tokenPrefix}${tok}`;
  const data = await redis.get(key);
  await redis.del(key);
  return data ? JSON.parse(data) : null;
}
