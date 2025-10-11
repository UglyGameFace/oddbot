// src/bot/state.js - COMPLETE ABSOLUTE FIXED VERSION (Fixing SET command syntax)
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { getRedisClient } from '../services/redisService.js';
import databaseService from '../services/databaseService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';
import StateManager from './stateManager.js';

// --- CORE REDIS STATE FUNCTIONS ---

// FIXED: Use the StateManager instance methods directly
export const setUserState = StateManager.setUserState.bind(StateManager);
export const getUserState = StateManager.getUserState.bind(StateManager);
export const getParlaySlip = StateManager.getParlaySlip.bind(StateManager);
export const setParlaySlip = StateManager.setParlaySlip.bind(StateManager);
export const setValidationState = StateManager.setValidationState.bind(StateManager);
export const getValidationState = StateManager.getValidationState.bind(StateManager);
export const saveToken = StateManager.saveToken.bind(StateManager);
export const loadToken = StateManager.loadToken.bind(StateManager);
export const clearUserState = StateManager.clearUserState.bind(StateManager);
export const getUserActivityStats = StateManager.getUserActivityStats.bind(StateManager);
export const hasActiveAISession = StateManager.hasActiveAISession.bind(StateManager);
export const getAllActiveSessions = StateManager.getAllActiveSessions.bind(StateManager);

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
