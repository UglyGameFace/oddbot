// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { sentryService } from './services/sentryService.js';
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

// --- CATCH SILENT ERRORS ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});

const app = express();

// --- Health Checks & Basic Middleware ---
app.get('/liveness', (_req, res) => res.sendStatus(200));
const healthOk = (_req, res) => res.status(200).send('OK');
['/', '/health', '/healthz'].forEach((path) => app.get(path, healthOk));

sentryService.attachExpressPreRoutes?.(app);
app.use(express.json());

// --- Bot Initialization ---
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const USE_WEBHOOK = env.APP_URL && env.APP_URL.startsWith('https');
const bot = new TelegramBot(TOKEN, {
    polling: !USE_WEBHOOK,
    request: { timeout: 20000 }
});

// --- Handler Registration ---
async function wireHandlers() {
  console.log('Wiring all application handlers...');
  registerAnalytics(bot);
  registerModel(bot);
  registerCacheHandler(bot);
  registerCustom(bot);
  registerCustomCallbacks(bot);
  registerAI(bot);
  registerAICallbacks(bot);
  registerQuant(bot);
  registerPlayer(bot);
  registerPlayerCallbacks(bot);
  registerSettings(bot);
  registerSettingsCallbacks(bot);
  registerSystem(bot);
  registerSystemCallbacks(bot);
  registerTools(bot);
  registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');
}

// --- Webhook Setup ---
async function startWebhook() {
  const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
  app.post(webhookPath, (req, res) => {
    if (env.TELEGRAM_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }
    bot.processUpdate(req.body || {});
    res.sendStatus(200);
  });
  const fullWebhookUrl = `${env.APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  await bot.setWebHook(fullWebhookUrl, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: ['message', 'callback_query']
  });
  console.log(`Webhook successfully set to: ${fullWebhookUrl}`);
}

sentryService.attachExpressPostRoutes?.(app);

// --- Application Start (UPDATED WITH TRACER LOGS) ---
async function initialize() {
  console.log('[Tracer] Step 1: Starting wireHandlers()...');
  await wireHandlers();
  console.log('[Tracer] Step 1: COMPLETED.');

  if (USE_WEBHOOK) {
    console.log('[Tracer] Step 2: Starting startWebhook()...');
    await startWebhook();
    console.log('[Tracer] Step 2: COMPLETED.');
  }

  console.log('[Tracer] Step 3: Starting setMyCommands()...');
  const commands = [
    { command: 'ai', description: 'Launch the AI Parlay Builder' },
    { command: 'custom', description: 'Manually build a parlay slip' },
    { command: 'player', description: 'Find props for a specific player' },
    { command: 'settings', description: 'Configure your bot preferences' },
    { command: 'status', description: 'Check the bot\'s operational status' },
    { command: 'tools', description: 'Access admin tools' },
    { command: 'help', description: 'Show the command guide' },
  ];

  try {
    await bot.setMyCommands(commands);
    console.log('[Tracer] Step 3: COMPLETED.');
  } catch (error) {
    console.error('[Tracer] Step 3: FAILED.', error);
    throw error; // Re-throw to ensure it's caught by the main handler
  }
  
  console.log('[Tracer] Step 4: Starting getMe()...');
  const me = await bot.getMe();
  console.log('[Tracer] Step 4: COMPLETED.');

  console.log(`🚀 Bot @${me.username} is now online in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on [${HOST}]:${PORT}. Initializing bot...`);
  initialize().catch((e) => {
    console.error('❌ Fatal Bot Initialization Error:', e?.message || e);
    process.exit(1);
  });
});

// --- Graceful Shutdown ---
const shutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
