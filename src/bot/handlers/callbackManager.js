// src/bot/handlers/callbackManager.js - COMPLETE FIXED VERSION

/**
 * Centralized callback handler registry to prevent conflicts and ensure proper initialization
 */

// Import all callback handlers
import { registerAICallbacks } from './ai.js';
import { registerCustomCallbacks } from './custom.js';
import { registerSettingsCallbacks } from './settings.js';
import { registerPlayerCallbacks } from './player.js';
import { registerSystemCallbacks } from './system.js';
import { registerToolsCallbacks } from './tools.js';

// Track registered callbacks to prevent duplicates
const registeredCallbacks = new Set();

/**
 * Register all callback handlers with the bot instance
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerAllCallbacks(bot) {
  if (registeredCallbacks.has(bot)) {
    console.warn('⚠️ Callbacks already registered for this bot instance');
    return;
  }

  console.log('🔧 Starting callback handler registration...');
  
  try {
    // Register AI callbacks first (most complex)
    registerAICallbacks(bot);
    console.log('✅ AI callbacks registered');
    
    // Register custom parlay builder callbacks
    registerCustomCallbacks(bot);
    console.log('✅ Custom builder callbacks registered');
    
    // Register settings management callbacks
    registerSettingsCallbacks(bot);
    console.log('✅ Settings callbacks registered');
    
    // Register player prop search callbacks
    registerPlayerCallbacks(bot);
    console.log('✅ Player callbacks registered');
    
    // Register system command callbacks
    registerSystemCallbacks(bot);
    console.log('✅ System callbacks registered');
    
    // Register tools and utility callbacks
    registerToolsCallbacks(bot);
    console.log('✅ Tools callbacks registered');

    // Register global error handler for callbacks
    registerGlobalCallbackErrorHandler(bot);
    console.log('✅ Global callback error handler registered');

    registeredCallbacks.add(bot);
    console.log('🎉 All callback handlers registered successfully');

  } catch (error) {
    console.error('❌ Callback registration failed:', error);
    throw new Error(`Callback registration failed: ${error.message}`);
  }
}

/**
 * Register a global error handler for callback queries
 */
function registerGlobalCallbackErrorHandler(bot) {
  bot.on('callback_query', async (callbackQuery) => {
    const { data, message, from } = callbackQuery || {};
    
    // Skip if no data or message
    if (!data || !message) return;

    try {
      // Always answer callback query to remove loading state
      await bot.answerCallbackQuery(callbackQuery.id).catch(() => {
        // Ignore errors from answering old queries
      });
    } catch (error) {
      // Log but don't throw for callback answer errors
      if (!error.message.includes('query is too old')) {
        console.error('Error answering callback query:', error.message);
      }
    }
  });

  // Global error handler for callback processing
  bot.on('polling_error', (error) => {
    console.error('📡 Telegram polling error:', error.message);
  });

  bot.on('webhook_error', (error) => {
    console.error('🌐 Telegram webhook error:', error.message);
  });
}

/**
 * Unregister all callbacks (for testing/cleanup)
 */
export function unregisterAllCallbacks(bot) {
  if (registeredCallbacks.has(bot)) {
    // Note: Telegram Bot API doesn't provide a way to remove event listeners
    // This just removes from our tracking
    registeredCallbacks.delete(bot);
    console.log('🗑️ Callbacks unregistered from tracking');
  }
}

/**
 * Get callback registration status
 */
export function getCallbackStatus() {
  return {
    totalRegistered: registeredCallbacks.size,
    instances: Array.from(registeredCallbacks).map(() => 'bot_instance')
  };
}

// Default export for backward compatibility
export default { 
  registerAllCallbacks, 
  unregisterAllCallbacks, 
  getCallbackStatus 
};
