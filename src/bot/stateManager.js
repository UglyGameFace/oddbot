// src/bot/stateManager.js
import { getRedisClient } from '../services/redisService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
import databaseService from '../services/databaseService.js';

const NS = (env.NODE_ENV || 'production').toLowerCase();
const V = 'v1';
const PREFIX = `${V}:${NS}:`;
const STATE_PREFIX = `${PREFIX}user:state:`;
const SLIP_PREFIX = `${PREFIX}parlay:slip:`;
const DEFAULT_SLIP = { picks: [], stake: 10, totalOdds: 0, messageId: null };

const safeParse = (s, f) => {
  try {
    if (s === null || s === undefined) return f;
    return JSON.parse(s);
  } catch (e) {
    sentryService.captureError(e, { component: 'stateManager', op: 'parse' });
    return f;
  }
};

const setWithTTL = async (c, k, v, ttl) => {
  if (!c) return;
  if (!ttl) return c.set(k, v);
  return c.set(k, v, 'EX', ttl);
};

class StateManager {
  async getRedis() {
    return getRedisClient();
  }

  async setUserState(chatId, state, ttl = 3600) {
    try {
      const redis = await this.getRedis();
      if (!redis) return;
      await withTimeout(setWithTTL(redis, `${STATE_PREFIX}${chatId}`, JSON.stringify(state), ttl), 3000, 'setUserState');
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ setUserState CRITICAL error:', error.message);
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
        console.error('❌ getUserState CRITICAL error:', error.message);
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
        console.error('❌ getParlaySlip CRITICAL error:', error.message);
        throw error;
      }
      return { ...DEFAULT_SLIP };
    }
  }

  async setParlaySlip(chatId, slip) {
    try {
      const redis = await this.getRedis();
      if (!redis) return;
      await withTimeout(setWithTTL(redis, `${SLIP_PREFIX}${chatId}`, JSON.stringify(slip), 86400), 3000, 'setParlaySlip');
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        console.error('❌ setParlaySlip CRITICAL error:', error.message);
        throw error;
      }
    }
  }
  
  async setValidationState(chatId, sportKey, validationData) {
      const state = await this.getUserState(chatId);
      state.validation = {
        sportKey,
        lastValidation: new Date().toISOString(),
        ...validationData
      };
      await this.setUserState(chatId, state);
    }

    async getValidationState(chatId) {
      const state = await this.getUserState(chatId);
      return state.validation || null;
    }

    async saveToken(type, payload, ttl = 600) {
        const tokenPrefix = `${PREFIX}token:`;
        try {
            const redis = await this.getRedis();
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

    async loadToken(type, tok) {
        const tokenPrefix = `${PREFIX}token:`;
        try {
            const redis = await this.getRedis();
            if (!redis || !tok?.startsWith(`${type}_`)) return null;
            const key = `${tokenPrefix}${tok}`;
            const data = await withTimeout(redis.get(key), 3000, 'loadToken.get');
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
        console.error('Error clearing user state:', error);
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
        console.error('Error getting user activity stats:', error);
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
          console.error('❌ getAllActiveSessions CRITICAL error:', error);
          throw error;
        }
        return [];
      }
    }
}

export default new StateManager();
