// src/bot.js — webhook if APP_URL present, else polling; no BOT_MODE access; Express binds 0.0.0.0:PORT

import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';

// Resolve required/env-configured values from strict envalid schema
const TOKEN = env.TELEGRAM_BOT_TOKEN;                          // required in your schema
const APP_URL = env.APP_URL;                                   // declared with default in your schema
const SECRET = env.TELEGRAM_WEBHOOK_SECRET || '';              // declared with default '' in your schema
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http')); // derive mode from APP_URL only

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// Single bot instance; start polling manually only if needed to avoid race with webhook removal
const bot = new TelegramBot(TOKEN, { polling: false, filepath: false });

// Wire handlers: prefer ./bot/main.js if present; otherwise best-effort register common handlers
async function wireHandlers() {
  try {
    const main = await import('./bot/main.js').catch(() => null);
    if (main?.default) {
      await main.default(bot);
      return;
    }
  } catch {}
  const tryImport = async (p) => {
    try { return await import(p); } catch { return null; }
  };
  const mods = await Promise.all([
    tryImport('./bot/handlers/system.js'),
    tryImport('./bot/handlers/settings.js'),
    tryImport('./bot/handlers/custom.js'),
    tryImport('./bot/handlers/tools.js'),
    tryImport('./bot/handlers/ai.js'),
    tryImport('./bot/handlers/quant.js'),
  ]);
  for (const m of mods.filter(Boolean)) {
    try {
      if (typeof m.registerSystem === 'function') m.registerSystem(bot);
      if (typeof m.registerSettings === 'function') m.registerSettings(bot);
      if (typeof m.registerCustom === 'function') m.registerCustom(bot);
      if (typeof m.registerTools === 'function') m.registerTools(bot);
      if (typeof m.registerAI === 'function') m.registerAI(bot);
      if (typeof m.registerQuant === 'function') m.registerQuant(bot);
      if (typeof m.registerCallbacks === 'function') m.registerCallbacks(bot);
      if (typeof m.registerCustomCallbacks === 'function') m.registerCustomCallbacks(bot);
      if (typeof m.registerSlipCallbacks === 'function') m.registerSlipCallbacks(bot);
      if (typeof m.registerAICallbacks === 'function') m.registerAICallbacks(bot);
    } catch (e) {
      console.error('Handler wire error:', e?.message || e);
    }
  }
}

// Always run an HTTP server so Railway marks the service healthy
const app = express();
app.use(express.json());

// Health endpoints
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, mode: USE_WEBHOOK ? 'webhook' : 'polling' }));

// Webhook path and registration if APP_URL present
const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;

async function startWebhook() {
  // Route to receive Telegram updates; verify secret header only if configured
  app.post(webhookPath, (req, res) => {
    if (SECRET) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!header || header !== SECRET) return res.status(401).send('unauthorized');
    }
    try {
      bot.processUpdate(req.body);
      res.status(200).send('OK');
    } catch (e) {
      console.error('processUpdate failed:', e?.message || e);
      res.status(500).send('error');
    }
  });

  // Register webhook with Telegram
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  try {
    await bot.setWebHook(fullWebhook, SECRET ? { secret_token: SECRET } : undefined);
    console.log('Webhook set:', fullWebhook);
  } catch (err) {
    console.error('Failed to set webhook:', err?.message || err);
  }
}

async function startPolling() {
  // Ensure no webhook conflicts and drop backlog before polling
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.startPolling({
    interval: env.TELEGRAM_POLLING_INTERVAL || 300,
    params: { allowed_updates: ['message', 'callback_query'] },
  });
  console.log('Polling started.');
}

async function boot() {
  // Wire handlers first
  await wireHandlers();

  // Start in the derived mode
  if (USE_WEBHOOK) {
    await startWebhook();
  } else {
    await startPolling();
  }

  // Optional: lightweight heartbeat
  bot.on('message', (msg) => {
    if (msg?.text === '/ping') bot.sendMessage(msg.chat.id, 'pong');
  });

  // Diagnostics
  try {
    const me = await bot.getMe();
    console.log(`Bot @${me.username} is up in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode`);
  } catch {}
}

// Bind to Railway PORT on all interfaces
const PORT = Number(process.env.PORT || env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on :${PORT} (${USE_WEBHOOK ? 'webhook' : 'polling'})`);
  boot().catch((e) => {
    console.error('Fatal boot error:', e?.message || e);
    process.exit(1);
  });
});

// Global safety nets
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
