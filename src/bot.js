// src/bot.js — final
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { wireUp } from './bot/main.js';

const TOKEN = env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN/BOT_TOKEN in env');
  process.exit(1);
}

// Optional values via env defaults or process.env (don’t let envalid throw)
const APP_URL = env.APP_URL || env.WEBHOOK_URL || process.env.APP_URL || process.env.WEBHOOK_URL || '';
const MODE = (env.BOT_MODE || process.env.BOT_MODE || '').toLowerCase();
const SECRET = env.TELEGRAM_SECRET_TOKEN || process.env.TELEGRAM_SECRET_TOKEN || process.env.WEBHOOK_SECRET || '';
const WEBHOOK_ENABLED = MODE === 'webhook' || (!!APP_URL && MODE !== 'polling');

const bot = new TelegramBot(TOKEN, { polling: !WEBHOOK_ENABLED });

// Wire handlers before serving traffic
await wireUp(bot);

// Always bind an HTTP server for Railway
const app = express();
app.use(express.json());

// Health endpoints
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, mode: WEBHOOK_ENABLED ? 'webhook' : 'polling' }));

// Webhook route + registration (optional)
const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
if (WEBHOOK_ENABLED) {
  app.post(webhookPath, (req, res) => {
    // Validate Telegram’s secret header only if configured
    if (SECRET) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!header || header !== SECRET) return res.status(401).send('unauthorized');
    }
    bot.processUpdate(req.body);
    res.status(200).send('OK');
  });

  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  try {
    await bot.setWebHook(fullWebhook, SECRET ? { secret_token: SECRET } : undefined);
    console.log('Webhook set:', fullWebhook);
  } catch (err) {
    console.error('Failed to set webhook:', err?.message || err);
  }
} else {
  // Ensure no lingering webhook conflicts when using polling
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  console.log('Polling mode enabled');
}

// Bind to Railway’s PORT on all interfaces
const PORT = Number(process.env.PORT || env.PORT || 3000);
app.listen(PORT, '0.0.0.0', async () => {
  try {
    const me = await bot.getMe();
    console.log(`@${me.username} ready on :${PORT} (${WEBHOOK_ENABLED ? 'webhook' : 'polling'})`);
  } catch {
    console.log(`Bot ready on :${PORT} (${WEBHOOK_ENABLED ? 'webhook' : 'polling'})`);
  }
});

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
