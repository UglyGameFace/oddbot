// src/bot.js - FINAL, COMPLETE, AND CORRECTED
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import healthService from './services/healthService.js';
import { registerAllCallbacks } from './bot/handlers/callbackManager.js';

// Handler imports
import { registerAI } from './bot/handlers/ai.js';
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
import { registerCustom } from './bot/handlers/custom.js';
import { registerQuant } from './bot/handlers/quant.js';
import { registerPlayer } from './bot/handlers/player.js';
import { registerSettings } from './bot/handlers/settings.js';
import { registerSystem } from './bot/handlers/system.js';
import { registerTools } from './bot/handlers/tools.js';
import { registerChat } from './bot/handlers/chat.js';

// Global error hooks
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
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL || '';
const WEBHOOK_SECRET = (env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = (APP_URL || '').startsWith('https');

let bot;
let server;
let isServiceReady = false;

function validateEnvironment() {
  if (!TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
}

// Health endpoints
app.get('/health', (_req, res) => res.status(200).json({ status: 'OK', ready: isServiceReady }));

server = app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}.`);
});

async function registerAllHandlers(botInstance) {
    registerAI(botInstance);
    registerAnalytics(botInstance);
    registerModel(botInstance);
    registerCacheHandler(botInstance);
    registerCustom(botInstance);
    registerQuant(botInstance);
    registerPlayer(botInstance);
    registerSettings(botInstance);
    registerSystem(botInstance);
    registerTools(botInstance);
    registerChat(botInstance);
    registerAllCallbacks(botInstance);
}

async function initializeBot() {
    try {
      console.log('🚀 Starting ParlayBot initialization...');
      validateEnvironment();
      
      const botOptions = { polling: !USE_WEBHOOK };
      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created');

      await registerAllHandlers(bot);
      console.log('✅ All command and callback handlers registered.');

      if (USE_WEBHOOK) {
        const webhookPath = `/webhook/${TOKEN}`;
        const targetWebhookUrl = `${APP_URL}${webhookPath}`;
        await bot.setWebHook(targetWebhookUrl, { secret_token: WEBHOOK_SECRET });
        console.log(`✅ Webhook set to ${targetWebhookUrl}`);
        app.use(express.json());
        app.post(webhookPath, (req, res) => {
          bot.processUpdate(req.body);
          res.sendStatus(200);
        });
      }

      const me = await bot.getMe();
      console.log(`✅ Bot @${me.username} fully initialized.`);
      isServiceReady = true;
      
      console.log('🎉 Application startup complete! Bot is now responsive.');
      return bot;
    } catch (error) {
      console.error('💥 FATAL INITIALIZATION ERROR:', error.message, error.stack);
      process.exit(1);
    }
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;
  
  try {
    if (bot) {
      if (USE_WEBHOOK) await bot.deleteWebHook().catch(e => console.warn('Webhook delete failed', e.message));
      else if (bot.isPolling()) await bot.stopPolling().catch(e => console.warn('Polling stop failed', e.message));
    }
  } catch (error) {
    console.warn('⚠️ Error during bot shutdown:', error.message);
  }
  
  server.close(() => {
    console.log('✅ HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initializeBot();

export { bot };
