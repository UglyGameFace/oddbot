// src/bot.js - FINAL ABSOLUTE FIXED VERSION WITH STARTUP CRASH FIX + IMPROVED ERROR HANDLING
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
  // process.exit(1); // Exiting might hide the root cause in some deployment scenarios
});

// --- App and bot bootstrap ---
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// --- Global Config & State ---
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL || '';
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();

// ENFORCE WEBHOOK-ONLY MODE (Allow non-HTTPS only in development)
if (env.NODE_ENV !== 'development' && !APP_URL.startsWith('https://')) {
  console.warn("⚠️ WARNING: APP_URL does not start with https://. Webhook mode may fail.");
  // Consider throwing an error in production environments
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
  // APP_URL is only required if not in development and webhook is intended
  if (env.NODE_ENV !== 'development' && env.USE_WEBHOOK !== false) { // Assuming USE_WEBHOOK defaults true
    required.push('APP_URL');
  }
  const missing = required.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  console.log('🔧 Configuration:', {
    NODE_ENV: env.NODE_ENV,
    APP_URL: env.APP_URL ? `${env.APP_URL.substring(0, 20)}...` : 'Not set (Dev mode or polling?)',
    USE_WEBHOOK: env.USE_WEBHOOK,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
}

/**
 * Safely edits a Telegram message, handling common errors gracefully.
 * @param {number|string} chatId - The chat ID.
 * @param {number} messageId - The message ID to edit.
 * @param {string} text - The new message text.
 * @param {object} [options={}] - Additional options for editMessageText (e.g., parse_mode, reply_markup).
 * @returns {Promise<object|null>} The result from Telegram API or null on failure/no change.
 */
export async function safeEditMessage(chatId, messageId, text, options = {}) {
  const functionName = 'safeEditMessage'; // For logging context
  console.log(`[${functionName}] Called: chatId=${chatId}, messageId=${messageId}, textLength=${text?.length}`);

  if (!bot) {
    console.error(`❌ [${functionName}] CRITICAL: Bot instance is undefined.`);
    return null; // Return null on failure
  }
   // Ensure messageId is valid
  if (!messageId || typeof messageId !== 'number') {
      console.warn(`⚠️ [${functionName}] Invalid messageId (${messageId}), cannot edit.`);
      return null;
  }
  // Prevent editing with empty text
  if (text === null || text === undefined || text === '') {
      console.warn(`⚠️ [${functionName}] Attempted to edit with empty text for messageId ${messageId}. Skipping.`);
      // Consider deleting the message if text becomes empty?
      // await bot.deleteMessage(chatId, messageId).catch(delErr => console.error(`Failed to delete message ${messageId} after empty edit attempt:`, delErr));
      return null;
  }


  try {
    // Ensure default options and valid reply_markup structure
    const editOptions = {
        parse_mode: 'HTML', // Default parse mode
        disable_web_page_preview: true, // Often desirable default
        ...options // User options override defaults
    };
    // Ensure reply_markup is an object, even if empty
    if (!editOptions.reply_markup || typeof editOptions.reply_markup !== 'object') {
      editOptions.reply_markup = { inline_keyboard: [] };
    }
     // Ensure inline_keyboard is an array within reply_markup
     if (!Array.isArray(editOptions.reply_markup.inline_keyboard)) {
         editOptions.reply_markup.inline_keyboard = [];
     }


    console.log(`🔄 [${functionName}] Attempting to edit message ${messageId}...`);
    const result = await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...editOptions
    });

    console.log(`✅ [${functionName}] Message ${messageId} edited successfully.`);
    return result; // Return the success result

  } catch (error) {
     // Log more detailed error information using optional chaining
    const errorBody = error.response?.body;
    const errorCode = errorBody?.error_code;
    const errorDesc = errorBody?.description;

    console.error(`❌ [${functionName}] Message edit error for messageId ${messageId}:`, {
      code: errorCode ?? 'N/A',
      description: errorDesc ?? 'N/A',
      rawMessage: error.message
    });

    // Handle specific, non-critical errors gracefully
    if (errorDesc?.includes('message is not modified')) {
      console.log(`ℹ️ [${functionName}] Message ${messageId} not modified (no change).`);
      return null; // Return null, not an error
    }
    if (errorCode === 400 && errorDesc?.includes('message to edit not found')) {
      console.log(`ℹ️ [${functionName}] Message ${messageId} to edit not found (might have been deleted).`);
      return null; // Return null
    }
     // Handle "Too Many Requests" specifically
    if (errorCode === 429) {
        console.warn(`⚠️ [${functionName}] Rate limited by Telegram while editing message ${messageId}. Will need retry logic elsewhere if critical.`);
        // Don't throw, allow potential future edits
        return null;
    }
    // Handle bad request due to markup/entities (often indicates escaping issues)
    if (errorCode === 400 && errorDesc?.includes('can\'t parse entities')) {
        console.error(`❌ [${functionName}] PARSE ERROR editing message ${messageId}. Check HTML/Markdown escaping. Text sample: "${String(text).substring(0, 100)}..."`);
        sentryService.captureError(new Error(`Telegram Parse Error: ${errorDesc}`), { component: functionName, chatId, messageId, textSample: String(text).substring(0, 100), level: 'error' });
        // Attempt to send as plain text as a fallback? Might be too noisy.
        // try {
        //     console.log(`🔄 [${functionName}] Retrying edit for ${messageId} without parse_mode...`);
        //     delete editOptions.parse_mode;
        //     return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...editOptions });
        // } catch (retryError) {
        //     console.error(`❌ [${functionName}] Plain text retry failed for ${messageId}:`, retryError.message);
        // }
        return null; // Indicate failure after parse error
    }


    // Log other unexpected errors to Sentry
    sentryService.captureError(error, { component: functionName, chatId, messageId, level: 'warning' });
    return null; // Return null on potentially recoverable or logged errors
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
    // *** FIX: Use healthReport.ok ***
    const isHealthy = healthReport?.ok === true;
    res.status(isHealthy ? 200 : 503).json({ status: isHealthy ? 'OK' : 'DEGRADED', ...healthReport, checks: healthCheckCount, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'ERROR', error: error.message, checks: healthCheckCount, timestamp: new Date().toISOString() });
  }
});

