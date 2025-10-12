// src/bot.js - FINAL ABSOLUTE FIXED VERSION
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import healthService from './services/healthService.js';
import { registerAllCallbacks } from './bot/handlers/callbackManager.js';

// --- Handler imports ---
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
import { registerCustom } from './bot/handlers/custom.js';
import { registerAI } from './bot/handlers/ai.js';
import { registerQuant } from './bot/handlers/quant.js';
import { registerPlayer } from './bot/handlers/player.js';
import { registerSettings } from './bot/handlers/settings.js';
import { registerSystem } from './bot/handlers/system.js';
import { registerTools } from './bot/handlers/tools.js';
import { registerChat } from './bot/handlers/chat.js';

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
  if (!bot) {
    console.warn('⚠️ Bot not initialized, cannot edit message');
    return;
  }
  try {
    const editOptions = { parse_mode: 'HTML', ...options };
    if (!editOptions.reply_markup) {
      editOptions.reply_markup = { inline_keyboard: [] };
    }
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...editOptions });
  } catch (error) {
    if (error.response?.body?.description?.includes('message is not modified')) { return; }
    if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('inline keyboard expected')) {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: options.parse_mode || 'HTML', reply_markup: { inline_keyboard: [] } });
    }
    if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('message to edit not found')) { return; }
    console.error('❌ Message edit failed:', error.message);
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

// FIXED: Register ALL command handlers including text commands
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
    
    // FIXED: Add explicit command handlers for all commands
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

    // Set bot commands in Telegram UI
    await bot.setMyCommands(commands);
    
    // FIXED: Add explicit text handlers for all commands
    bot.onText(/^\/ai$/, (msg) => {
      console.log(`🎯 /ai command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/chat$/, (msg) => {
      console.log(`🎯 /chat command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/custom$/, (msg) => {
      console.log(`🎯 /custom command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/player$/, (msg) => {
      console.log(`🎯 /player command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/settings$/, (msg) => {
      console.log(`🎯 /settings command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/status$/, (msg) => {
      console.log(`🎯 /status command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/tools$/, (msg) => {
      console.log(`🎯 /tools command received from ${msg.chat.id}`);
    });
    
    bot.onText(/^\/help$/, (msg) => {
      console.log(`🎯 /help command received from ${msg.chat.id}`);
    });

    // Global command logger
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
      
      // FIXED: Webhook-only configuration - NO POLLING
      const botOptions = { 
        polling: false, // CRITICAL: Disable polling completely
        request: { 
          timeout: 60000,
          // Add proper webhook headers
          headers: {
            'Content-Type': 'application/json'
          }
        } 
      };
      
      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created (Webhook-only mode)');

      // FIXED: Register ALL handlers BEFORE setting up webhook
      await registerAllCommands(bot);
      registerAllCallbacks(bot);
      
      app.use(express.json());
      if (sentryService.attachExpressPreRoutes) {
        sentryService.attachExpressPreRoutes(app);
      }

      // FIXED: Webhook configuration with proper timing
      console.log('🌐 Configuring webhook mode...');
      const webhookPath = `/webhook/${TOKEN}`;
      const targetWebhookUrl = `${APP_URL}${webhookPath}`;

      // Get current webhook info first
      try {
        const currentWebhook = await bot.getWebHookInfo();
        console.log('📋 Current webhook info:', { 
          url: currentWebhook.url ? `${currentWebhook.url.substring(0, 50)}...` : 'None', 
          has_custom_certificate: currentWebhook.has_custom_certificate, 
          pending_update_count: currentWebhook.pending_update_count 
        });

        // Always set webhook to ensure it's correct
        console.log(`🔄 Setting webhook to: ${targetWebhookUrl}`);
        await bot.setWebHook(targetWebhookUrl, { 
          secret_token: WEBHOOK_SECRET || undefined,
          drop_pending_updates: true // Clear any pending updates
        });
        console.log(`✅ Webhook set: ${targetWebhookUrl}`);

        // Verify webhook was set
        const verifiedWebhook = await bot.getWebHookInfo();
        console.log('✅ Webhook verified:', {
          url_set: verifiedWebhook.url ? 'Yes' : 'No',
          pending_updates: verifiedWebhook.pending_update_count
        });
      } catch (webhookError) {
        console.error('❌ Webhook setup failed:', webhookError.message);
        throw webhookError;
      }

      // FIXED: Webhook route handler - MUST be after all registrations
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
      
      // CRITICAL FIX: Block until all services are ready before marking the bot as ready.
      // This is the line that previously failed due to the method not being found.
      console.log('⏱️ Waiting for all essential services to pass health check (max 30s)...');
      const readyCheck = await healthService.waitForReady(30000); 
      
      if (!readyCheck) {
          throw new Error('Critical services failed to become ready within the startup timeout.');
      }

      isServiceReady = true;
      console.log('🎯 Service marked as ready for health checks');

      // FIXED: Final bot setup with proper error handling
      try {
        const me = await bot.getMe();
        console.log(`✅ Bot @${me.username} fully initialized in webhook-only mode`);
        
        console.log('🧪 Testing bot responsiveness...');
        const testCommands = await bot.getMyCommands();
        console.log(`✅ Bot commands verified: ${testCommands.length} commands loaded`);
        
        // Test message handler
        bot.on('message', (msg) => {
          if (msg.text && msg.text.startsWith('/')) {
            console.log(`🎯 Command processed: "${msg.text}" from user ${msg.from.id} in chat ${msg.chat.id}`);
          }
        });
        
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
      
      // FIX: Handle 429 errors from Telegram API on startup
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

// FIXED: Webhook-only shutdown (no polling cleanup)
const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;
  if (keepAliveInterval) { clearInterval(keepAliveInterval); }
  try {
    if (bot) {
      // Webhook-only: We don't delete webhook on shutdown to maintain availability during restarts
      console.log('🌐 Webhook remains active during restart');
    }
    const redis = await import('./services/redisService.js').then(m => m.default);
    // Use the exported client to quit safely.
    if (redis && (redis.status === 'ready' || redis.status === 'connecting')) {
        await redis.quit();
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
  // NOTE: Error handling is now inside initializeBot's catch block to prevent double-logging
  // This outer catch can be simplified, but kept for final safety measure.
  if (String(error.message).includes('429')) {
    console.log('⏳ Rate limit error, waiting before exit...');
  } else {
    // The inner catch handles Sentry and process.exit, but this ensures a clean exit if anything slipped.
  }
});
