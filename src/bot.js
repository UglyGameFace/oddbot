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
  // Optional: Consider if you truly want to exit on all uncaught exceptions
  // process.exit(1);
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
if (env.NODE_ENV !== 'development' && !APP_URL.startsWith('https')) {
  // Allow non-HTTPS only in development
  console.warn("⚠️ WARNING: Running without HTTPS. Webhook mode may fail in production.");
  // throw new Error('APP_URL must be set with HTTPS for webhook mode in production');
} else if (!APP_URL && env.NODE_ENV !== 'development') {
    throw new Error('APP_URL must be set for webhook mode in production');
}


let bot;
let server;
let keepAliveInterval;
let isServiceReady = false;
let healthCheckCount = 0;
let initializationPromise = null;

// --- Utility Functions ---
function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN'];
  // APP_URL is only required if not in development
  if (env.NODE_ENV !== 'development') {
    required.push('APP_URL');
  }
  const missing = required.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  console.log('🔧 Webhook Configuration:', {
    APP_URL: env.APP_URL ? `${env.APP_URL.substring(0, 20)}...` : 'Not set (Dev mode?)',
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
}

export async function safeEditMessage(chatId, messageId, text, options = {}) {
  console.log(`🔧 safeEditMessage called: chatId=${chatId}, messageId=${messageId}, textLength=${text?.length}`);

  if (!bot) {
    console.error('❌ CRITICAL: Bot instance is undefined in safeEditMessage');
    return null; // Return null on failure
  }
   // Ensure messageId is valid
  if (!messageId || typeof messageId !== 'number') {
      console.warn(`⚠️ safeEditMessage: Invalid messageId (${messageId}), cannot edit.`);
      return null;
  }
  // Prevent editing with empty text
  if (text === null || text === undefined || text === '') {
      console.warn(`⚠️ safeEditMessage: Attempted to edit with empty text for messageId ${messageId}. Skipping.`);
      return null;
  }


  try {
    const editOptions = { parse_mode: 'HTML', ...options };
    // Ensure reply_markup is an object, even if empty
    if (!editOptions.reply_markup || typeof editOptions.reply_markup !== 'object') {
      editOptions.reply_markup = { inline_keyboard: [] };
    }
     // Ensure inline_keyboard is an array
     if (!Array.isArray(editOptions.reply_markup.inline_keyboard)) {
         editOptions.reply_markup.inline_keyboard = [];
     }


    console.log(`🔄 Attempting to edit message ${messageId}...`);
    const result = await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...editOptions
    });

    console.log(`✅ Message ${messageId} edited successfully`);
    return result;

  } catch (error) {
     // Log more detailed error information
    const errorBody = error.response?.body;
    const errorCode = errorBody?.error_code;
    const errorDesc = errorBody?.description;

    console.error(`❌ Message edit error for messageId ${messageId}:`, {
      code: errorCode,
      description: errorDesc,
      rawMessage: error.message
    });

    // Handle specific, non-critical errors gracefully
    if (errorDesc?.includes('message is not modified')) {
      console.log(`ℹ️ Message ${messageId} not modified (no change)`);
      return null; // Return null, not an error
    }
    if (errorCode === 400 && errorDesc?.includes('message to edit not found')) {
      console.log(`ℹ️ Message ${messageId} to edit not found (might have been deleted)`);
      return null; // Return null
    }
     // Handle "Too Many Requests" specifically
    if (errorCode === 429) {
        console.warn(`⚠️ Rate limited by Telegram while editing message ${messageId}. Will retry later if needed.`);
        // Don't throw, allow potential future edits
        return null;
    }


    // Log other errors to Sentry but don't crash
    sentryService.captureError(error, { component: 'safeEditMessage', chatId, messageId, level: 'warning' });
    return null; // Return null on potentially recoverable errors too
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
    const isHealthy = healthReport?.ok === true; // Access simplified health status
    res.status(isHealthy ? 200 : 503).json({ status: isHealthy ? 'OK' : 'DEGRADED', ...healthReport, checks: healthCheckCount, timestamp: new Date().toISOString() });
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
    const isReady = healthReport?.ok === true; // Access simplified health status
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
      // --- ADDED DEBUG COMMANDS TO LIST ---
      { command: 'debugsettings', description: 'Debug settings storage' },
      { command: 'fixsettings', description: 'Reset settings to default' },
      { command: 'testredis', description: 'Test Redis connection' },
    ];

    // *** STARTUP CRASH FIX: Wrap setMyCommands in a try...catch block ***
    try {
        await bot.setMyCommands(commands);
        console.log('✅ Bot commands set successfully.');
    } catch (commandError) {
        console.warn(`⚠️ Failed to set bot commands during startup: ${commandError.message}`);
        // Log the error but allow initialization to continue
        sentryService.captureError(commandError, { component: 'bot_init', operation: 'setMyCommands', level: 'warning' });
        console.log('Continuing initialization... Commands might be set later.');
    }
    // *** END FIX ***

    bot.on('message', (msg) => {
      if (msg.text && msg.text.startsWith('/')) {
        console.log(`📨 Received command: ${msg.text} from ${msg.chat.id}`);
      }
    });

    console.log('✅ All command handlers registered successfully');
    return true;
  } catch (error) {
    console.error('❌ FATAL: Command handler registration failed:', error); // Log clearly
    // If handler registration itself fails, it's critical, re-throw
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
        polling: false, // Explicitly false for webhook
        request: {
          timeout: 60000,
          headers: { 'Content-Type': 'application/json' }
        }
      };

      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created (Webhook-only mode)');

      // Register handlers and callbacks AFTER bot instance is created
      await registerAllCommands(bot); // Register command text handlers
      registerAllCallbacks(bot); // Register inline button handlers

      app.use(express.json()); // Use JSON middleware for webhook body parsing
      if (sentryService.attachExpressPreRoutes) {
        sentryService.attachExpressPreRoutes(app);
      }

      console.log('🌐 Configuring webhook mode...');
      const webhookPath = `/webhook/${TOKEN}`; // Unique path per bot token
      const targetWebhookUrl = `${APP_URL}${webhookPath}`;

      try {
        const currentWebhook = await bot.getWebHookInfo();
        console.log('📋 Current webhook info:', {
          url: currentWebhook.url ? `${currentWebhook.url.substring(0, 50)}...` : 'None',
          has_custom_certificate: currentWebhook.has_custom_certificate,
          pending_update_count: currentWebhook.pending_update_count
        });

        // Set the webhook
        console.log(`🔄 Setting webhook to: ${targetWebhookUrl}`);
        const setResult = await bot.setWebHook(targetWebhookUrl, {
          secret_token: WEBHOOK_SECRET || undefined,
          drop_pending_updates: true // Drop updates missed during downtime
        });
        if (!setResult) {
            throw new Error(`Telegram API returned false on setWebHook.`);
        }
        console.log(`✅ Webhook set successfully.`);

        // Verify webhook immediately
        const verifiedWebhook = await bot.getWebHookInfo();
        if (verifiedWebhook.url !== targetWebhookUrl) {
            console.error(`❌ Webhook verification failed! Expected: ${targetWebhookUrl}, Got: ${verifiedWebhook.url}`);
            throw new Error(`Webhook verification failed. URL mismatch.`);
        }
        console.log('✅ Webhook verified:', {
          url_set: verifiedWebhook.url ? 'Yes' : 'No',
          pending_updates: verifiedWebhook.pending_update_count
        });

      } catch (webhookError) {
        console.error('❌ Webhook setup failed critically:', webhookError.message, webhookError.stack);
        throw webhookError; // This is fatal, throw it up
      }

      // Define the webhook route AFTER setting it with Telegram
      app.post(webhookPath, (req, res) => {
        // Verify secret token if provided
        if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
          console.warn('⚠️ Webhook secret mismatch from IP:', req.ip);
          return res.sendStatus(403); // Forbidden
        }
        console.log('📨 Webhook received update');
        bot.processUpdate(req.body); // Let the library handle the update
        res.sendStatus(200); // Acknowledge receipt immediately
      });


      if (sentryService.attachExpressPostRoutes) {
        sentryService.attachExpressPostRoutes(app);
      }

      console.log('⏱️ Waiting for all essential services to pass health check (max 90s)...');
      const readyCheck = await healthService.waitForReady(90000);

      if (!readyCheck) {
          console.error('❌ Critical services failed to become ready within the startup timeout.');
          // Decide whether to throw or continue degraded
          // For now, let's allow degraded start but log heavily
          sentryService.captureMessage('Bot started in degraded state - services not ready', 'error');
          // throw new Error('Critical services failed to become ready.');
      }

      isServiceReady = true;
      console.log('🎯 Service marked as ready for health checks');

      // --- CACHE WARMUP ---
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

      // --- FINAL BOT CHECK ---
      try {
        const me = await bot.getMe();
        console.log(`✅ Bot @${me.username} fully initialized in webhook-only mode`);

        // Test responsiveness again after webhook setup
        console.log('🧪 Testing bot responsiveness post-webhook setup...');
        const testCommandsAfter = await bot.getMyCommands();
        console.log(`✅ Bot commands verified post-webhook: ${testCommandsAfter.length} commands loaded`);

      } catch (botError) {
        console.error('❌ Bot final setup check failed (getMe/getMyCommands):', botError.message);
        console.warn('Continuing startup, but bot interaction might fail...');
        sentryService.captureError(botError, { component: 'bot_init', operation: 'finalCheck', level: 'warning' });
      }

      keepAliveInterval = setInterval(() => {
        if (isServiceReady) {
          console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
        }
      }, 600000); // Log every 10 minutes

      console.log('🎉 Application startup complete! Bot should now respond to commands via webhook.');
      return true; // Indicate successful initialization

    } catch (error) {
      isServiceReady = false;
      initializationPromise = null; // Allow retry on next call
      console.error('💥 FATAL Initialization failed:', error.message);
      console.error('Stack trace:', error.stack);
      sentryService.captureError(error, { component: 'bot_init', operation: 'overall', level: 'fatal' });

      // Exit process after a short delay to allow logs to flush
      console.log('Exiting due to fatal initialization error...');
      setTimeout(() => process.exit(1), 2000);

      // We don't need to throw again as we are exiting
      // throw error; // Re-throw to ensure promise rejection if not exiting
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
      console.log('🌐 Webhook remains active during shutdown/restart');
      // Optional: Delete webhook if you want clean shutdown
      // try { await bot.deleteWebHook(); console.log('Webhook deleted.'); } catch (e) {}
    }
    // Import redisService dynamically ONLY during shutdown
    const redisService = (await import('./services/redisService.js')).default;
    if (redisService && redisService.isConnected()) {
        await redisService.disconnect();
        console.log('✅ Redis connection closed.');
    }
  } catch (error) {
    console.warn('⚠️ Error during bot/redis shutdown:', error.message);
  }

  // Close the HTTP server
  server.close((err) => {
    if (err) {
      console.error("❌ Error closing HTTP server:", err);
      process.exit(1); // Exit with error if server close fails
    }
    console.log('✅ HTTP server closed.');
    process.exit(0); // Clean exit
  });

  // Force shutdown after a timeout if graceful shutdown fails
  setTimeout(() => {
    console.warn('⚠️ Forcing shutdown after 5s timeout...');
    process.exit(1);
  }, 5000); // 5 seconds timeout
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the initialization
initializeBot().catch((error) => {
  // Error is already logged inside initializeBot, just ensure process exits if it didn't already
  console.error('💥 Catching final initialization error - process should be exiting.');
  // process.exit(1); // Ensure exit if initializeBot failed to do so
});