app.get('/liveness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /liveness check #${healthCheckCount}`);
  // Liveness just means the process is running
  res.status(200).json({ status: 'LIVE', initializing: !isServiceReady, timestamp: new Date().toISOString(), uptime: process.uptime(), checks: healthCheckCount });
});

app.get('/readiness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /readiness check #${healthCheckCount}`);
  if (!isServiceReady) {
    // If initialization isn't complete, it's not ready
    return res.status(503).json({ status: 'NOT_READY', initializing: true, checks: healthCheckCount, uptime: process.uptime() });
  }
  try {
    // Once initialized, readiness depends on the health check
    const healthReport = await healthService.getHealth();
    // *** FIX: Use healthReport.ok ***
    const isReady = healthReport?.ok === true;
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'READY' : 'NOT_READY', ...healthReport, checks: healthCheckCount, timestamp: new Date().toISOString() });
  } catch (error) {
    // If health check fails during readiness probe, report not ready
    res.status(503).json({ status: 'NOT_READY', error: error.message, checks: healthCheckCount, timestamp: new Date().toISOString() });
  }
});

// HEAD requests for lightweight checks
app.head('/health', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));
// Readiness HEAD might return 503 if not ready
app.head('/readiness', async (_req, res) => {
    if (!isServiceReady) return res.sendStatus(503);
    try {
        const healthReport = await healthService.getHealth();
        res.sendStatus(healthReport?.ok === true ? 200 : 503);
    } catch {
        res.sendStatus(503);
    }
});

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
        // Log more specific error details if available
        const errorBody = commandError.response?.body;
        console.warn(`⚠️ Failed to set bot commands during startup: ${commandError.message}`, {
            code: errorBody?.error_code,
            description: errorBody?.description
        });
        // Log the error but allow initialization to continue
        sentryService.captureError(commandError, { component: 'bot_init', operation: 'setMyCommands', level: 'warning' });
        console.log('Continuing initialization... Commands might be set later.');
    }
    // *** END FIX ***

    // Log incoming commands
    bot.on('message', (msg) => {
      // Avoid logging message text directly unless needed for debugging privacy concerns
      if (msg.text && msg.text.startsWith('/')) {
        console.log(`📨 Received command: ${msg.text.split(' ')[0]} from chat ${msg.chat.id} (User: ${msg.from?.id || 'unknown'})`);
      }
    });

    console.log('✅ All command handlers registered successfully');
    return true; // Indicate success
  } catch (error) {
    console.error('❌ FATAL: Command handler registration failed:', error); // Log clearly
    // If handler registration itself fails, it's critical, re-throw
    throw error;
  }
}

