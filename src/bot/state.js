// src/bot/state.js - COMPLETE FILE with setUserState Robustness Fix
import stateManager from './stateManager.js';
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
    const state = await stateManager.get(`user:state:${chatId}`);
    // console.log(`[State] getUserState for ${chatId}:`, state); // Optional: Verbose logging
    return state;
  } catch (error) {
    console.error(`[State] Error getting state for ${chatId}:`, error);
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
      const currentState = await getUserState(chatId) || {}; // Fetch current state safely
      stateToSave = { ...currentState, ...data }; // Merge new data over current state
    }

    console.log(`[State] Attempting to save state for ${chatId} (merge=${merge}, TTL=${ttlSeconds}):`, stateToSave); // Log state before saving

    const success = await stateManager.set(`user:state:${chatId}`, stateToSave, ttlSeconds);

    if (!success) {
      // *** FIX: Log failure explicitly ***
      console.error(`[State] Failed to save state for ${chatId}. stateManager.set returned false.`);
      sentryService.captureError(new Error("stateManager.set returned false"), { component: 'state', operation: 'setUserState', chatId, stateData: stateToSave });
      return false; // Indicate failure
    }

    console.log(`[State] State successfully saved for ${chatId}.`); // Log success
    return true; // Indicate success

  } catch (error) {
    // Catch errors potentially thrown by stateManager.set or getUserState
    console.error(`[State] Error setting state for ${chatId}:`, error);
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
    const deleted = await stateManager.delete(`user:state:${chatId}`);
    console.log(`[State] deleteUserState for ${chatId}: ${deleted ? 'Success' : 'Key not found or error'}`);
    return deleted; // stateManager.delete returns true if deleted or not found, false on error
  } catch (error) {
    console.error(`[State] Error deleting state for ${chatId}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'deleteUserState', chatId });
    return false;
  }
}

// --- User Configuration Management ---

// Helper to get config with defaults
async function getConfig(chatId, configType, defaults) {
  if (!chatId || !configType || !defaults) {
    console.error('[State] getConfig called with invalid arguments.', { chatId, configType });
    return { ...defaults }; // Return defaults on error
  }
  const key = `user:config:${chatId}:${configType}`;
  try {
    const storedConfig = await stateManager.get(key);
    if (storedConfig && typeof storedConfig === 'object') {
      console.log(`[State] Config HIT for ${key}`);
      return { ...defaults, ...storedConfig }; // Merge stored config over defaults
    } else {
      console.log(`[State] Config MISS for ${key}`);
      console.log(`[State] Using defaults for ${configType}`);
      return { ...defaults }; // Return only defaults if nothing stored or invalid
    }
  } catch (error) {
    console.error(`[State] Error getting config ${key}:`, error);
    sentryService.captureError(error, { component: 'state', operation: 'getConfig', configType, chatId });
    return { ...defaults }; // Return defaults on error
  }
}

// Helper to set config (no TTL, persistent)
async function setConfig(chatId, configType, data) {
    if (!chatId || !configType || typeof data !== 'object' || data === null) {
        console.error('[State] setConfig called with invalid arguments.', { chatId, configType, data });
        return false;
    }
    const key = `user:config:${chatId}:${configType}`;
    try {
        // Fetch existing config to merge with new data
        // Use defaults specific to the config type
        const defaults = configType === 'ai' ? defaultAIConfig :
                         configType === 'builder' ? defaultBuilderConfig : {};
        const currentConfig = await getConfig(chatId, configType, defaults);
        const newConfig = { ...currentConfig, ...data }; // Merge new data over current

        console.log(`[State] Saving config ${key}:`, newConfig);
        // Persist config (no TTL, pass null or 0, depending on stateManager implementation)
        const success = await stateManager.set(key, newConfig, null); // Assuming null/0 means no TTL

        if (!success) {
            console.error(`[State] Failed to save config ${key}. stateManager.set returned false.`);
            sentryService.captureError(new Error("stateManager.set failed for config"), { component: 'state', operation: 'setConfig', configType, chatId });
            return false;
        }
        console.log(`[State] Config saved successfully for ${key}.`);
        return true;

    } catch (error) {
        console.error(`[State] Error setting config ${key}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'setConfig', configType, chatId });
        return false;
    }
}


