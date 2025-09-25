// src/handlers/index.js - Dynamic Handler Loader (Final, Corrected Path)
import startHandler from './startHandler.js';
import parlayHandler from './parlayHandler.js';

// --- FIX: Lazy load services to prevent race conditions ---
import rateLimitService from '../services/rateLimitService.js';
import sentryService from '../services/sentryService.js';
import DatabaseService from '../services/databaseService.js';
import AIService from '../services/aiService.js';
import OddsService from '../services/oddsService.js';

// No need to import env.js here, services already have it.
const services = {
  rateLimitService,
  sentryService,
  dbService: DatabaseService,
  aiService: AIService,
  oddsService: OddsService,
};

const handlers = [
  startHandler,
  parlayHandler,
];

export const initializeHandlers = (bot) => {
  handlers.forEach(handler => {
    if (handler.pattern) {
        bot.onText(handler.pattern, (msg, match) => {
          executeHandler(handler, bot, msg, match);
        });
    }
  });
  console.log(`✅ Loaded ${handlers.length} command handlers.`);
};

const executeHandler = async (handler, bot, msg, match) => {
  const userId = msg.from.id;
  try {
    const limit = await services.rateLimitService.checkRateLimit(userId, 'user', handler.command);
    if (!limit.allowed) {
      bot.sendMessage(userId, "Hold on! You're doing that too fast. Please wait a moment.");
      return;
    }

    const transaction = services.sentryService.startTransaction({
        op: 'command',
        name: handler.command,
    });

    await handler.execute(bot, msg, match, services);

    transaction.setStatus('ok');
    transaction.finish();

  } catch (error) {
    console.error(`Error executing handler '${handler.command}':`, error);
    services.sentryService.captureError(error, {
        component: 'handler_execution',
        handler: handler.command,
        userId,
    });
    bot.sendMessage(userId, '❌ An error occurred. Please try again in a few moments.');
  }
};
