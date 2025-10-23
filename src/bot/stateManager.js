// src/bot/stateManager.js

import { getRedisClient } from '../services/redisService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
import databaseService from '../services/databaseService.js';

// Namespace/versioning for keys that this file generates internally.
// NOTE: The generic get/set/delete below DO NOT add this prefix — they use the exact key provided.
// Your state.js already builds keys like "user:state:<chatId>", so those will be stored exactly as passed.
const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;

const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const TOKEN_PREFIX = `${PREFIX}token:`;

const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, fallback) => {
  try {
    if (s === null || s === undefined) return fallback;
    return JSON.parse(s);
  } catch (e) {
    try {
      sentryService.captureError(e, { component: 'stateManager', op: 'parse' });
    } catch {}
    return fallback;
  }
};

const setWithTTL = async (client, key, value, ttlSeconds) => {
  if (!client) return;
  if (!ttlSeconds || ttlSeconds <= 0) {
    return client.set(key, value);
  }
  // EX ttl in seconds
  return client.set(key, value, 'EX', ttlSeconds);
};

export class StateManager {
  async getRedis() {
    return getRedisClient();
  }

  // ---------- Generic KV required by state.js ----------

  /**
   * Get a value by exact key.
   * Attempts JSON.parse; if parsing fails, returns the raw string.
   */
  async get(key) {
    try {
      if (!key) return null;
      const redis = await this.getRedis();
      if (!redis) return null;
      const raw = await withTimeout(redis.get(key), 3000, 'stateManager.get');
      if (raw === null || raw === undefined) return null;
      // Try JSON parse; if fails, return raw
      const parsed = safeParse(raw, Symbol.for('RAW_FALLBACK'));
      return parsed === Symbol.for('RAW_FALLBACK') ? raw : parsed;
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('[StateManager] get error:', { key, error: error?.message || error });
        try {
          sentryService.captureError(error, { component: 'stateManager', op: 'get', key });
        } catch {}
      }
      return null;
    }
  }

  /**
   * Set value by exact key, JSON-serializing objects, with optional TTL seconds.
   */
  async set(key, value, ttlSeconds = null) {
    try {
      if (!key) return false;
      const redis = await this.getRedis();
      if (!redis) return false;
      const payload = typeof value === 'string' ? value : JSON.stringify(value);
      await withTimeout(setWithTTL(redis, key, payload, ttlSeconds), 3000, 'stateManager.set');
      return true;
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('[StateManager] set error:', { key, error: error?.message || error });
        try {
          sentryService.captureError(error, { component: 'stateManager', op: 'set', key });
        } catch {}
      }
      return false;
    }
  }

  /**
   * Delete value by exact key.
   */
  async delete(key) {
    try {
      if (!key) return false;
      const redis = await this.getRedis();
      if (!redis) return false;
      const res = await withTimeout(redis.del(key), 3000, 'stateManager.delete');
      return !!res;
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('[StateManager] delete error:', { key, error: error?.message || error });
        try {
          sentryService.captureError(error, { component: 'stateManager', op: 'delete', key });
        } catch {}
      }
      return false;
    }
  }

  // ---------- High-level helpers (kept intact) ----------

  async setUserState(chatId, state, ttl = 3600) {
    try {
      const redis = await this.getRedis();
      if (!redis) return;
      await withTimeout(
        setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state || {}), ttl),
        3000,
        'setUserState'
      );
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ setUserState CRITICAL error:', error?.message || error);
        throw error;
      }
    }
  }

  async getUserState(chatId) {
    try {
      const redis = await this.getRedis();
      if (!redis) return {};
      const data = await withTimeout(redis.get(`${STATE_PREFIX}${chatId}`), 3000, 'getUserState');
      return data ? safeParse(data, {}) : {};
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ getUserState CRITICAL error:', error?.message || error);
        throw error;
      }
      return {};
    }
  }

  async getParlaySlip(chatId) {
    try {
      const redis = await this.getRedis();
      if (!redis) return { ...DEFAULT_SLIP };
      const data = await withTimeout(redis.get(`${SLIP_PREFIX}${chatId}`), 3000, 'getParlaySlip');
      return data ? safeParse(data, { ...DEFAULT_SLIP }) : { ...DEFAULT_SLIP };
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ getParlaySlip CRITICAL error:', error?.message || error);
        throw error;
      }
      return { ...DEFAULT_SLIP };
    }
  }

  async setParlaySlip(chatId, slip) {
    try {
      const redis = await this.getRedis();
      if (!redis) return;
      await withTimeout(
        setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip || { ...DEFAULT_SLIP }), 86400),
        3000,
        'setParlaySlip'
      );
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ setParlaySlip CRITICAL error:', error?.message || error);
        throw error;
      }
    }
  }

  async setValidationState(chatId, sportKey, validationData) {
    const state = await this.getUserState(chatId);
    state.validation = {
      sportKey,
      lastValidation: new Date().toISOString(),
      ...(validationData || {})
    };
    await this.setUserState(chatId, state);
  }

  async getValidationState(chatId) {
    const state = await this.getUserState(chatId);
    return state.validation || null;
  }

  async saveToken(type, payload, ttl = 600) {
    try {
      const redis = await this.getRedis();
      if (!redis) return null;
      const tok = `${type}_${Math.random().toString(36).slice(2, 10)}`;
      await withTimeout(
        setWithTTL(redis, `${TOKEN_PREFIX}${tok}`, JSON.stringify(payload ?? {}), ttl),
        3000,
        'saveToken'
      );
      return tok;
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ saveToken CRITICAL error:', error?.message || error);
        throw error;
      }
      return null;
    }
  }

  async loadToken(type, tok) {
    try {
      const redis = await this.getRedis();
      if (!redis || !tok?.startsWith(`${type}_`)) return null;
      const key = `${TOKEN_PREFIX}${tok}`;
      const data = await withTimeout(redis.get(key), 3000, 'loadToken.get');
      // Best-effort cleanup; do not block on it
      redis.del(key).catch((e) => console.warn(`Token deletion failed for ${key}: ${e?.message || e}`));
      return data ? safeParse(data, null) : null;
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ loadToken CRITICAL error:', error?.message || error);
        throw error;
      }
      return null;
    }
  }

  async clearUserState(chatId) {
    try {
      const redis = await this.getRedis();
      if (!redis) return false;
      await Promise.all([
        redis.del(`${STATE_PREFIX}${chatId}`).catch(() => {}),
        redis.del(`${SLIP_PREFIX}${chatId}`).catch(() => {})
      ]);
      return true;
    } catch (error) {
      console.error('Error clearing user state:', error?.message || error);
      return false;
    }
  }

  async getUserActivityStats(telegramId) {
    try {
      const user = await databaseService.findOrCreateUser(telegramId);
      const state = await this.getUserState(telegramId);
      return {
        user_id: telegramId,
        preferences: user?.preferences || {},
        active_state: Boolean(state && Object.keys(state).length > 0),
        last_active: user?.preferences?.last_active,
        parlay_count: user?.preferences?.parlay_count || 0,
        state_keys: state ? Object.keys(state) : []
      };
    } catch (error) {
      console.error('Error getting user activity stats:', error?.message || error);
      throw error;
    }
  }

  async hasActiveAISession(chatId) {
    const state = await this.getUserState(chatId);
    return !!(state?.sportKey && state?.numLegs);
  }

  async getAllActiveSessions() {
    try {
      const redis = await this.getRedis();
      if (!redis) return [];
      const keys = await withTimeout(redis.keys(`${STATE_PREFIX}*`), 5000, 'getAllActiveKeys');
      const sessions = [];
      for (const key of keys) {
        const chatId = key.replace(STATE_PREFIX, '');
        const state = await this.getUserState(chatId);
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
        console.error('❌ getAllActiveSessions CRITICAL error:', error?.message || error);
        throw error;
      }
      return [];
    }
  }
}

// Provide BOTH a named and a default export so your existing import remains valid:
// import { stateManagerInstance as stateManager } from './stateManager.js';
export const stateManagerInstance = new StateManager();
export default stateManagerInstance;
