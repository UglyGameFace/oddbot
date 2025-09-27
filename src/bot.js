// src/bot.js — no BOT_MODE, no strict-env crashes
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { wireUp } from './bot/main.js';

const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in env');
  process.exit(1);
}

const APP_URL = env.APP_URL;                       // declared in schema
const SECRET = env.TELEGRAM_WEBHOOK_SECRET || '';  // declared with default ''
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http'));

const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

// Register handlers
await wireUp(bot);

// Always run an HTTP server for Railway health
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, mode: USE_WEBHOOK ? 'webhook' : 'polling' }));

const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;

if (USE_WEBHOOK) {
  // Webhook route
  app.post(webhookPath, (req, res) => {
    if (SECRET) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!header || header !== SECRET) return res.status(401).send('unauthorized');
    }
    bot.processUpdate(req.body);
    res.status(200).send('OK');
  });

  // Register webhook
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  try {
    await bot.setWebHook(fullWebhook, SECRET ? { secret_token: SECRET } : undefined);
    console.log('Webhook set:', fullWebhook);
  } catch (err) {
    console.error('Failed to set webhook:', err?.message || err);
  }
} else {
  // Polling mode: ensure any old webhook is removed
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  console.log('Polling mode enabled');
}

// Bind to Railway port on all interfaces
const PORT = Number(process.env.PORT || env.PORT || 3000);
app.listen(PORT, '0.0.0.0', async () => {
  try {
    const me = await bot.getMe();
    console.log(`@${me.username} ready on :${PORT} (${USE_WEBHOOK ? 'webhook' : 'polling'})`);
  } catch {
    console.log(`Bot ready on :${PORT} (${USE_WEBHOOK ? 'webhook' : 'polling'})`);
  }
});

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
