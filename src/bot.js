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

// --- Global Error Catcher ---
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

// Required/optional env
const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// APP_URL should be https in production to enable webhook mode
const APP_URL = env.APP_URL || '';

// Normalize the webhook secret from env normalization (see env.js) or aliases
const WEBHOOK_SECRET = (env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim();

// Decide mode by URL scheme
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('https'));

// Initialize bot
const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });
let server;

// --- Main Application Start ---
async function main() {
  console.log('Registering all bot handlers...');
  registerAnalytics(bot); registerModel(bot); registerCacheHandler(bot);
  registerCustom(bot); registerCustomCallbacks(bot);
  registerAI(bot); registerAICallbacks(bot); registerQuant(bot);
  registerPlayer(bot); registerPlayerCallbacks(bot);
  registerSettings(bot); registerSettingsCallbacks(bot);
  registerSystem(bot); registerSystemCallbacks(bot);
  registerTools(bot); registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');

  console.log('Setting up Express server and middleware...');
  app.use(express.json());
  sentryService.attachExpressPreRoutes?.(app);

  // Liveness/health endpoints for Railway
  app.get('/liveness', (_req, res) => {
    console.log('✅ Health check endpoint /liveness was hit successfully.');
    res.sendStatus(200);
  });
  ['/', '/health', '/healthz'].forEach((path) =>
    app.get(path, (_req, res) => res.status(200).send('OK'))
  );
  // Some platforms probe with HEAD, respond 200 as well
  app.head('/health', (_req, res) => res.sendStatus(200));

  if (USE_WEBHOOK) {
    const webhookPath = `/webhook/${TOKEN}`;

    // Verify Telegram secret header only when configured
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

    console.log('Setting webhook...');
    await bot.setWebHook(`${APP_URL}${webhookPath}`, {
      // Telegram will include X-Telegram-Bot-Api-Secret-Token only if this is set
      secret_token: WEBHOOK_SECRET || undefined,
      // drop_pending_updates: false,
    });
    console.log(`Webhook successfully set to: ${APP_URL}${webhookPath}`);
  }

  sentryService.attachExpressPostRoutes?.(app);

  console.log('Setting bot commands in Telegram...');
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
  console.log('✅ Bot commands have been set in Telegram.');

  const me = await bot.getMe();
  console.log(`✅ Bot @${me.username} fully initialized.`);

  // Prefer Railway's injected PORT, bind on 0.0.0.0
  const PORT = Number(process.env.PORT) || Number(env.PORT) || 8080;
  const HOST = '0.0.0.0';
  server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Server listening on ${HOST}:${PORT}. Bot is online in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
  });
}

// --- Graceful Shutdown Logic ---
const shutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    if (!USE_WEBHOOK) {
      try { await bot.stopPolling({ cancel: true, reason: signal }); } catch {}
    } else {
      try { await bot.deleteWebHook(); } catch {}
    }
  } finally {
    if (server) {
      server.close(() => {
        console.log('✅ HTTP server closed.');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }
};

// --- Execute Main Function and Keep Process Alive ---
main().then(() => {
  console.log('Application startup sequence complete. Process will now run indefinitely.');
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch((e) => {
  console.error('❌ Fatal Bot Initialization Error:', e);
  sentryService.captureError(e);
  process.exit(1);
});