// --- AI Config ---
export const defaultAIConfig = Object.freeze({
  mode: 'web', // Default mode (web, live, db)
  model: 'perplexity', // Default model (perplexity, gemini, etc) - Note: Model selection logic moved to aiService
  betType: 'mixed', // Default bet type (moneyline, spreads, totals, props, mixed)
  horizonHours: 72, // Default time horizon for AI game fetching
  quantitativeMode: 'conservative', // conservative, aggressive
  includeProps: false, // Default setting for including player props
  proQuantMode: false, // Advanced quantitative features toggle
  // Add other AI-specific settings here
});

export async function getAIConfig(chatId) {
  // Try fetching from persistent config first
  const persistentConfig = await getConfig(chatId, 'ai', defaultAIConfig);
  // If we need to fetch defaults from DB eventually, do it here and merge
  // For now, persistentConfig already includes defaults if nothing was stored.
  return persistentConfig;
}

export async function setAIConfig(chatId, data) {
  return setConfig(chatId, 'ai', data);
}


// --- Builder Config ---
export const defaultBuilderConfig = Object.freeze({
  cutoffHours: 48, // Default lookahead for custom builder
  oddsFormat: 'american', // american, decimal
  excludedLeagues: [],
  excludedTeams: [],
  minOdds: -500,
  maxOdds: 500,
  allowSameGame: false, // Default setting for allowing same-game legs in custom builder
  // Add other builder-specific settings here
});

export async function getBuilderConfig(chatId) {
  // Try fetching from persistent config first
  const persistentConfig = await getConfig(chatId, 'builder', defaultBuilderConfig);
  // Merge with DB fetched settings if necessary in the future
  return persistentConfig;
}

export async function setBuilderConfig(chatId, data) {
  return setConfig(chatId, 'builder', data);
}

// --- Parlay Slip Management (Example using temporary state) ---

export async function getParlaySlip(chatId) {
  const state = await getUserState(chatId);
  return state?.parlay_slip || null; // Access slip within the user state object
}

export async function setParlaySlip(chatId, slip, ttlSeconds = 1800) { // 30 min TTL for slip
  if (!slip) {
    // If setting slip to null/empty, potentially just update the state
    const state = await getUserState(chatId) || {};
    delete state.parlay_slip; // Remove the slip property
    return setUserState(chatId, state, ttlSeconds);
  }
  // If setting a valid slip, merge it into the current state
  return setUserState(chatId, { parlay_slip: slip }, ttlSeconds, true); // Use merge=true
}

// --- Token Management (For callback data) ---

// Uses stateManager directly for simplicity, could be integrated into user state too
const TOKEN_TTL = 300; // 5 minutes for callback tokens

export async function saveToken(tokenId, data) {
    if (!tokenId || typeof data !== 'object' || data === null) return false;
    try {
        console.log(`[State] Saving token ${tokenId}`);
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
        const data = await stateManager.get(`token:${tokenId}`);
        // console.log(`[State] Loading token ${tokenId}:`, data ? 'Found' : 'Not Found'); // Optional: Verbose logging
        return data;
    } catch (error) {
        console.error(`[State] Error loading token ${tokenId}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'loadToken', tokenId });
        return null;
    }
}

export async function deleteToken(tokenId) {
    if (!tokenId) return false;
    try {
        const deleted = await stateManager.delete(`token:${tokenId}`);
        console.log(`[State] Deleting token ${tokenId}: ${deleted ? 'Success' : 'Not found/Error'}`);
        return deleted;
    } catch (error) {
        console.error(`[State] Error deleting token ${tokenId}:`, error);
        sentryService.captureError(error, { component: 'state', operation: 'deleteToken', tokenId });
        return false;
    }
}
