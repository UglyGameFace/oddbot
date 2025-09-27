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
  sentryService.captureError(new Error(`Unhandled Rejection: ${reason}`), { extra: { promise } });
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  sentryService.captureError(error);
  process.exit(1);
});

const app = express();
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const USE_WEBHOOK = env.APP_URL && env.APP_URL.startsWith('https');
const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });
let server;

// --- Main Application Start ---
async function main() {
  console.log('Registering all bot handlers...');
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');

  console.log('Setting up Express server and middleware...');
  app.use(express.json());
  sentryService.attachExpressPreRoutes?.(app);
  
  app.get('/liveness', (_req, res) => {
    console.log('✅ Health check endpoint /liveness was hit successfully.');
    res.sendStatus(200);
  });
  ['/', '/health', '/healthz'].forEach(path => app.get(path, (_req, res) => res.send('OK')));

  if (USE_WEBHOOK) {
    const webhookPath = `/webhook/${TOKEN}`;
    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    console.log('Setting webhook...');
    await bot.setWebHook(`${env.APP_URL}${webhookPath}`);
    console.log(`Webhook successfully set to: ${env.APP_URL}${webhookPath}`);
  }

  sentryService.attachExpressPostRoutes?.(app);

  console.log('Setting bot commands in Telegram...');
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
  console.log('✅ Bot commands have been set in Telegram.');
  
  const me = await bot.getMe();
  console.log(`✅ Bot @${me.username} fully initialized.`);
  
  const PORT = env.PORT || 8080;
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}. Bot is online in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
  });
}

// --- Graceful Shutdown Logic ---
const shutdown = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('✅ HTTP server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

// --- Execute Main Function and Keep Process Alive ---
main().then(() => {
  console.log('Application startup sequence complete. Process will now run indefinitely.');
  // This is the definitive fix: We attach signal handlers here, after the async main function has completed.
  // This ensures the process stays alive to listen for these signals, rather than exiting.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch((e) => {
  console.error('❌ Fatal Bot Initialization Error:', e);
  sentryService.captureError(e);
  process.exit(1);
});
