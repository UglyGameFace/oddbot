// src/bot/handlers/callbackManager.js - COMPLETELY FIXED

import { registerAICallbacks } from './ai.js';
import { registerCustomCallbacks } from './custom.js';
import { registerSettingsCallbacks } from './settings.js';
import { registerPlayerCallbacks } from './player.js';
import { registerSystemCallbacks } from './system.js';
import { registerCommonCallbacks } from './tools.js';

/**
 * Centralized callback handler to prevent conflicts
 */
export function registerAllCallbacks(bot) {
  console.log('🔄 Registering callback handlers...');
  
  // Register all callback handlers in sequence
  try {
    registerAICallbacks(bot);
    registerCustomCallbacks(bot);
    registerSettingsCallbacks(bot);
    registerPlayerCallbacks(bot);
    registerSystemCallbacks(bot);
    registerCommonCallbacks(bot);

    console.log('✅ All callback handlers registered successfully');
  } catch (error) {
    console.error('❌ Callback registration failed:', error);
    throw error;
  }
}

export default { registerAllCallbacks };
