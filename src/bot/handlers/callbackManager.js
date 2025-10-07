// src/bot/handlers/callbackManager.js - FINALIZED AND CORRECTED

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
    registerAICallbacks(bot);
    registerCustomCallbacks(bot);
    registerSettingsCallbacks(bot);
    registerPlayerCallbacks(bot);
    registerSystemCallbacks(bot);
    registerToolsCallbacks(bot);
    registerChatCallbacks(bot);
    
    registerGlobalCallbackErrorHandler(bot);

    registeredCallbacks.add(bot);
    console.log('🎉 All callback handlers registered successfully and centrally.');

  } catch (error) {
    console.error('❌ FATAL: Callback registration failed:', error);
    throw new Error(`Callback registration failed: ${error.message}`);
  }
}

function registerGlobalCallbackErrorHandler(bot) {
  bot.on('callback_query', async (callbackQuery) => {
    const { data, message, id } = callbackQuery || {};
    if (!data || !message) return;

    try {
      await bot.answerCallbackQuery(id).catch(() => {});
    } catch (error) {
      if (!error.message.includes('query is too old')) {
        console.error('Error answering callback query:', error.message);
      }
    }
  });

  bot.on('polling_error', (error) => console.error('📡 Telegram polling error (should not occur in webhook mode):', error.message));
  bot.on('webhook_error', (error) => console.error('🌐 Telegram webhook error:', error.message));
  bot.on('error', (error) => console.error('🤖 General bot error:', error.message));
}

// Export for testing
export function isCallbacksRegistered(bot) {
  return registeredCallbacks.has(bot);
}

export function clearCallbacksRegistry() {
  registeredCallbacks.clear();
}
