// src/bot.js — FINAL VERSION
// This version forces handlers to fire by explicitly setting allowed_updates
// and adds logging to prove message receipt and handler registration.

import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';

// 1. --- Core Setup (Validated from your env.js) ---
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL;
const SECRET = (env.TELEGRAM_WEBHOOK_SECRET || '').trim(); // Trim to prevent whitespace errors
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http'));

if (!TOKEN) {
  console.error('FATAL: Missing TELEGRAM_BOT_TOKEN in environment. Aborting.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK });

// 2. --- Hardened Handler Wiring (with verbose logging) ---
// This function now logs each step to prove which handlers are being registered.
async function wireHandlers() {
  console.log('Wiring handlers...');
  const tryImport = async (path) => {
    try {
      const mod = await import(path);
      console.log(`  ✅ Successfully imported ${path}`);
      return mod;
    } catch (e) {
      console.error(`  ❌ FAILED to import ${path}: ${e.message}`);
      return null;
    }
  };

  const mods = {
    system: await tryImport('./handlers/system.js'),
    settings: await tryImport('./handlers/settings.js'),
    custom: await tryImport('./handlers/custom.js'),
    tools: await tryImport('./handlers/tools.js'),
    ai: await tryImport('./handlers/ai.js'),
    quant: await tryImport('./handlers/quant.js'),
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

    if (registered) {
      console.log(`  👍 Registered listeners for '${name}' handler.`);
    } else {
      console.warn(`  ⚠️ No known registration function found in '${name}'.`);
    }
  }
  console.log('Handler wiring complete.');
}

// 3. --- HTTP Server & Webhook Route (with diagnostic logging) ---
const app = express();
app.use(express.json());
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;

async function initialize() {
  await wireHandlers(); // Ensure handlers are wired before starting

  // THIS IS THE ULTIMATE TEST: A baseline listener. If this doesn't fire, the problem is deep.
  bot.on('message', (msg) => {
    if (msg.text) {
        console.log(`[Baseline Listener] Received text: "${msg.text}" from chat ${msg.chat.id}`);
        // To avoid interfering with other commands, you can have it only reply to a specific keyword.
        if (msg.text.toLowerCase() === '/ping') {
            bot.sendMessage(msg.chat.id, 'pong');
        }
    }
  });


  if (USE_WEBHOOK) {
    // This log will prove Telegram is hitting your server.
    app.post(webhookPath, (req, res) => {
      const update = req.body || {};
      const kind = update.message ? 'message' : (update.callback_query ? 'callback_query' : 'unknown');
      console.log(`[Webhook] Received '${kind}' update from Telegram.`);

      if (SECRET) {
        const header = req.headers['x-telegram-bot-api-secret-token'];
        if (!header || header !== SECRET) {
          console.warn('[Webhook] Unauthorized: Secret token mismatch.');
          return res.status(401).send('Unauthorized');
        }
      }
      bot.processUpdate(update);
      res.sendStatus(200); // Respond immediately
    });

    const fullWebhookUrl = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
    try {
      // THIS IS THE KEY FIX: Explicitly tell Telegram to send both message and callback_query updates.
      await bot.setWebHook(fullWebhookUrl, {
        secret_token: SECRET || undefined,
        allowed_updates: ["message", "callback_query"]
      });
      console.log(`Webhook set to ${fullWebhookUrl} with allowed_updates.`);
    } catch (err) {
      console.error('FATAL: setWebHook failed:', err.message);
    }

  } else {
    try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
    bot.startPolling();
    console.log('Polling started.');
  }

  const me = await bot.getMe();
  console.log(`Bot @${me.username} is fully initialized and ready.`);
}

const PORT = env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on :${PORT}. Initializing bot...`);
  initialize();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
