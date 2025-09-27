// src/bot.js — FINAL
// Webhook if APP_URL present; otherwise polling. No BOT_MODE used.
// Correct handler import paths: ./bot/handlers/*.js (from src/bot.js).
// ESM requires file extensions and exact case on Linux.

import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';

// Required, declared in env.js schema
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL;
// Optional secret; trimmed to avoid whitespace mismatch
const SECRET = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
// Derive mode solely from APP_URL presence
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http'));

if (!TOKEN) {
  console.error('FATAL: Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// Create bot instance; for webhook, we will not start polling
const bot = new TelegramBot(TOKEN, { polling: false, filepath: false });

// --- Handler wiring with verbose logging ---
async function wireHandlers() {
  console.log('Wiring handlers...');
  const tryImport = async (path) => {
    try {
      const mod = await import(path);
      console.log(`  ✅ Imported ${path}`);
      return mod;
    } catch (e) {
      console.error(`  ❌ FAILED to import ${path}: ${e.message}`);
      return null;
    }
  };

  // Correct paths relative to src/bot.js
  const mods = {
    system:   await tryImport('./bot/handlers/system.js'),
    settings: await tryImport('./bot/handlers/settings.js'),
    custom:   await tryImport('./bot/handlers/custom.js'),
    tools:    await tryImport('./bot/handlers/tools.js'),
    ai:       await tryImport('./bot/handlers/ai.js'),
    quant:    await tryImport('./bot/handlers/quant.js'),
  };

  for (const [name, mod] of Object.entries(mods)) {
    if (!mod) continue;
    let registered = false;
    if (typeof mod.register === 'function') { mod.register(bot); registered = true; }
    if (typeof mod.registerSystem === 'function') { mod.registerSystem(bot); registered = true; }
    if (typeof mod.registerSettings === 'function') { mod.registerSettings(bot); registered = true; }
    if (typeof mod.registerCustom === 'function') { mod.registerCustom(bot); registered = true; }
    if (typeof mod.registerTools === 'function') { mod.registerTools(bot); registered = true; }
    if (typeof mod.registerAI === 'function') { mod.registerAI(bot); registered = true; }
    if (typeof mod.registerQuant === 'function') { mod.registerQuant(bot); registered = true; }
    if (typeof mod.registerCallbacks === 'function') { mod.registerCallbacks(bot); registered = true; }
    if (typeof mod.registerCustomCallbacks === 'function') { mod.registerCustomCallbacks(bot); registered = true; }
    if (typeof mod.registerSlipCallbacks === 'function') { mod.registerSlipCallbacks(bot); registered = true; }
    if (typeof mod.registerAICallbacks === 'function') { mod.registerAICallbacks(bot); registered = true; }
    if (registered) console.log(`  👍 Registered '${name}' listeners.`);
    else console.warn(`  ⚠️ No registration function found in '${name}'.`);
  }
  console.log('Handler wiring complete.');

  // Baseline listener: proves message updates reach the bot
  bot.on('message', (msg) => {
    if (msg?.text && msg.text.trim().toLowerCase() === '/ping') {
      bot.sendMessage(msg.chat.id, 'pong');
    }
  });
}

// --- HTTP server & webhook route ---
const app = express();
app.use(express.json());

// Health endpoint for platform checks
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

// Webhook route path; token not required in URL because we use our own Express + processUpdate
const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;

async function startWebhook() {
  // Accept Telegram updates and return 200 immediately
  app.post(webhookPath, (req, res) => {
    // Optional secret verification
    if (SECRET) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!header || header !== SECRET) {
        console.warn('[Webhook] Unauthorized: secret mismatch.');
        return res.status(401).send('unauthorized');
      }
    }
    try {
      const u = req.body || {};
      const kind = u.message ? 'message' : (u.callback_query ? 'callback_query' : 'other');
      console.log(`[Webhook] Received update: ${kind}`);
      bot.processUpdate(u);
      res.sendStatus(200);
    } catch (e) {
      console.error('processUpdate failed:', e?.message || e);
      res.sendStatus(500);
    }
  });

  // Register webhook with explicit allowed_updates to receive both text and button callbacks
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  await bot.setWebHook(fullWebhook, {
    secret_token: SECRET || undefined,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`Webhook set: ${fullWebhook}`);
}

async function startPolling() {
  // Remove webhook to avoid conflicts and drop backlog
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.startPolling({
    interval: env.TELEGRAM_POLLING_INTERVAL || 300,
    params: { allowed_updates: ['message', 'callback_query'] },
  });
  console.log('Polling started.');
}

async function initialize() {
  await wireHandlers();
  if (USE_WEBHOOK) {
    await startWebhook();
  } else {
    await startPolling();
  }
  try {
    const me = await bot.getMe();
    console.log(`Bot @${me.username} is fully initialized in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
  } catch {}
}

// Bind to Railway/host platform port on all interfaces
const PORT = Number(process.env.PORT || env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on :${PORT}. Initializing bot...`);
  initialize().catch((e) => {
    console.error('Fatal bot init error:', e?.message || e);
    process.exit(1);
  });
});

// Global safety
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
