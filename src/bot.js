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

// Early resource optimization
process.env.UV_THREADPOOL_SIZE = '4'; // Reduce thread pool size
if (global.gc) {
  console.log('🔧 Garbage collector available, enabling periodic cleanup');
}

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
const PORT = Number(process.env.PORT) || Number(env.PORT) || 8080; // Use 8080 as default for Railway
const HOST = env.HOST || '0.0.0.0';

// Configure bot with optimized settings
const botOptions = {
  polling: !USE_WEBHOOK,
  onlyFirstMatch: true, // Reduce processing
  request: {
    timeout: 10000,
    agentOptions: {
      keepAlive: true,
      maxSockets: 10 // Limit connections
    }
  }
};

const bot = new TelegramBot(TOKEN, botOptions);

// Enhanced Health endpoints with startup delay
let isServiceReady = false;
let startupTime = Date.now();

app.get('/', (_req, res) => res.status(200).json({ 
  status: isServiceReady ? 'OK' : 'STARTING',
  service: 'ParlayBot',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
  ready: isServiceReady
}));

app.get('/health', (_req, res) => {
  if (!isServiceReady) return res.status(503).json({ status: 'Service Starting' });
  res.sendStatus(200);
});

app.get('/liveness', (_req, res) => {
  // Allow liveness to pass immediately for Railway
  res.status(200).json({ 
    status: 'LIVE', 
    ready: isServiceReady,
    timestamp: new Date().toISOString()
  });
});

app.head('/liveness', (_req, res) => res.sendStatus(200));

let server;
let keepAliveInterval;

async function main() {
  console.log('🚀 Starting ParlayBot initialization...');
  
  // Register all core handlers
  console.log('📝 Registering bot handlers...');
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');

  app.use(express.json({ limit: '1mb' })); // Limit payload size
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  
  sentryService.attachExpressPreRoutes?.(app);

  if (USE_WEBHOOK) {
    console.log('🌐 Configuring webhook mode...');
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
      max_connections: 20 // Limit webhook connections
    });
    console.log(`✅ Webhook set: ${APP_URL}${webhookPath}`);
  }

  sentryService.attachExpressPostRoutes?.(app);

  // Start server with error handling
  return new Promise((resolve, reject) => {
    server = app.listen(PORT, HOST, () => {
      console.log(`✅ Server listening on ${HOST}:${PORT} (${USE_WEBHOOK ? 'webhook' : 'polling'} mode)`);
      
      // Mark service as ready after successful startup
      isServiceReady = true;
      startupTime = Date.now();
      
      resolve(server);
    });
    
    server.on('error', (error) => {
      console.error('❌ Server startup error:', error);
      reject(error);
    });
    
    // Set timeout for server startup
    server.setTimeout(30000); // 30 second timeout
  });
}

async function initializeBot() {
  try {
    // Set bot commands
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
    console.log(`✅ Bot @${me.username} commands configured.`);
    
    return me;
  } catch (error) {
    console.error('❌ Bot initialization error:', error);
    throw error;
  }
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  
  // Clear keep-alive interval
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  
  isServiceReady = false;
  
  try {
    // Stop bot operations
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
  } catch (error) {
    console.warn('⚠️ Error during bot shutdown:', error);
  }
  
  // Close server
  if (server) {
    server.close(() => {
      console.log('✅ HTTP server closed.');
      process.exit(0);
    });
    
    // Force shutdown after 8 seconds
    setTimeout(() => {
      console.log('⚠️ Forcing shutdown after timeout...');
      process.exit(1);
    }, 8000);
  } else {
    process.exit(0);
  }
};

// Startup sequence
async function startApplication() {
  try {
    await main();
    await initializeBot();
    
    // Start keep-alive with less frequent logging
    keepAliveInterval = setInterval(() => {
      if (isServiceReady) {
        console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
      }
    }, 600000); // Log every 10 minutes instead of 5
    
    console.log('🎉 Application startup complete. Bot is ready!');
    console.log('⏰ Startup time:', Date.now() - startupTime, 'ms');
    
  } catch (error) {
    console.error('💥 Fatal initialization error:', error);
    sentryService.captureError(error);
    process.exit(1);
  }
}

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the application
startApplication();
