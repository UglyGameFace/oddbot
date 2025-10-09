// src/bot/state.js - COMPLETE ABSOLUTE FIXED VERSION (Fixing SET command syntax)
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { getRedisClient } from '../services/redisService.js';
import databaseService from '../services/databaseService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';
import StateManager from './stateManager.js';

// --- CORE REDIS STATE FUNCTIONS ---

export const {
  setUserState,
  getUserState,
  getParlaySlip,
  setParlaySlip,
  setValidationState,
  getValidationState,
  saveToken,
  loadToken,
  clearUserState,
  getUserActivityStats,
  hasActiveAISession,
  getAllActiveSessions,
} = StateManager;

// --- CONFIGURATION MANAGEMENT ---

async function getConfig(telegramId, type) {
    // databaseService.getUserSettings will throw if the database is critically down,
    // which is the intended behavior to fail the health check.
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
            requireVerifiedGames: true
        },
    };
    return { ...defaults[type], ...(settings[type] || {}) };
}

async function setConfig(telegramId, type, newConfigData) {
    // databaseService.getUserSettings/updateUserSettings will throw if the database is critically down,
    // which is the intended behavior to fail the health check.
    const currentSettings = await databaseService.getUserSettings(telegramId);
    const updatedSettings = JSON.parse(JSON.stringify(currentSettings));

    if (!updatedSettings[type]) {
        updatedSettings[type] = {};
    }

    Object.assign(updatedSettings[type], newConfigData);

    await databaseService.updateUserSettings(telegramId, updatedSettings);
}

export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);

export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);
