// src/handlers/index.js - Dynamic Handler Loader
import startHandler from './startHandler.js';
import parlayHandler from './parlayHandler.js';
// When you add new command files, you will import them here.

const handlers = [
  startHandler,
  parlayHandler,
  // And add the new handler to this list.
];

export const initializeHandlers = (bot, services) => {
  const commandMap = new Map();

  handlers.forEach(handler => {
    // Store handlers by their command name for easy lookup
    commandMap.set(handler.command, handler);

    // Register the regex pattern with the bot
    if (handler.pattern) {
        bot.onText(handler.pattern, (msg, match) => {
          // On match, execute the handler
          executeHandler(handler, bot, msg, match, services);
        });
    }
  });

  console.log(`✅ Loaded ${handlers.length} command handlers.`);
  return commandMap;
};

const executeHandler = async (handler, bot, msg, match, services) => {
  const { rateLimitService, sentryService } = services;
  const userId = msg.from.id;

  try {
    // 1. Apply Rate Limiting before executing
    const limit = await rateLimitService.checkRateLimit(userId, 'user', handler.command);
    if (!limit.allowed) {
      bot.sendMessage(userId, "Hold on! You're doing that too fast. Please wait a moment.");
      return;
    }

    // 2. Start a performance transaction in Sentry
    const transaction = sentryService.startTransaction({
        op: 'command',
        name: handler.command,
    });

    // 3. Execute the command
    await handler.execute(bot, msg, match, services);

    // 4. Finish the transaction
    transaction.setStatus('ok');
    transaction.finish();

  } catch (error) {
    console.error(`Error executing handler '${handler.command}':`, error);
    sentryService.captureError(error, {
        component: 'handler_execution',
        handler: handler.command,
        userId,
    });
    bot.sendMessage(userId, '❌ An error occurred. Please try again in a few moments.');
  }
};
