// src/bot/state.js
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import redisClient from '../services/redisService.js';

const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;
const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const CONFIG_PREFIX = `${PREFIX}user:config:`;
const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, f) => { try { return JSON.parse(s); } catch (e) { sentryService.captureError(e, { component: 'state', op: 'parse' }); return f; } };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms: ${label}`)), ms))]);
const setWithTTL = async (c, k, v, ttl) => { if (!ttl) return c.set(k, v); try { return await c.set(k, v, { EX: ttl }); } catch { return await c.set(k, v, 'EX', ttl); } };

export async function setUserState(chatId, state, ttl = 3600) {
  const redis = await redisClient;
  await withTimeout(setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state), ttl), 3000, 'setUserState');
}
export async function getUserState(chatId) {
  const redis = await redisClient;
  const data = await withTimeout(redis.get(`${STATE_PREFIX}${chatId}`), 3000, 'getUserState');
  return data ? safeParse(data, {}) : {};
}

export async function getParlaySlip(chatId) {
  const redis = await redisClient;
  const data = await withTimeout(redis.get(`${SLIP_PREFIX}${chatId}`), 3000, 'getParlaySlip');
  return data ? safeParse(data, { ...DEFAULT_SLIP }) : { ...DEFAULT_SLIP };
}
export async function setParlaySlip(chatId, slip) {
  const redis = await redisClient;
  await withTimeout(setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip), 86400), 3000, 'setParlaySlip');
}

async function getConfig(chatId, type) {
  const redis = await redisClient;
  const data = await withTimeout(redis.get(`${CONFIG_PREFIX}${type}:${chatId}`), 3000, 'getConfig');
  if (data) return safeParse(data, {});
  if (type === 'ai') return { legs: 2, strategy: 'balanced', includeProps: true, sports: [] };
  if (type === 'builder') return { minOdds: -500, maxOdds: 500, avoidSameGame: true, cutoffHours: 48 };
  return {};
}
async function setConfig(chatId, type, cfg) {
  const redis = await redisClient;
  await withTimeout(redis.set(`${CONFIG_PREFIX}${type}:${chatId}`, JSON.stringify(cfg)), 3000, 'setConfig');
}
export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);
export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);

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
