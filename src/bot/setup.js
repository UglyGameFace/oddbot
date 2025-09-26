// src/bot/setup.js
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import env, { isProduction } from '../config/env.js';

export const app = express();
app.use(express.json());

export const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: !isProduction });

const WEBHOOK_PATH = `/api/webhook/${env.TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = isProduction ? `${env.APP_URL}${WEBHOOK_PATH}` : null;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET || '';

export async function initWebhook() {
  if (!isProduction) {
    // Local development = polling
    try {
      await bot.deleteWebHook();
      console.log('🤖 Bot is running in local development mode (polling)...');
    } catch (err) {
      console.error('❌ Local webhook delete error:', err?.message || err);
    }
    return;
  }

  try {
    const opts = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined;
    await bot.setWebHook(WEBHOOK_URL, opts);
    console.log(`✅ Webhook set at ${WEBHOOK_URL}`);
  } catch (err) {
    console.error('❌ Failed to set webhook:', err?.message || err);
  }

  app.post(WEBHOOK_PATH, (req, res) => {
    try {
      if (WEBHOOK_SECRET) {
        const header = req.get('x-telegram-bot-api-secret-token');
        if (!header || header !== WEBHOOK_SECRET) return res.sendStatus(401);
      }
      bot.processUpdate(req.body);
      return res.sendStatus(200);
    } catch (e) {
      console.error('Webhook processUpdate error', e);
      return res.sendStatus(500);
    }
  });
}

let server = null;

export async function startServer(onShutdown = async () => {}) {
  const PORT = env.PORT || 3000;
  server = app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));

  async function shutdown(signal) {
    try {
      console.log(`🔻 Received ${signal}, draining...`);
      if (!isProduction) {
        try { await bot.stopPolling(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
      await onShutdown();
      console.log('✅ Clean shutdown complete.');
      process.exit(0);
    } catch (e) {
      console.error('Shutdown error, forcing exit:', e?.message);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
