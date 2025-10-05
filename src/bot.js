// src/bot.js - FINALIZED AND CORRECTED
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

// App and bot bootstrap
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Global Config & State
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL || '';
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = (env.APP_URL || '').startsWith('https');

let bot;
let server;
let keepAliveInterval;
let isServiceReady = false;
let healthCheckCount = 0;
let initializationPromise = null;

function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN'];
  const missing = required.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Health endpoints
app.get('/health', (_req, res) => {
  healthCheckCount++;
  res.status(200).json({ status: 'OK', ready: isServiceReady, checks: healthCheckCount });
});

app.get('/', (_req, res) => {
  healthCheckCount++;
  res.status(200).json({ status: isServiceReady ? 'OK' : 'STARTING', uptime: process.uptime() });
});

// Start the server immediately
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
  if (initializationPromise) { 
    return initializationPromise; 
  }
  
  initializationPromise = (async () => {
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

      // Keep alive interval
      keepAliveInterval = setInterval(() => {
        if (isServiceReady) {
          console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
        }
      }, 600000);
      
      console.log('🎉 Application startup complete!');
      return bot;
    } catch (error) {
      console.error('💥 Initialization failed:', error.message);
      process.exit(1);
    }
  })();
  
  return initializationPromise;
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;
  
  if (keepAliveInterval) { 
    clearInterval(keepAliveInterval); 
  }
  
  try {
    if (bot) {
      if (USE_WEBHOOK) {
        await bot.deleteWebHook();
        console.log('✅ Webhook removed.');
      } else if (bot.isPolling()) {
        await bot.stopPolling();
        console.log('✅ Bot polling stopped.');
      }
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
