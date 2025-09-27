// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
import { registerCustom, registerCustomCallbacks } from './bot/handlers/custom.js';
import { registerAI, registerAICallbacks } from './bot/handlers/ai.js';
import { registerQuant } from './bot/handlers/quant.js';
import { registerPlayer, registerPlayerCallbacks } from './bot/handlers/player.js';
import { registerSettings, registerSettingsCallbacks } from './bot/handlers/settings.js';
import { registerSystem, registerSystemCallbacks } from './bot/handlers/system.js';
import { registerTools, registerCommonCallbacks } from './bot/handlers/tools.js';

// --- Global Error Catcher ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
  sentryService.captureError(reason);
});

const app = express();
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const USE_WEBHOOK = env.APP_URL && env.APP_URL.startsWith('https');

// --- Bot Initialization ---
const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

// --- Main Application Start ---
async function main() {
  // 1. Register all bot command and callback handlers
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');

  // 2. Set up Express server and Sentry middleware
  app.use(express.json());
  sentryService.attachExpressPreRoutes?.(app);
  
  // 3. Define Health Check and Webhook routes
  app.get('/liveness', (_req, res) => res.sendStatus(200));
  ['/', '/health', '/healthz'].forEach(path => app.get(path, (_req, res) => res.send('OK')));

  if (USE_WEBHOOK) {
    const webhookPath = `/webhook/${TOKEN}`;
    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    await bot.setWebHook(`${env.APP_URL}${webhookPath}`);
    console.log(`Webhook successfully set to: ${env.APP_URL}${webhookPath}`);
  }

  // 4. Attach Sentry's post-request error handler
  sentryService.attachExpressPostRoutes?.(app);

  // 5. Set the command list in Telegram
  const commands = [
    { command: 'ai', description: 'Launch the AI Parlay Builder' },
    { command: 'custom', description: 'Manually build a parlay slip' },
    { command: 'player', description: 'Find props for a specific player' },
    { command: 'settings', description: 'Configure bot preferences' },
    { command: 'status', description: 'Check bot operational status' },
    { command: 'tools', description: 'Access admin tools' },
    { command: 'help', description: 'Show the command guide' },
  ];
  await bot.setMyCommands(commands);
  console.log('Bot commands have been set in Telegram.');
  
  // 6. Final confirmation
  const me = await bot.getMe();
  console.log(`✅ Bot @${me.username} fully initialized.`);
  
  // 7. Start the server LAST, only after everything is ready.
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}. Bot is online in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
  });
}

// --- Run the application ---
main().catch((e) => {
  console.error('❌ Fatal Bot Initialization Error:', e);
  process.exit(1);
});

// --- Graceful Shutdown & Keep-Alive ---
const shutdown = (signal) => process.exit(0);
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
setInterval(() => {}, 1 << 30);
