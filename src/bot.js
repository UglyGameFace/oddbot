// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import healthService from './services/healthService.js';
import redisClient from './services/redisService.js';

// --- Handler imports
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
import { registerChat } from './bot/handlers/chat.js';

// --- Global error hooks
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection: ${reason}`), { extra: { promise } });
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  sentryService.captureError(error);
  process.exit(1);
});

// --- App and bot bootstrap
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// --- Global state and instances
let bot;
let server;
let keepAliveInterval;
let isServiceReady = false;
let healthCheckCount = 0;
const startupTime = Date.now();

// ====================================================================
//  IMMEDIATE SERVER STARTUP & HEALTH ENDPOINTS
//
//  These endpoints are defined and started immediately to respond to
//  platform health checks while the main bot initializes.
// ====================================================================

// Simple health check for liveness probes (e.g., /health for Railway)
app.get('/health', (_req, res) => res.sendStatus(200));
app.head('/health', (_req, res) => res.sendStatus(200));

// Your original, more detailed health endpoints are preserved
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
    return res.status(503).json({
      status: 'Service Starting',
      checks: healthCheckCount,
      uptime: process.uptime()
    });
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
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'ERROR',
      error: error.message,
      checks: healthCheckCount,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/liveness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /liveness check #${healthCheckCount}`);
  res.status(200).json({
    status: 'LIVE',
    ready: isServiceReady,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: healthCheckCount
  });
});
app.head('/liveness', (_req, res) => res.sendStatus(200));

app.get('/readiness', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /readiness check #${healthCheckCount}`);
  if (!isServiceReady) {
    return res.status(503).json({
      status: 'NOT_READY',
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
app.head('/readiness', (_req, res) => res.sendStatus(200));

// Start the server immediately
server = app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}. Health checks are live.`);
});

// ====================================================================
//  ASYNCHRONOUS BOT INITIALIZATION
//
//  This function contains all the original startup logic. It's now
//  called after the server is already running.
// ====================================================================

async function initializeBotAndServices() {
  console.log('🚀 Starting ParlayBot initialization...');

  const TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const APP_URL = env.APP_URL || '';
  const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || '').trim();
  const USE_WEBHOOK = APP_URL.startsWith('https');

  // Initialize bot instance and assign to the outer scope variable
  bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

  // Register handlers
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);
  registerChat(bot);
  console.log('✅ All handlers registered.');

  app.use(express.json());
  sentryService.attachExpressPreRoutes?.(app);

  // Webhook setup
  if (USE_WEBHOOK) {
    console.log('🌐 Configuring webhook mode...');
    const webhookPath = `/webhook/${TOKEN}`;
    const targetWebhookUrl = `${APP_URL}${webhookPath}`;

    const currentWebhook = await bot.getWebHookInfo();
    if (currentWebhook.url !== targetWebhookUrl) {
      await bot.setWebHook(targetWebhookUrl, { secret_token: WEBHOOK_SECRET || undefined });
      console.log(`✅ Webhook set: ${targetWebhookUrl}`);
    } else {
      console.log('✅ Webhook is already correctly configured.');
    }

    app.post(webhookPath, (req, res) => {
        if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
            return res.sendStatus(403);
        }
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
  }

  sentryService.attachExpressPostRoutes?.(app);

  // Telegram commands
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
  const me = await bot.getMe();
  console.log(`✅ Bot @${me.username} fully initialized.`);

  // Liveness heartbeat
  keepAliveInterval = setInterval(() => {
    if (isServiceReady) {
      console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
    }
  }, 600000);

  // Mark service as fully ready for readiness probes
  isServiceReady = true;
  console.log('🎯 Service marked as ready for health checks');
  console.log('🎉 Application startup complete!');
}

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  try {
    if (!USE_WEBHOOK && bot && bot.isPolling()) {
      await bot.stopPolling({ cancel: true, reason: 'Graceful shutdown' });
      console.log('✅ Bot polling stopped.');
    }
    const redis = await redisClient;
    await redis.quit();
    console.log('✅ Redis connection closed.');
  } catch (error) {
    console.warn('⚠️ Error during bot/redis shutdown:', error.message);
  }

  if (server) {
    server.close(() => {
      console.log('✅ HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('⚠️ Forcing shutdown after timeout...');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Kick off the main initialization
initializeBotAndServices().catch((error) => {
  console.error('💥 Fatal initialization error:', error.message);
  sentryService.captureError(error);
  if (!String(error.message).includes('429')) {
    process.exit(1);
  }
});
