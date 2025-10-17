// src/bot.js - FINAL ABSOLUTE FIXED VERSION WITH CACHE WARMUP + DEBUG HANDLERS
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import healthService from './services/healthService.js';
import { registerAllCallbacks } from './bot/handlers/callbackManager.js';

// --- Handler imports ---
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
import { registerCustom } from './bot/handlers/custom.js';
import { registerAI } from './bot/handlers/ai.js';
import { registerQuant } from './bot/handlers/quant.js';
import { registerPlayer } from './bot/handlers/player.js';
import { registerSettings } from './bot/handlers/settings.js';
import { registerSystem } from './bot/handlers/system.js';
import { registerTools } from './bot/handlers/tools.js';
import { registerChat } from './bot/handlers/chat.js';
// --- ADD DEBUG HANDLERS IMPORT ---
import { registerDebugSettings } from './bot/handlers/debugSettings.js';

// --- Service imports for cache warmup ---
import oddsService from './services/oddsService.js';
import gamesService from './services/gamesService.js';

// --- Global error hooks ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection: ${reason}`), { extra: { promise } });
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  sentryService.captureError(error);
  process.exit(1);
});

// --- App and bot bootstrap ---
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// --- Global Config & State ---
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL || '';
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();

// ENFORCE WEBHOOK-ONLY MODE
if (!APP_URL.startsWith('https')) {
  throw new Error('APP_URL must be set with HTTPS for webhook mode');
}

let bot;
let server;
let keepAliveInterval;
let isServiceReady = false;
let healthCheckCount = 0;
let initializationPromise = null;

// --- Utility Functions ---
function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN', 'APP_URL'];
  const missing = required.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  console.log('🔧 Webhook Configuration:', {
    APP_URL: env.APP_URL ? `${env.APP_URL.substring(0, 20)}...` : 'Not set',
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
}

export async function safeEditMessage(chatId, messageId, text, options = {}) {
  console.log(`🔧 safeEditMessage called: chatId=${chatId}, messageId=${messageId}, textLength=${text?.length}`);
  
  if (!bot) {
    console.error('❌ CRITICAL: Bot instance is undefined in safeEditMessage');
    return;
  }
  
  try {
    const editOptions = { parse_mode: 'HTML', ...options };
    if (!editOptions.reply_markup) {
      editOptions.reply_markup = { inline_keyboard: [] };
    }
    
    console.log(`🔄 Attempting to edit message...`);
    const result = await bot.editMessageText(text, { 
      chat_id: chatId, 
      message_id: messageId, 
      ...editOptions 
    });
    
    console.log(`✅ Message edited successfully`);
    return result;
    
  } catch (error) {
    console.error(`❌ Message edit error:`, {
      code: error.response?.body?.error_code,
      description: error.response?.body?.description,
      message: error.message
    });
    
    if (error.response?.body?.description?.includes('message is not modified')) { 
      console.log('ℹ️ Message not modified (no change)');
      return; 
    }
    if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('inline keyboard expected')) {
      console.log('🔄 Retrying without keyboard...');
      return await bot.editMessageText(text, { 
        chat_id: chatId, 
        message_id: messageId, 
        parse_mode: options.parse_mode || 'HTML', 
        reply_markup: { inline_keyboard: [] } 
      });
    }
    if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('message to edit not found')) { 
      console.log('ℹ️ Message to edit not found');
      return; 
    }
    throw error;
  }
}

// --- Health endpoints ---
app.get('/health', (_req, res) => res.sendStatus(200));

app.get('/', (_req, res) => {
  healthCheckCount++;
  console.log(`✅ Root health check #${healthCheckCount}`);
  res.status(200).json({
    status: isServiceReady ? 'OK' : 'STARTING',
    service: 'ParlayBot',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ready: isServiceReady,
    checks: healthCheckCount
  });
});

