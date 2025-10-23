// src/bot/state.js

// Robustly resolve the exported state manager INSTANCE, regardless of how stateManager.js exports it.
import * as stateModule from './stateManager.js';
import { sentryService } from '../services/sentryService.js';

const stateManager =
  // prefer explicit instance names
  stateModule.stateManagerInstance ||
  stateModule.stateManager ||
  // fall back to default export if it's the instance
  stateModule.default;

if (!stateManager || typeof stateManager.get !== 'function' || typeof stateManager.set !== 'function') {
  throw new Error(
    '[State] stateManager instance not found or invalid. Ensure stateManager.js exports an instance with get/set/delete.'
  );
}

// Defaults
const DEFAULT_TTL = 600; // 10 minutes
const TOKEN_TTL = 300;   // 5 minutes

// Key helpers
const kUserState = (chatId) => `user:state:${chatId}`;
const kUserConfig = (chatId, type) => `user:config:${chatId}:${type}`;
const kToken = (tokenId) => `token:${tokenId}`;

// --- User State Management ---

/**
 * Retrieve the user's temporary state object.
 * Returns null if missing or on error.
 */
export async function getUserState(chatId) {
  if (!chatId) {
    console.error('[State] getUserState called without chatId.');
    return null;
  }
  try {
    const state = await stateManager.get(kUserState(chatId));
    return state ?? null;
  } catch (error) {
    console.error(`[State] Error context in getUserState for ${chatId}:`, error?.message || error);
    sentryService.captureError(error, { component: 'state', operation: 'getUserState', chatId });
    return null;
  }
}

/**
 * Set/merge the user's temporary state with TTL.
 * merge=true merges with existing; merge=false overwrites.
 */
