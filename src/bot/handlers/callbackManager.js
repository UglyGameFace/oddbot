// src/bot/handlers/callbackManager.js - ENHANCED ERROR HANDLING
import { registerAICallbacks } from './ai.js';
import { registerCustomCallbacks } from './custom.js';
import { registerSettingsCallbacks } from './settings.js';
import { registerPlayerCallbacks } from './player.js';
import { registerSystemCallbacks } from './system.js';
import { registerToolsCallbacks } from './tools.js';
import { registerChatCallbacks } from './chat.js';

const registeredCallbacks = new Set();

export function registerAllCallbacks(bot) {
  if (registeredCallbacks.has(bot)) {
    console.warn('⚠️ Callbacks already registered for this bot instance');
    return;
  }

  console.log('🔧 Starting final callback handler registration...');
  
  try {
    // Register all callback handlers with error wrapping
    registerAICallbacks(bot);
    registerCustomCallbacks(bot);
    registerSettingsCallbacks(bot);
    registerPlayerCallbacks(bot);
    registerSystemCallbacks(bot);
    registerToolsCallbacks(bot);
    registerChatCallbacks(bot);
    
    // Enhanced global error handler
    registerGlobalCallbackErrorHandler(bot);

    registeredCallbacks.add(bot);
    console.log('🎉 All callback handlers registered successfully and centrally.');

  } catch (error) {
    console.error('❌ FATAL: Callback registration failed:', error);
    throw new Error(`Callback registration failed: ${error.message}`);
  }
}

function registerGlobalCallbackErrorHandler(bot) {
  // Global callback query error handler
  bot.on('callback_query', async (callbackQuery) => {
    const { data, message, id } = callbackQuery || {};
    if (!data || !message) return;

    try {
      // Always answer callback query to prevent loading indicators
      await bot.answerCallbackQuery(id).catch(() => {
        console.warn('⚠️ Callback query answer failed (likely too old)');
      });
    } catch (error) {
      console.error('❌ Global callback error handler failed:', error.message);
    }
  });

  // Enhanced error handlers for Telegram API
  bot.on('polling_error', (error) => {
    console.error('📡 Telegram polling error (should not occur in webhook mode):', error.message);
  });
  
  bot.on('webhook_error', (error) => {
    console.error('🌐 Telegram webhook error:', error.message);
  });

  bot.on('error', (error) => {
    console.error('🤖 General bot error:', error.message);
  });
}

// Export for testing
export function isCallbacksRegistered(bot) {
  return registeredCallbacks.has(bot);
}

export function clearCallbacksRegistry() {
  registeredCallbacks.clear();
}
