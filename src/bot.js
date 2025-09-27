// src/bot.js — FINAL WITH MULTI-PATH HEALTHCHECKS + HEAD + legacy “/heath/readiness”
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL;
const SECRET = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http'));

if (!TOKEN) {
  console.error('FATAL: Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false, filepath: false });

// Handler wiring with correct paths and logging
async function wireHandlers() {
  console.log('Wiring handlers...');
  const tryImport = async (path) => {
    try { const m = await import(path); console.log(`  ✅ Imported ${path}`); return m; }
    catch (e) { console.error(`  ❌ FAILED to import ${path}: ${e.message}`); return null; }
  };

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
    let ok = false;
    if (typeof mod.register === 'function') { mod.register(bot); ok = true; }
    if (typeof mod.registerSystem === 'function') { mod.registerSystem(bot); ok = true; }
    if (typeof mod.registerSettings === 'function') { mod.registerSettings(bot); ok = true; }
    if (typeof mod.registerCustom === 'function') { mod.registerCustom(bot); ok = true; }
    if (typeof mod.registerTools === 'function') { mod.registerTools(bot); ok = true; }
    if (typeof mod.registerAI === 'function') { mod.registerAI(bot); ok = true; }
    if (typeof mod.registerQuant === 'function') { mod.registerQuant(bot); ok = true; }
    if (typeof mod.registerCallbacks === 'function') { mod.registerCallbacks(bot); ok = true; }
    if (typeof mod.registerCustomCallbacks === 'function') { mod.registerCustomCallbacks(bot); ok = true; }
    if (typeof mod.registerSlipCallbacks === 'function') { mod.registerSlipCallbacks(bot); ok = true; }
    if (typeof mod.registerAICallbacks === 'function') { mod.registerAICallbacks(bot); ok = true; }
    console.log(ok ? `  👍 Registered '${name}' listeners.` : `  ⚠️ No registration function in '${name}'.`);
  }
  console.log('Handler wiring complete.');

  // Baseline listener to confirm text events arrive
  bot.on('message', (msg) => {
    if (msg?.text?.trim().toLowerCase() === '/ping') bot.sendMessage(msg.chat.id, 'pong');
  });
}

// HTTP server with multi-path health endpoints (GET + HEAD)
const app = express();
app.use(express.json());

const healthOk = (_req, res) => res.status(200).send('OK');

// Common health endpoints
app.get('/', healthOk);                     app.head('/', healthOk);
app.get('/health', healthOk);               app.head('/health', healthOk);
app.get('/healthz', healthOk);              app.head('/healthz', healthOk);
app.get('/health/readiness', healthOk);     app.head('/health/readiness', healthOk);
app.get('/health/liveness', healthOk);      app.head('/health/liveness', healthOk);

// Legacy typo coverage (if previously configured)
app.get('/heath/readiness', healthOk);      app.head('/heath/readiness', healthOk);

const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;

async function startWebhook() {
  app.post(webhookPath, (req, res) => {
    if (SECRET) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!header || header !== SECRET) return res.status(401).send('unauthorized');
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

  // Register webhook with explicit allowed_updates
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  await bot.setWebHook(fullWebhook, {
    secret_token: SECRET || undefined,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`Webhook set: ${fullWebhook}`);
}

async function startPolling() {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.startPolling({
    interval: env.TELEGRAM_POLLING_INTERVAL || 300,
    params: { allowed_updates: ['message', 'callback_query'] },
  });
  console.log('Polling started.');
}

async function initialize() {
  await wireHandlers();
  if (USE_WEBHOOK) await startWebhook(); else await startPolling();
  try { const me = await bot.getMe(); console.log(`Bot @${me.username} ready in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`); } catch {}
}

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