app.get('/healthz', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /healthz check #${healthCheckCount}`);
  if (!isServiceReady) {
    return res.status(503).json({ status: 'Service Starting', checks: healthCheckCount, uptime: process.uptime() });
  }
  try {
    const healthReport = await healthService.getHealth();
    res.status(healthReport.overall.healthy ? 200 : 503).json({ status: healthReport.overall.healthy ? 'OK' : 'DEGRADED', ...healthReport, checks: healthCheckCount, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'ERROR', error: error.message, checks: healthCheckCount, timestamp: new Date().toISOString() });
  }
});

app.get('/liveness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /liveness check #${healthCheckCount}`);
  res.status(200).json({ status: 'LIVE', initializing: !isServiceReady, timestamp: new Date().toISOString(), uptime: process.uptime(), checks: healthCheckCount });
});

app.get('/readiness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /readiness check #${healthCheckCount}`);
  if (!isServiceReady) {
    return res.status(503).json({ status: 'NOT_READY', initializing: true, checks: healthCheckCount, uptime: process.uptime() });
  }
  try {
    const healthReport = await healthService.getHealth();
    const isReady = healthReport.overall.healthy;
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'READY' : 'NOT_READY', ...healthReport, checks: healthCheckCount, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'NOT_READY', error: error.message, checks: healthCheckCount, timestamp: new Date().toISOString() });
  }
});

app.head('/health', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));
app.head('/readiness', (_req, res) => res.sendStatus(200));

