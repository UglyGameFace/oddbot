// src/bot.js
// ESM entrypoint that always binds an HTTP server for Railway and supports polling or webhook modes.

import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { wireUp } from './bot/main.js';

const TOKEN = env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN/BOT_TOKEN in env');
  process.exit(1);
}

// Decide mode
const APP_URL = env.APP_URL || env.WEBHOOK_URL || '';
const WEBHOOK_ENABLED = Boolean(APP_URL) || String(env.TELEGRAM_WEBHOOK || '').toLowerCase() === 'true';

// Create bot
const bot = new TelegramBot(TOKEN, { polling: !WEBHOOK_ENABLED });

// Wire handlers
await wireUp(bot);

// Health HTTP server (always on, satisfies Railway PORT)
const app = express();
app.use(express.json());

// Simple health endpoints
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, mode: WEBHOOK_ENABLED ? 'webhook' : 'polling' }));

// Optional version endpoint
app.get('/version', (_req, res) => res.status(200).json({ version: process.env.npm_package_version || 'dev' }));

// Webhook route and registration if enabled
const SECRET = env.TELEGRAM_SECRET_TOKEN || env.WEBHOOK_SECRET || '';
const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
if (WEBHOOK_ENABLED) {
  app.post(webhookPath, (req, res) => {
    // Validate Telegram secret header if configured
    if (SECRET) {
      const header = req.header('X-Telegram-Bot-Api-Secret-Token');
      if (!header || header !== SECRET) return res.status(401).send('unauthorized');
    }
    bot.processUpdate(req.body);
    res.status(200).send('OK');
  });

  // Register webhook with Telegram
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  try {
    await bot.setWebHook(fullWebhook, SECRET ? { secret_token: SECRET } : undefined);
    console.log('Webhook set:', fullWebhook);
  } catch (err) {
    console.error('Failed to set webhook:', err?.message || err);
  }
} else {
  // Ensure webhook removed if switching to polling
  try {
    await bot.deleteWebHook();
  } catch {}
  console.log('Polling mode enabled');
}

// Start HTTP server (Railway requires binding to PORT)
const PORT = Number(process.env.PORT || env.PORT || 3000);
app.listen(PORT, '0.0.0.0', async () => {
  try {
    const me = await bot.getMe();
    console.log(`Bot @${me.username} ready on port ${PORT} in ${WEBHOOK_ENABLED ? 'webhook' : 'polling'} mode`);
  } catch {
    console.log(`Bot ready on port ${PORT} in ${WEBHOOK_ENABLED ? 'webhook' : 'polling'} mode`);
  }
});

// Safety: log unhandled errors
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));
