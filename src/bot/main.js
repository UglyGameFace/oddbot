// src/bot/main.js
import { bot, initWebhook, startServer } from './setup.js';
import { registerRouter } from './router.js';
import { registerAI } from './handlers/ai.js';
import { registerCustom } from './handlers/custom.js';
import { registerPlayer } from './handlers/player.js';
import { registerQuant } from './handlers/quant.js';
import { registerTools } from './handlers/tools.js';
import redis from '../services/redisService.js';

// Attach command handlers
registerAI(bot);
registerCustom(bot);
registerPlayer(bot);
registerQuant(bot);
registerTools(bot);

// Attach central router for callbacks
registerRouter(bot);

// Start HTTP and webhook/polling
export async function start() {
  await initWebhook();
  await startServer(async () => {
    try {
      if (redis?.quit) await redis.quit();
      else if (redis?.disconnect) await redis.disconnect();
      console.log('✅ Redis connection closed.');
    } catch (e) {
      console.error('Redis close error:', e?.message);
    }
  });
}