// Start the server immediately
server = app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}. Health checks are live.`);
});

async function registerAllCommands(bot) {
  console.log('🔧 Starting comprehensive command registration...');
  try {
    // Register all handler modules
    registerAI(bot);
    registerAnalytics(bot);
    registerModel(bot);
    registerCacheHandler(bot);
    registerCustom(bot);
    registerQuant(bot);
    registerPlayer(bot);
    registerSettings(bot);
    registerSystem(bot);
    registerTools(bot);
    registerChat(bot);
    // --- ADD DEBUG HANDLERS REGISTRATION ---
    registerDebugSettings(bot);
    
    const commands = [
      { command: 'ai', description: 'Launch the AI Parlay Builder' },
      { command: 'chat', description: 'Ask questions (compact chatbot)' },
      { command: 'custom', description: 'Manually build a parlay slip' },
      { command: 'player', description: 'Find props for a specific player' },
      { command: 'settings', description: 'Configure bot preferences' },
      { command: 'status', description: 'Check bot operational status' },
      { command: 'tools', description: 'Access admin tools' },
      { command: 'help', description: 'Show the command guide' },
    ];

    await bot.setMyCommands(commands);
    
    bot.on('message', (msg) => {
      if (msg.text && msg.text.startsWith('/')) {
        console.log(`📨 Received command: ${msg.text} from ${msg.chat.id}`);
      }
    });

    console.log('✅ All command handlers registered successfully');
    return true;
  } catch (error) {
    console.error('❌ Command registration failed:', error);
    throw error;
  }
}

async function initializeBot() {
  if (initializationPromise) { return initializationPromise; }
  initializationPromise = (async () => {
    try {
      console.log('🚀 Starting ParlayBot initialization...');
      validateEnvironment();
      if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
      
      const botOptions = { 
        polling: false,
        request: { 
          timeout: 60000,
          headers: {
            'Content-Type': 'application/json'
          }
        } 
      };
      
      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created (Webhook-only mode)');

      await registerAllCommands(bot);
      registerAllCallbacks(bot);
      
      app.use(express.json());
      if (sentryService.attachExpressPreRoutes) {
        sentryService.attachExpressPreRoutes(app);
      }

      console.log('🌐 Configuring webhook mode...');
      const webhookPath = `/webhook/${TOKEN}`;
      const targetWebhookUrl = `${APP_URL}${webhookPath}`;

      try {
        const currentWebhook = await bot.getWebHookInfo();
        console.log('📋 Current webhook info:', { 
          url: currentWebhook.url ? `${currentWebhook.url.substring(0, 50)}...` : 'None', 
          has_custom_certificate: currentWebhook.has_custom_certificate, 
          pending_update_count: currentWebhook.pending_update_count 
        });

        console.log(`🔄 Setting webhook to: ${targetWebhookUrl}`);
        await bot.setWebHook(targetWebhookUrl, { 
          secret_token: WEBHOOK_SECRET || undefined,
          drop_pending_updates: true
        });
        console.log(`✅ Webhook set: ${targetWebhookUrl}`);

        const verifiedWebhook = await bot.getWebHookInfo();
        console.log('✅ Webhook verified:', {
          url_set: verifiedWebhook.url ? 'Yes' : 'No',
          pending_updates: verifiedWebhook.pending_update_count
        });
      } catch (webhookError) {
        console.error('❌ Webhook setup failed:', webhookError.message);
        throw webhookError;
      }

      app.post(webhookPath, (req, res) => {
        if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
          console.warn('⚠️ Webhook secret mismatch');
          return res.sendStatus(403);
        }
        console.log('📨 Webhook received update');
        bot.processUpdate(req.body);
        res.sendStatus(200);
      });

      if (sentryService.attachExpressPostRoutes) {
        sentryService.attachExpressPostRoutes(app);
      }
      
      console.log('⏱️ Waiting for all essential services to pass health check (max 90s)...');
      const readyCheck = await healthService.waitForReady(90000); 
      
      if (!readyCheck) {
          throw new Error('Critical services failed to become ready within the startup timeout.');
      }

      isServiceReady = true;
      console.log('🎯 Service marked as ready for health checks');

      // --- CACHE WARMUP MOVED HERE ---
      console.log('🔥 Starting cache warmup...');
      try {
        await Promise.all([
          oddsService.warmupCache?.().catch(e => console.warn('Odds cache warmup warning:', e.message)),
          gamesService.warmupCache?.().catch(e => console.warn('Games cache warmup warning:', e.message))
        ]);
        console.log('✅ Cache warmup completed');
      } catch (error) {
        console.warn('⚠️ Cache warmup had issues:', error.message);
      }

      try {
        const me = await bot.getMe();
        console.log(`✅ Bot @${me.username} fully initialized in webhook-only mode`);
        
        console.log('🧪 Testing bot responsiveness...');
        const testCommands = await bot.getMyCommands();
        console.log(`✅ Bot commands verified: ${testCommands.length} commands loaded`);
        
      } catch (botError) {
        console.error('❌ Bot final setup failed:', botError.message);
        throw botError;
      }
      
      keepAliveInterval = setInterval(() => {
        if (isServiceReady) {
          console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
        }
      }, 600000);
      
      console.log('🎉 Application startup complete! Bot should now respond to commands via webhook.');
      return true;
    } catch (error) {
      isServiceReady = false;
      initializationPromise = null;
      console.error('💥 Initialization failed:', error.message);
      console.error('Stack trace:', error.stack);
      
      if (String(error.message).includes('429')) {
        console.log('⏳ Rate limit error during Telegram setup, waiting 10s before exit...');
        sentryService.captureError(error);
        setTimeout(() => process.exit(1), 10000);
      } else {
        sentryService.captureError(error);
        process.exit(1);
      }
      
      throw error;
    }
  })();
  return initializationPromise;
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;
  if (keepAliveInterval) { clearInterval(keepAliveInterval); }
  try {
    if (bot) {
      console.log('🌐 Webhook remains active during restart');
    }
    const { default: redisService } = await import('./services/redisService.js');
    if (redisService && redisService.isConnected()) {
        await redisService.disconnect();
        console.log('✅ Redis connection closed.');
    }
  } catch (error) {
    console.warn('⚠️ Error during bot/redis shutdown:', error.message);
  }
  server.close(() => {
    console.log('✅ HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('⚠️ Forcing shutdown after timeout...');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initializeBot().catch((error) => {
  console.error('💥 Fatal initialization error:', error.message);
});