export async function setUserState(chatId, data, ttlSeconds = DEFAULT_TTL, merge = true) {
  if (!chatId || typeof data !== 'object' || data === null) {
    console.error('[State] setUserState called with invalid arguments.', { chatId, data });
    return false;
  }
  try {
    let stateToSave = data;
    if (merge) {
      const currentState = (await getUserState(chatId)) || {};
      const currentSafe = typeof currentState === 'object' && currentState !== null ? currentState : {};
      stateToSave = { ...currentSafe, ...data };
    }
    if (typeof stateToSave !== 'object' || stateToSave === null) {
      console.error(`[State] stateToSave became invalid before saving for ${chatId}.`, { data, merge });
      stateToSave = {};
    }
    const ok = await stateManager.set(kUserState(chatId), stateToSave, ttlSeconds);
    if (!ok) {
      console.error(`[State] Failed to save state for ${chatId}. stateManager.set returned false/error.`);
      sentryService.captureError(new Error('stateManager.set returned false/error'), {
        component: 'state',
        operation: 'setUserState',
        chatId,
        stateData: stateToSave,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[State] Error during setUserState for ${chatId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'setUserState', chatId });
    return false;
  }
}

/**
 * Delete the user's temporary state.
 */
export async function deleteUserState(chatId) {
  if (!chatId) {
    console.error('[State] deleteUserState called without chatId.');
    return false;
  }
  try {
    const deleted = await stateManager.delete(kUserState(chatId));
    return !!deleted;
  } catch (error) {
    console.error(`[State] Error deleting state for ${chatId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'deleteUserState', chatId });
    return false;
  }
}

// --- User Configuration Management ---

// AI Config defaults
export const defaultAIConfig = Object.freeze({
  mode: 'web',
  betType: 'mixed',
  horizonHours: 72,
  quantitativeMode: 'conservative',
  includeProps: false,
  proQuantMode: false,
});

// Builder Config defaults
export const defaultBuilderConfig = Object.freeze({
  cutoffHours: 48,
  oddsFormat: 'american',
  excludedLeagues: [],
  excludedTeams: [],
  minOdds: -500,
  maxOdds: 500,
  allowSameGame: false,
});

async function getConfig(chatId, configType, defaults) {
  if (!chatId || !configType || !defaults) {
    console.error('[State] getConfig invalid args.', { chatId, configType });
    return { ...defaults };
  }
  const key = kUserConfig(chatId, configType);
  try {
    const stored = await stateManager.get(key);
    if (stored && typeof stored === 'object') {
      return { ...defaults, ...stored };
    }
    return { ...defaults };
  } catch (error) {
    console.error(`[State] Error getting config ${key}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'getConfig', configType, chatId });
    return { ...defaults };
  }
}

async function setConfig(chatId, configType, data) {
  if (!chatId || !configType || typeof data !== 'object' || data === null) {
    console.error('[State] setConfig invalid args.', { chatId, configType, data });
    return false;
  }
  const key = kUserConfig(chatId, configType);
  try {
    const defaults =
      configType === 'ai' ? defaultAIConfig :
      configType === 'builder' ? defaultBuilderConfig :
      {};
    const current = await getConfig(chatId, configType, defaults);
    const next = { ...current, ...data };
    const ok = await stateManager.set(key, next, null); // persistent
    if (!ok) {
      console.error(`[State] Failed to save config ${key}.`);
      sentryService.captureError(new Error('stateManager.set failed for config'), {
        component: 'state',
        operation: 'setConfig',
        configType,
        chatId,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[State] Error setting config ${key}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'setConfig', configType, chatId });
    return false;
  }
}

// AI config accessors
export async function getAIConfig(chatId) {
  return getConfig(chatId, 'ai', defaultAIConfig);
}
export async function setAIConfig(chatId, data) {
  return setConfig(chatId, 'ai', data);
}

// Builder config accessors
export async function getBuilderConfig(chatId) {
  return getConfig(chatId, 'builder', defaultBuilderConfig);
}
export async function setBuilderConfig(chatId, data) {
  return setConfig(chatId, 'builder', data);
}

// --- Parlay Slip Management (via user state) ---

/**
 * Returns the user's parlay slip object { legs: [] } or null.
 */
export async function getParlaySlip(chatId) {
  const state = await getUserState(chatId);
  if (state?.parlay_slip && Array.isArray(state.parlay_slip.legs)) {
    return state.parlay_slip;
  }
  return null;
}

/**
 * Set or clear the user's parlay slip in state.
 * Pass a falsy slip to clear; ttlSeconds defaults to 30 minutes.
 */
export async function setParlaySlip(chatId, slip, ttlSeconds = 1800) {
  if (!chatId) return false;
  if (!slip) {
    const state = (await getUserState(chatId)) || {};
    if (state && typeof state === 'object') {
      delete state.parlay_slip;
      return setUserState(chatId, state, ttlSeconds, false);
    }
    return true;
  }
  const slipToSave = {
    ...slip,
    legs: Array.isArray(slip.legs) ? slip.legs : [],
  };
  return setUserState(chatId, { parlay_slip: slipToSave }, ttlSeconds, true);
}

// --- Token Management (for callback data passing) ---

export async function saveToken(tokenId, data) {
  if (!tokenId || typeof data !== 'object' || data === null) return false;
  try {
    return await stateManager.set(kToken(tokenId), data, TOKEN_TTL);
  } catch (error) {
    console.error(`[State] Error saving token ${tokenId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'saveToken', tokenId });
    return false;
  }
}

export async function loadToken(tokenId) {
  if (!tokenId) return null;
  try {
    return await stateManager.get(kToken(tokenId));
  } catch (error) {
    console.error(`[State] Error loading token ${tokenId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'loadToken', tokenId });
    return null;
  }
}

export async function deleteToken(tokenId) {
  if (!tokenId) return false;
  try {
    return await stateManager.delete(kToken(tokenId));
  } catch (error) {
    console.error(`[State] Error deleting token ${tokenId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'deleteToken', tokenId });
    return false;
  }
}
