// src/bot/state.js - COMPLETE FILE - Fix stateManager Instance Usage
// *** FIX: Import the exported INSTANCE, not the class default ***
import { stateManagerInstance as stateManager } from './stateManager.js';
import databaseService from '../services/databaseService.js'; // For fetching initial settings
import { sentryService } from '../services/sentryService.js'; // For error reporting


















const DEFAULT_TTL = 600; // 10 minutes default TTL




// --- User State Management ---

/**
 * Retrieves the user's current temporary state.
 * @param {string|number} chatId Telegram Chat ID
 * @returns {Promise<object|null>} The user state object or null if not found/error.
 */
export async function getUserState(chatId) {
  if (!chatId) {
    console.error('[State] getUserState called without chatId.');
    return null;
  }
  try {
    // *** FIX: Now correctly calls .get() on the instance ***
    const state = await stateManager.get(`user:state:${chatId}`);
    // console.log(`[State] getUserState for ${chatId}:`, state); // Optional: Verbose logging
    return state;
  } catch (error) {
    // stateManager.get() handles its internal errors and logs them.
    // Log the context here.
    console.error(`[State] Error context in getUserState for ${chatId}:`, error.message);
    // Sentry reporting might be redundant if stateManager already does it, but can keep for context
    sentryService.captureError(error, { component: 'state', operation: 'getUserState', chatId });
    return null; // Return null on error to indicate failure
  }
}

/**
 * Sets the user's temporary state with a TTL.
 * Merges new data with existing state by default.
 * @param {string|number} chatId Telegram Chat ID
 * @param {object} data The state data object to set or merge.
 * @param {number} [ttlSeconds=DEFAULT_TTL] Time-to-live in seconds.
 * @param {boolean} [merge=true] If true, merge data with existing state. If false, overwrite completely.
 * @returns {Promise<boolean>} True if setting was successful, false otherwise.
 */
