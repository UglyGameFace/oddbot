// src/bot/state.js - SIMPLIFIED PRODUCTION VERSION
import { redisService } from '../services/redisService.js';

const PREFIX = 'v1:prod:';

// SIMPLIFIED: One safe method for all Redis operations
async function safeRedisOperation(operation, fallback, context = 'redis_operation') {
  try {
    const client = await redisService.getClient();
    if (!client) return fallback;
    
    return await operation(client);
  } catch (error) {
    console.warn(`⚠️ Redis operation failed (${context}):`, error.message);
    return fallback;
  }
}

// SIMPLIFIED: Unified set function
async function setWithTTL(key, value, ttl = 3600) {
  return safeRedisOperation(async (client) => {
    if (ttl) {
      return await client.set(key, value, 'EX', ttl);
    }
    return await client.set(key, value);
  }, null, 'setWithTTL');
}

// SIMPLIFIED: Unified get function  
async function getAndParse(key, fallback = null) {
  return safeRedisOperation(async (client) => {
    const data = await client.get(key);
    if (!data) return fallback;
    
    try {
      return JSON.parse(data);
    } catch (e) {
      console.warn('❌ JSON parse failed for key:', key);
      return fallback;
    }
  }, fallback, 'getAndParse');
}

// State management - SIMPLIFIED
export async function setUserState(chatId, state, ttl = 3600) {
  return setWithTTL(`${PREFIX}user:state:${chatId}`, JSON.stringify(state), ttl);
}

export async function getUserState(chatId) {
  return getAndParse(`${PREFIX}user:state:${chatId}`, {});
}

export async function getParlaySlip(chatId) {
  return getAndParse(`${PREFIX}parlay:slip:${chatId}`, { picks: [], stake: 10, totalOdds: 0, messageId: null });
}

export async function setParlaySlip(chatId, slip) {
  return setWithTTL(`${PREFIX}parlay:slip:${chatId}`, JSON.stringify(slip), 86400);
}

// SIMPLIFIED: Token management
export async function saveToken(type, payload, ttl = 600) {
  const token = `${type}_${Math.random().toString(36).slice(2, 10)}`;
  const success = await setWithTTL(`${PREFIX}token:${token}`, JSON.stringify(payload), ttl);
  return success ? token : null;
}

export async function loadToken(type, token) {
  if (!token?.startsWith(`${type}_`)) return null;
  
  const result = await getAndParse(`${PREFIX}token:${token}`, null);
  
  // Fire and forget deletion
  if (result) {
    safeRedisOperation(async (client) => {
      await client.del(`${PREFIX}token:${token}`);
    }, null, 'deleteToken');
  }
  
  return result;
}

// SIMPLIFIED: Clear user state
export async function clearUserState(chatId) {
  return safeRedisOperation(async (client) => {
    await client.del(`${PREFIX}user:state:${chatId}`);
    await client.del(`${PREFIX}parlay:slip:${chatId}`);
    return true;
  }, false, 'clearUserState');
}

// Health check
export async function redisHealthCheck() {
  return safeRedisOperation(async (client) => {
    await client.ping();
    return true;
  }, false, 'healthCheck');
}
