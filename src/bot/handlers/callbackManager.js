// src/bot/handlers/callbackManager.js

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
  // Register all callback handlers in sequence
  registerAICallbacks(bot);
  registerCustomCallbacks(bot);
  registerSettingsCallbacks(bot);
  registerPlayerCallbacks(bot);
  registerSystemCallbacks(bot);
  registerCommonCallbacks(bot);

  console.log('✅ All callback handlers registered successfully');
}

export default { registerAllCallbacks };