export async function setUserState(chatId, data, ttlSeconds = DEFAULT_TTL, merge = true) {
  if (!chatId || typeof data !== 'object' || data === null) {
    console.error('[State] setUserState called with invalid arguments.', { chatId, data });
    return false;
  }

  try {
    let stateToSave = data;
    if (merge) {
      // Fetch current state safely, default to {} if null/error
      const currentState = (await getUserState(chatId)) || {};
      // Ensure currentState is an object before spreading
      const currentSafe = typeof currentState === 'object' && currentState !== null ? currentState : {};
      stateToSave = { ...currentSafe, ...data }; // Merge new data over current state
    }

    // Ensure stateToSave is always an object
    if (typeof stateToSave !== 'object' || stateToSave === null) {
        console.error(`[State] stateToSave became invalid before saving for ${chatId}. Data:`, data, `Merge:`, merge);
        stateToSave = {}; // Fallback to empty object
    }

    console.log(`[State] Attempting to save state for ${chatId} (merge=${merge}, TTL=${ttlSeconds}):`, stateToSave);

    // *** FIX: Now correctly calls .set() on the instance ***
    const success = await stateManager.set(`user:state:${chatId}`, stateToSave, ttlSeconds);

    if (!success) {
      console.error(`[State] Failed to save state for ${chatId}. stateManager.set returned false or threw error.`);
      // Sentry reporting might be redundant if stateManager logs it, adjust as needed
      sentryService.captureError(new Error("stateManager.set returned false/error"), { component: 'state', operation: 'setUserState', chatId, stateData: stateToSave });
      return false; // Indicate failure
    }

    console.log(`[State] State successfully saved for ${chatId}.`);
    return true; // Indicate success

  } catch (error) {
    // Catch errors potentially thrown by getUserState or stateManager.set if it throws
    console.error(`[State] Error during setUserState for ${chatId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'setUserState', chatId });
    return false; // Indicate failure
  }
}


/**
 * Deletes the user's temporary state.
 * @param {string|number} chatId Telegram Chat ID
 * @returns {Promise<boolean>} True if deletion was successful or key didn't exist, false on error.
 */
export async function deleteUserState(chatId) {
  if (!chatId) {
    console.error('[State] deleteUserState called without chatId.');
    return false;
  }
  try {
    // *** FIX: Now correctly calls .delete() on the instance ***
    const deleted = await stateManager.delete(`user:state:${chatId}`);
    console.log(`[State] deleteUserState for ${chatId}: ${deleted ? 'Success/Not Found' : 'Error'}`);
    return deleted; // stateManager.delete should return boolean
  } catch (error) {
    console.error(`[State] Error deleting state for ${chatId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'deleteUserState', chatId });
@@ -112,162 +106,159 @@ export async function deleteUserState(chatId) {

// --- User Configuration Management ---

// Helper to get config with defaults




















async function getConfig(chatId, configType, defaults) {
  if (!chatId || !configType || !defaults) {
    console.error('[State] getConfig invalid args.', { chatId, configType });
    return { ...defaults };
  }
  const key = `user:config:${chatId}:${configType}`;
  try {
    // *** FIX: Now correctly calls .get() on the instance ***
    const storedConfig = await stateManager.get(key);
    if (storedConfig && typeof storedConfig === 'object') {
      // console.log(`[State] Config HIT for ${key}`); // Can be noisy
      return { ...defaults, ...storedConfig };
    } else {
      // console.log(`[State] Config MISS for ${key}`); // Can be noisy
      return { ...defaults };
    }

  } catch (error) {
    console.error(`[State] Error getting config ${key}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'getConfig', configType, chatId });
    return { ...defaults };
  }
}

// Helper to set config (no TTL, persistent)
async function setConfig(chatId, configType, data) {
    if (!chatId || !configType || typeof data !== 'object' || data === null) {
        console.error('[State] setConfig invalid args.', { chatId, configType, data });
        return false;
    }
    const key = `user:config:${chatId}:${configType}`;
    try {
        const defaults = configType === 'ai' ? defaultAIConfig :
                         configType === 'builder' ? defaultBuilderConfig : {};
        const currentConfig = await getConfig(chatId, configType, defaults);
        const newConfig = { ...currentConfig, ...data };

        console.log(`[State] Saving config ${key}`); // Simplified log
        // *** FIX: Now correctly calls .set() on the instance ***
        const success = await stateManager.set(key, newConfig, null); // Pass null for TTL

        if (!success) {
            console.error(`[State] Failed to save config ${key}.`);
            sentryService.captureError(new Error("stateManager.set failed for config"), { component: 'state', operation: 'setConfig', configType, chatId });
            return false;
        }
        console.log(`[State] Config saved for ${key}.`);
        return true;

    } catch (error) {
        console.error(`[State] Error setting config ${key}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'setConfig', configType, chatId });
        return false;
    }






}


// --- AI Config ---
export const defaultAIConfig = Object.freeze({
  mode: 'web',
  betType: 'mixed',
  horizonHours: 72,
  quantitativeMode: 'conservative',
  includeProps: false,
  proQuantMode: false,
});

export async function getAIConfig(chatId) {
  return getConfig(chatId, 'ai', defaultAIConfig);
}

export async function setAIConfig(chatId, data) {
  return setConfig(chatId, 'ai', data);
}


// --- Builder Config ---
export const defaultBuilderConfig = Object.freeze({
  cutoffHours: 48,
  oddsFormat: 'american',
  excludedLeagues: [],
  excludedTeams: [],
  minOdds: -500,
  maxOdds: 500,
  allowSameGame: false,
});

export async function getBuilderConfig(chatId) {
  return getConfig(chatId, 'builder', defaultBuilderConfig);
}

export async function setBuilderConfig(chatId, data) {
  return setConfig(chatId, 'builder', data);
}

// --- Parlay Slip Management (Using temporary user state) ---




export async function getParlaySlip(chatId) {
  const state = await getUserState(chatId);
  if (state?.parlay_slip && Array.isArray(state.parlay_slip.legs)) {
      return state.parlay_slip;
  }
  return null;
}





export async function setParlaySlip(chatId, slip, ttlSeconds = 1800) {

  if (!slip) {
    const state = await getUserState(chatId);
    if (state) {
        delete state.parlay_slip;
        // Overwrite state, don't merge, as we are deleting a key
        return setUserState(chatId, state, ttlSeconds, false);
    }
    return true; // No state to update
  }
  // Merge the new slip into the current state
  const slipToSave = { ...slip, legs: Array.isArray(slip.legs) ? slip.legs : [] };


  return setUserState(chatId, { parlay_slip: slipToSave }, ttlSeconds, true);
}

// --- Token Management (For callback data passing) ---

const TOKEN_TTL = 300; // 5 minutes for callback tokens

export async function saveToken(tokenId, data) {
    if (!tokenId || typeof data !== 'object' || data === null) return false;
    try {
        // *** FIX: Now correctly calls .set() on the instance ***
        return await stateManager.set(`token:${tokenId}`, data, TOKEN_TTL);
    } catch (error) {
        console.error(`[State] Error saving token ${tokenId}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'saveToken', tokenId });
        return false;
    }
}

export async function loadToken(tokenId) {
    if (!tokenId) return null;
    try {
        // *** FIX: Now correctly calls .get() on the instance ***
        return await stateManager.get(`token:${tokenId}`);
    } catch (error) {
        console.error(`[State] Error loading token ${tokenId}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'loadToken', tokenId });
        return null;
    }
}

export async function deleteToken(tokenId) {
    if (!tokenId) return false;
    try {
        // *** FIX: Now correctly calls .delete() on the instance ***
        return await stateManager.delete(`token:${tokenId}`);
    } catch (error) {
        console.error(`[State] Error deleting token ${tokenId}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'deleteToken', tokenId });
        return false;
    }
}