async function initializeBot() {
  if (initializationPromise) {
      console.log("ℹ️ Initialization already in progress or completed.");
      return initializationPromise;
  }
  initializationPromise = (async () => {
    try {
      console.log('🚀 Starting ParlayBot initialization...');
      validateEnvironment(); // Validate env vars early
      if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

      const botOptions = {
        polling: false, // Explicitly false for webhook
        request: { // Increase timeout for potentially slow Telegram API calls
          timeout: 60000, // 60 seconds
          headers: { 'Content-Type': 'application/json' }
        }
      };

      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created.');

      // Register handlers and callbacks AFTER bot instance is created
      await registerAllCommands(bot); // Register command text handlers
      registerAllCallbacks(bot); // Register inline button handlers

      app.use(express.json()); // Use JSON middleware for webhook body parsing
      if (sentryService.attachExpressPreRoutes) {
        sentryService.attachExpressPreRoutes(app);
      }

      // --- Webhook Setup ---
      if (env.USE_WEBHOOK) {
          console.log('🌐 Configuring webhook mode...');
          const webhookPath = `/webhook/${TOKEN}`; // Unique path per bot token
          const targetWebhookUrl = `${APP_URL}${webhookPath}`;

          try {
            const currentWebhook = await bot.getWebHookInfo();
            console.log('📋 Current webhook info:', {
              url: currentWebhook.url ? `${currentWebhook.url.substring(0, 50)}...` : 'None',
              has_custom_certificate: currentWebhook.has_custom_certificate,
              pending_update_count: currentWebhook.pending_update_count,
              last_error_date: currentWebhook.last_error_date ? new Date(currentWebhook.last_error_date * 1000).toISOString() : null,
              last_error_message: currentWebhook.last_error_message
            });

            // Set the webhook only if it's not already set correctly
            if (currentWebhook.url !== targetWebhookUrl) {
                console.log(`🔄 Setting webhook to: ${targetWebhookUrl}`);
                const setResult = await bot.setWebHook(targetWebhookUrl, {
                  secret_token: WEBHOOK_SECRET || undefined,
                  drop_pending_updates: true // Drop updates missed during downtime
                });
                if (!setResult) {
                    throw new Error(`Telegram API returned false on setWebHook.`);
                }
                console.log(`✅ Webhook set successfully.`);

                // Verify webhook immediately after setting
                await new Promise(resolve => setTimeout(resolve, 1000)); // Short delay before verification
                const verifiedWebhook = await bot.getWebHookInfo();
                if (verifiedWebhook.url !== targetWebhookUrl) {
                    console.error(`❌ Webhook verification failed! Expected: ${targetWebhookUrl}, Got: ${verifiedWebhook.url}`);
                    throw new Error(`Webhook verification failed. URL mismatch.`);
                }
                console.log('✅ Webhook verified post-set:', {
                  url_set: verifiedWebhook.url ? 'Yes' : 'No',
                  pending_updates: verifiedWebhook.pending_update_count
                });
            } else {
                console.log('✅ Webhook URL already correctly set.');
                 // Optionally clear pending updates if webhook was already set
                // await bot.setWebHook(targetWebhookUrl, { drop_pending_updates: true });
                // console.log('Cleared any pending updates.');
            }

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
            // console.log('📨 Webhook received update'); // Can be noisy, log conditionally if needed
            bot.processUpdate(req.body); // Let the library handle the update
            res.sendStatus(200); // Acknowledge receipt immediately
          });
      } else {
          console.warn("⚠️ Webhook mode disabled (APP_URL not HTTPS or USE_WEBHOOK=false). Bot will not receive updates.");
          // If you intended polling mode, you'd initialize differently:
          // bot = new TelegramBot(TOKEN, { polling: true });
          // registerAllCommands(bot);
          // registerAllCallbacks(bot);
      }
      // --- End Webhook Setup ---


      if (sentryService.attachExpressPostRoutes) {
        sentryService.attachExpressPostRoutes(app);
      }

      // --- Health & Readiness Check ---
      console.log('⏱️ Waiting for essential services to pass health check (max 90s)...');
      const readyCheck = await healthService.waitForReady(90000);

      if (!readyCheck) {
          console.error('❌ Critical services (DB/Redis) failed to become ready within the startup timeout.');
          sentryService.captureMessage('Bot started in degraded state - critical services not ready', 'error');
          // Allow startup but mark as not fully ready
          isServiceReady = false; // Explicitly mark as not ready yet
           console.warn("⚠️ Bot starting in degraded mode. Database or Redis might be unavailable.");
      } else {
          isServiceReady = true; // Mark as ready ONLY if check passes
          console.log('🎯 Service marked as ready for health checks');
      }
      // --- End Health & Readiness Check ---


      // --- Cache Warmup (Run even if degraded, might partially succeed) ---
      console.log('🔥 Starting cache warmup...');
      try {
        await Promise.all([
          oddsService.warmupCache?.().catch(e => console.warn('Odds cache warmup warning:', e.message)),
          gamesService.warmupCache?.().catch(e => console.warn('Games cache warmup warning:', e.message))
        ]);
        console.log('✅ Cache warmup attempted (check logs for success/failures).');
      } catch (error) {
        console.warn('⚠️ Cache warmup process had issues:', error.message);
      }
      // --- End Cache Warmup ---

      // --- Final Bot Check (Attempt even if degraded) ---
      try {
        const me = await bot.getMe();
        console.log(`✅ Bot @${me.username} initialized.`);

        // Test responsiveness again after webhook setup
        console.log('🧪 Testing bot responsiveness post-webhook setup...');
        const testCommandsAfter = await bot.getMyCommands();
        console.log(`✅ Bot commands loaded post-webhook: ${testCommandsAfter.length} commands.`);

      } catch (botError) {
        console.error('❌ Bot final setup check failed (getMe/getMyCommands):', botError.message);
        console.warn('Continuing startup, but bot interaction might fail...');
        sentryService.captureError(botError, { component: 'bot_init', operation: 'finalCheck', level: 'warning' });
      }
      // --- End Final Bot Check ---

      keepAliveInterval = setInterval(() => {
        if (isServiceReady) { // Only log if fully ready
          console.log('🤖 Bot active and ready - uptime:', Math.round(process.uptime()), 'seconds');
        } else {
            console.warn('🤖 Bot active but potentially degraded - uptime:', Math.round(process.uptime()), 'seconds');
        }
      }, 600000); // Log every 10 minutes

      console.log(`🎉 Application startup sequence complete! Bot status: ${isServiceReady ? 'READY' : 'DEGRADED'}.`);
      return true; // Indicate successful initialization sequence

    } catch (error) {
      isServiceReady = false;
      initializationPromise = null; // Allow retry on next call if applicable
      console.error('💥 FATAL Initialization Error:', error.message);
      console.error('Stack trace:', error.stack);
      sentryService.captureError(error, { component: 'bot_init', operation: 'overall', level: 'fatal' });

      // Exit process after a short delay to allow logs to flush
      console.error('Exiting due to fatal initialization error in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);

      // We don't need to throw again as we are exiting
      return false; // Indicate failed initialization
    }
  })();
  return initializationPromise;
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false; // Mark as not ready immediately
  if (keepAliveInterval) { clearInterval(keepAliveInterval); }

  // 1. Stop accepting new requests (server.close initiates this)
  server.close(async (err) => { // Add callback to handle server close completion/error
    if (err) {
      console.error("❌ Error closing HTTP server:", err);
      // Decide if you want to proceed or exit here
    } else {
      console.log('✅ HTTP server closed. No longer accepting new connections.');
    }

    // 2. Disconnect services (Redis, potentially DB if needed)
    try {
      if (bot) {
        console.log('ℹ️ Telegram webhook remains active during shutdown for potential quick restarts.');
        // Optional: Delete webhook if you prefer a clean stop
        // try { await bot.deleteWebHook({ drop_pending_updates: true }); console.log('Webhook deleted.'); } catch (e) { console.warn('Could not delete webhook:', e.message)}
      }
      // Import redisService dynamically ONLY during shutdown
      const redisService = (await import('./services/redisService.js')).default;
      if (redisService && redisService.isConnected()) {
          await redisService.disconnect();
          console.log('✅ Redis connection closed.');
      }
      // Add database disconnection here if your DB client requires it
      // const databaseService = (await import('./services/databaseService.js')).default;
      // await databaseService.disconnect(); // Assuming a disconnect method exists

      console.log("✅ All services disconnected gracefully.");
      process.exit(0); // Clean exit after server and services are closed

    } catch (shutdownError) {
      console.error('⚠️ Error during service disconnection:', shutdownError.message);
      process.exit(1); // Exit with error if service disconnection fails
    }
  });


  // Force shutdown after a timeout if graceful shutdown takes too long
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
  // process.exit(1); // Ensure exit if initializeBot failed to do so (handled by timeout now)
});
