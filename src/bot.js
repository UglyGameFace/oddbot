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
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = (env.USE_WEBHOOK === 'true') || (env.APP_URL || '').startsWith('https');

let bot;
let server;
let keepAliveInterval;
let isServiceReady = false;
let healthCheckCount = 0;
let initializationPromise = null;

// Utility Functions
function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN'];
  const missing = required.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  console.log('🔧 Environment Configuration:');
  console.log('   - TELEGRAM_BOT_TOKEN:', env.TELEGRAM_BOT_TOKEN ? '✓ Set' : '✗ Missing');
  console.log('   - APP_URL:', env.APP_URL || 'Not set');
  console.log('   - USE_WEBHOOK:', USE_WEBHOOK);
  console.log('   - REDIS_URL:', env.REDIS_URL ? '✓ Set' : '✗ Missing');
  console.log('   - WEBHOOK_SECRET:', WEBHOOK_SECRET ? '✓ Set' : '✗ Missing');
}

// FIX: Removed the `export` keyword. This function is internal to bot.js and
// exporting it was causing module resolution conflicts during startup.
async function safeEditMessage(chatId, messageId, text, options = {}) {
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

// Health endpoints
app.get('/health', (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /health check #${healthCheckCount}`);
  res.status(200).json({ 
    status: 'OK', 
    service: 'ParlayBot',
    timestamp: new Date().toISOString(),
    ready: isServiceReady,
    checks: healthCheckCount 
  });
});

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
    res.status(healthReport.ok ? 200 : 503).json({ 
      status: healthReport.ok ? 'OK' : 'DEGRADED', 
      ...healthReport, 
      checks: healthCheckCount, 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'ERROR', 
      error: error.message, 
      checks: healthCheckCount, 
      timestamp: new Date().toISOString() 
    });
  }
});

app.get('/liveness', (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /liveness check #${healthCheckCount}`);
  res.status(200).json({ 
    status: 'LIVE', 
    initializing: !isServiceReady, 
    timestamp: new Date().toISOString(), 
    uptime: process.uptime(), 
    checks: healthCheckCount 
  });
});

app.get('/readiness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /readiness check #${healthCheckCount}`);
  if (!isServiceReady) {
    return res.status(503).json({ 
      status: 'NOT_READY', 
      initializing: true, 
      checks: healthCheckCount, 
      uptime: process.uptime() 
    });
  }
  try {
    const healthReport = await healthService.getHealth();
    const isReady = healthReport.ok;
    res.status(isReady ? 200 : 503).json({ 
      status: isReady ? 'READY' : 'NOT_READY', 
      ...healthReport, 
      checks: healthCheckCount, 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'NOT_READY', 
      error: error.message, 
      checks: healthCheckCount, 
      timestamp: new Date().toISOString() 
    });
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
    // Register all command handlers
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
    
    console.log('✅ All command handlers registered successfully');
    
    // Add basic message logging
    bot.on('message', (msg) => {
      if (msg.text && msg.text.startsWith('/')) {
        console.log(`📨 Received command: ${msg.text} from ${msg.chat.id}`);
      }
    });
    
    return true;
  } catch (error) {
    console.error('❌ Command registration failed:', error);
    throw error;
  }
}

async function initializeBot() {
  if (initializationPromise) { 
    return initializationPromise; 
  }
  
  initializationPromise = (async () => {
    try {
      console.log('🚀 Starting ParlayBot initialization...');
      validateEnvironment();
      
      if (!TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is required');
      }
      
      const botOptions = { 
        polling: !USE_WEBHOOK, 
        request: { 
          timeout: 30000,
          agent: null
        } 
      };
      
      bot = new TelegramBot(TOKEN, botOptions);
      console.log('✅ Telegram Bot instance created');

      // Register callbacks FIRST
      registerAllCallbacks(bot);
      
      // Register commands
      await registerAllCommands(bot);
      
      // Configure express middleware
      app.use(express.json({ limit: '10mb' }));
      app.use(express.urlencoded({ extended: true }));
      
      if (sentryService.attachExpressPreRoutes) {
        sentryService.attachExpressPreRoutes(app);
      }

      if (USE_WEBHOOK) {
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
          const webhookOptions = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {};
          await bot.setWebHook(targetWebhookUrl, webhookOptions);
          console.log(`✅ Webhook set successfully`);
          
          // Verify webhook was set
          const updatedWebhook = await bot.getWebHookInfo();
          console.log('✅ Webhook verification:', {
            url_set: !!updatedWebhook.url,
            pending_updates: updatedWebhook.pending_update_count
          });
        } catch (webhookError) {
          console.error('❌ Webhook configuration failed:', webhookError.message);
          throw webhookError;
        }

        // Webhook endpoint
        app.post(webhookPath, (req, res) => {
          if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
            console.warn('⚠️ Webhook secret mismatch - received:', req.headers['x-telegram-bot-api-secret-token']);
            return res.sendStatus(403);
          }
          
          console.log('📨 Webhook received update');
          try {
            bot.processUpdate(req.body);
            res.sendStatus(200);
          } catch (processError) {
            console.error('❌ Error processing webhook update:', processError);
            res.sendStatus(200); // Still return 200 to prevent retries
          }
        });
        
        console.log('✅ Webhook endpoint configured at:', webhookPath);
      } else {
        console.log('🔍 Using polling mode...');
        try {
          await bot.startPolling();
          console.log('✅ Bot polling started successfully');
        } catch (pollError) {
          console.error('❌ Polling start failed:', pollError.message);
          throw pollError;
        }
      }

      if (sentryService.attachExpressPostRoutes) {
        sentryService.attachExpressPostRoutes(app);
      }

      // Set bot commands
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
      
      try {
        await bot.setMyCommands(commands);
        const me = await bot.getMe();
        console.log(`✅ Bot @${me.username} fully initialized with ${commands.length} commands.`);
        
        // Test bot responsiveness
        const testCommands = await bot.getMyCommands();
        console.log(`✅ Bot commands verified: ${testCommands.length} commands loaded`);
      } catch (botError) {
        console.error('❌ Bot command setup failed:', botError.message);
        throw botError;
      }
      
      // Mark service as ready
      isServiceReady = true;
      console.log('🎯 Service marked as READY for health checks');

      // Keep alive interval
      keepAliveInterval = setInterval(() => {
        if (isServiceReady) {
          console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
        }
      }, 600000);
      
      console.log('🎉 Application startup complete! Bot should now respond to commands.');
      return true;
    } catch (error) {
      isServiceReady = false;
      initializationPromise = null;
      console.error('💥 Initialization failed:', error.message);
      console.error('Stack trace:', error.stack);
      throw error;
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
      } else if (bot.isPolling && bot.isPolling()) {
        await bot.stopPolling();
        console.log('✅ Bot polling stopped.');
      }
    }
    
    const redis = await import('./services/redisService.js').then(m => m.default);
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
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Initialize bot
initializeBot().catch((error) => {
  console.error('💥 Fatal initialization error:', error.message);
  if (sentryService.captureError) {
    sentryService.captureError(error);
  }
  
  if (String(error.message).includes('429')) {
    console.log('⏳ Rate limit error, waiting before exit...');
    setTimeout(() => process.exit(1), 10000);
  } else {
    process.exit(1);
  }
});

export default bot;
