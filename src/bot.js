// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
import healthService from './services/healthService.js'; // Import your health service

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
const PORT = Number(process.env.PORT) || Number(env.PORT) || 8080;
const HOST = env.HOST || '0.0.0.0';

const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

// Health check state management
let isServiceReady = false;
let healthCheckCount = 0;
const startupTime = Date.now();

// Enhanced Health endpoints with your health service integration
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

app.get('/health', async (_req, res) => {
  healthCheckCount++;
  console.log(`✅ /health check #${healthCheckCount}`);
  
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
  
  // Liveness check - basic service availability
  const basicHealth = {
    status: isServiceReady ? 'LIVE' : 'STARTING',
    ready: isServiceReady,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: healthCheckCount
  };
  
  res.status(isServiceReady ? 200 : 503).json(basicHealth);
});

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

// Support HEAD requests for health checks
app.head('/health', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));
app.head('/readiness', (_req, res) => res.sendStatus(200));

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

  app.use(express.json());
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
    });
    console.log(`✅ Webhook set: ${APP_URL}${webhookPath}`);
  }

  sentryService.attachExpressPostRoutes?.(app);

  // Start server
  server = app.listen(PORT, HOST, () => {
    console.log(`✅ Server listening on ${HOST}:${PORT}`);
    isServiceReady = true;
    console.log('🎯 Service marked as ready for health checks');
  });

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
  console.log(`✅ Bot @${me.username} fully initialized.`);
  
  // Start keep-alive
  keepAliveInterval = setInterval(() => {
    if (isServiceReady) {
      console.log('🤖 Bot active - uptime:', Math.round(process.uptime()), 'seconds');
    }
  }, 600000); // Every 10 minutes
  
  console.log('🎉 Application startup complete!');
}

const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  isServiceReady = false;
  
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
  } catch (error) {
    console.warn('⚠️ Error during bot shutdown:', error);
  }
  
  if (server) {
    server.close(() => {
      console.log('✅ HTTP server closed.');
      process.exit(0);
    });
    
    setTimeout(() => {
      console.log('⚠️ Forcing shutdown after timeout...');
      process.exit(1);
    }, 8000);
  } else {
    process.exit(0);
  }
};

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  console.error('💥 Fatal initialization error:', error);
  sentryService.captureError(error);
  process.exit(1);
});
