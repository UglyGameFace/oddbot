// src/bot.js

import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
// --- Your handler/module imports
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
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}
const APP_URL = env.APP_URL || '';
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = (env.USE_WEBHOOK === true) || APP_URL.startsWith('https');
const PORT = Number(process.env.PORT) || Number(env.PORT) || 3000; // strictly bind to process.env.PORT for Railway, fallback only for local dev
const HOST = env.HOST || '0.0.0.0';

const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

// Enhanced Health endpoints for Railway compatibility
app.get('/', (_req, res) => res.status(200).json({ 
  status: 'OK', 
  service: 'ParlayBot',
  timestamp: new Date().toISOString(),
  uptime: process.uptime()
}));
app.get('/health', (_req, res) => res.sendStatus(200));
app.head('/health', (_req, res) => res.sendStatus(200));
app.get('/liveness', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));

let server;
let keepAliveInterval;

async function main() {
  // Register all core handlers (your existing logic)
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);

  app.use(express.json());
  sentryService.attachExpressPreRoutes?.(app);

  if (USE_WEBHOOK) {
    const webhookPath = `/webhook/${TOKEN}`;
    app.post(
      webhookPath,
      (req, res, next) => {
        if (WEBHOOK_SECRET) {
          const incoming = req.headers['x-telegram-bot-api-secret-token'];
          if (incoming !== WEBHOOK_SECRET) return res.sendStatus(403);
        }
        next();
      },
      (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      }
    );
    await bot.setWebHook(`${APP_URL}${webhookPath}`, {
      secret_token: WEBHOOK_SECRET || undefined,
    });
    console.log(`Webhook successfully set to: ${APP_URL}${webhookPath}`);
  }

  sentryService.attachExpressPostRoutes?.(app);

  // Enhanced server startup with error handling
  try {
    server = app.listen(PORT, HOST, () => {
      console.log(`🚀 Server listening on ${HOST}:${PORT}. Bot is starting in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
    });
    
    // Handle server errors
    server.on('error', (error) => {
      console.error('❌ Server error:', error);
      sentryService.captureError(error);
      process.exit(1);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    sentryService.captureError(error);
    process.exit(1);
  }

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
  const me = await bot.getMe();
  console.log(`✅ Bot @${me.username} fully initialized.`);
  
  // Start keep-alive mechanism
  keepAliveInterval = setInterval(() => {
    console.log('🤖 Bot process active - waiting for requests...');
  }, 300000); // Log every 5 minutes
  
  console.log('Application startup sequence complete. Process will now run indefinitely.');
}

const shutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  // Clear keep-alive interval
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  
  try {
    if (!USE_WEBHOOK) {
      try { 
        await bot.stopPolling({ cancel: true, reason: signal }); 
        console.log('✅ Bot polling stopped.');
      } catch (pollingError) {
        console.warn('⚠️ Error stopping polling:', pollingError);
      }
    } else {
      try { 
        await bot.deleteWebHook(); 
        console.log('✅ Webhook deleted.');
      } catch (webhookError) {
        console.warn('⚠️ Error deleting webhook:', webhookError);
      }
    }
  } finally {
    if (server) {
      server.close(() => {
        console.log('✅ HTTP server closed.');
        process.exit(0);
      });
      
      // Force close after 10 seconds
      setTimeout(() => {
        console.log('⚠️ Forcing shutdown...');
        process.exit(1);
      }, 10000);
    } else {
      process.exit(0);
    }
  }
};

// Enhanced shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((e) => {
  console.error('❌ Fatal Bot Initialization Error:', e);
  sentryService.captureError(e);
  process.exit(1);
});
