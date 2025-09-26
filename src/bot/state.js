// src/bot/state.js
import crypto from 'crypto';
import redis from '../services/redisService.js';

const AI_DEFAULT = { legs: 3, strategy: 'balanced', includeProps: true, sports: [] };
const BUILDER_DEFAULT = { avoidSameGame: true, cutoffHours: 24, minOdds: -2000, maxOdds: 1000, excludedTeams: [] };

export async function getAIConfig(chatId) {
  const s = await redis.get(`cfg:ai:${chatId}`);
  return s ? JSON.parse(s) : { ...AI_DEFAULT };
}
export async function setAIConfig(chatId, cfg) {
  await redis.set(`cfg:ai:${chatId}`, JSON.stringify(cfg), 'EX', 3600);
}

export async function getBuilderConfig(chatId) {
  const s = await redis.get(`cfg:builder:${chatId}`);
  return s ? JSON.parse(s) : { ...BUILDER_DEFAULT };
}
export async function setBuilderConfig(chatId, cfg) {
  await redis.set(`cfg:builder:${chatId}`, JSON.stringify(cfg), 'EX', 86400);
}

export async function getParlaySlip(chatId) {
  const s = await redis.get(`slip:${chatId}`);
  if (!s) return { picks: [], stake: 10, messageId: null, totalOdds: 0 };
  try { return JSON.parse(s); } catch { return { picks: [], stake: 10, messageId: null, totalOdds: 0 }; }
}
export async function setParlaySlip(chatId, slip) {
  await redis.set(`slip:${chatId}`, JSON.stringify(slip), 'EX', 7200);
}

export async function getUserState(chatId) {
  return (await redis.get(`user:state:${chatId}`)) || 'none';
}
export async function setUserState(chatId, state, ttl = 300) {
  await redis.set(`user:state:${chatId}`, state, 'EX', ttl);
}

// Compact callback payload tokens (keep callback_data <= 64 bytes)
export async function saveToken(ns, payload, ttl = 900) {
  const tok = crypto.randomBytes(9).toString('base64url');
  await redis.set(`cb:${ns}:${tok}`, JSON.stringify(payload), 'EX', ttl);
  return tok;
}
export async function loadToken(ns, tok, del = true) {
  const key = `cb:${ns}:${tok}`;
  const raw = await redis.get(key);
  if (del) await redis.del(key);
  return raw ? JSON.parse(raw) : null;
}
