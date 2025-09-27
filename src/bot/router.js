// src/bot/router.js
import { loadToken } from './state.js';
import { registerCustomCallbacks } from './handlers/custom.js';
import { registerAICallbacks } from './handlers/ai.js';
import { registerCommonCallbacks } from './handlers/tools.js'; // if any common callbacks

export function registerRouter(bot) {
  // Delegate-specific callback prefixes to handlers
  const handlers = [
    registerAICallbacks,
    registerCustomCallbacks,
    registerCommonCallbacks,
  ].filter(Boolean);

  // Allow each handler to attach its own prefix dispatchers
  for (const attach of handlers) attach(bot);

  // Example: a generic token loader helper (optional shared usage)
  bot.on('callback_query', async (cbq) => {
    try {
      await bot.answerCallbackQuery(cbq.id);
    } catch {}
    // No-op here if each handler has its own bot.on('callback_query') with precise guards
  });
}
