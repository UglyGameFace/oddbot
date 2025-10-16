// src/bot/state.js - FIXED VERSION (Removing non-existent function calls)
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { getRedisClient } from '../services/redisService.js';
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

// FIXED: Remove database calls that don't exist to prevent health check failures
async function getConfig(telegramId, type) {
    // Use Redis-based config instead of non-existent database functions
    try {
        const redis = await getRedisClient();
        if (redis) {
            const configKey = `user:config:${telegramId}:${type}`;
            const cachedConfig = await redis.get(configKey);
            if (cachedConfig) {
                return JSON.parse(cachedConfig);
            }
        }
    } catch (error) {
        console.warn('Redis config fetch failed, using defaults:', error.message);
    }
    
    // Default configurations
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
            fallbackOnNoGames: true,
            bookmakers: ['draftkings', 'fanduel']
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
    return { ...defaults[type] };
}

async function setConfig(telegramId, type, newConfigData) {
    // Use Redis-based config instead of non-existent database functions
    try {
        const redis = await getRedisClient();
        if (redis) {
            const configKey = `user:config:${telegramId}:${type}`;
            const currentConfig = await getConfig(telegramId, type);
            const updatedConfig = { ...currentConfig, ...newConfigData };
            await redis.set(configKey, JSON.stringify(updatedConfig), 'EX', 86400); // 24 hours
        }
    } catch (error) {
        console.warn('Redis config save failed:', error.message);
    }
}

export const getAIConfig = (id) => getConfig(id, 'ai');
export const setAIConfig = (id, cfg) => setConfig(id, 'ai', cfg);

export const getBuilderConfig = (id) => getConfig(id, 'builder');
export const setBuilderConfig = (id, cfg) => setConfig(id, 'builder', cfg);
