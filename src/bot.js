// src/bot.js — FINAL: Sentry middleware, robust health, webhook with secret + allowed_updates, IPv4 bind by default
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import sentryService from './services/sentryService.js';

const app = express();
sentryService.attachExpressPreRoutes?.(app); // Sentry request + tracing
app.use(express.json());

const TOKEN = env.TELEGRAM_BOT_TOKEN;
const APP_URL = env.APP_URL;
const SECRET = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const USE_WEBHOOK = Boolean(APP_URL && APP_URL.startsWith('http'));
if (!TOKEN) {
  console.error('FATAL: Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false, filepath: false });

// Health endpoints (GET + HEAD -> 200)
const healthOk = (_req, res) => res.status(200).send('OK');
app.get('/', healthOk);                     app.head('/', healthOk);
app.get('/health', healthOk);               app.head('/health', healthOk);
app.get('/healthz', healthOk);              app.head('/healthz', healthOk);
app.get('/health/readiness', healthOk);     app.head('/health/readiness', healthOk);
app.get('/health/liveness', healthOk);      app.head('/health/liveness', healthOk);

// Keep all existing handlers; add only a safe callback ack to stop spinners
async function wireHandlers() {
  console.log('Wiring handlers...');
  const tryImport = async (p) => {
    try { const m = await import(p); console.log(`  ✅ Imported ${p}`); return m; }
    catch (e) { console.error(`  ❌ FAILED to import ${p}: ${e.message}`); return null; }
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
  // Baseline text ping
  bot.on('message', (msg) => {
    if (msg?.text?.trim().toLowerCase() === '/ping') bot.sendMessage(msg.chat.id, 'pong');
  });
  // Baseline callback ack (does not alter routing)
  bot.on('callback_query', async (q) => {
    try { await bot.answerCallbackQuery(q.id, { cache_time: 0 }); } catch {}
  });
  console.log('Handler wiring complete.');
}

const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
async function startWebhook() {
  app.post(webhookPath, (req, res) => {
    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
      return res.status(401).send('Unauthorized');
    }
    try { bot.processUpdate(req.body || {}); res.sendStatus(200); }
    catch (e) { console.error('processUpdate failed:', e?.message || e); res.sendStatus(500); }
  });
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  await bot.setWebHook(fullWebhook, {
    secret_token: SECRET || undefined,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`Webhook set: ${fullWebhook}`);
}
async function startPolling() {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.startPolling({ params: { allowed_updates: ['message', 'callback_query'] } });
  console.log('Polling started.');
}

// Sentry error middleware AFTER routes
sentryService.attachExpressPostRoutes?.(app);

// Unified, Railway- and local-friendly PORT/host binding
const PORT = process.env.PORT ? Number(process.env.PORT) : (env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Boot + listen
async function initialize() {
  await wireHandlers();
  if (USE_WEBHOOK) await startWebhook();
  else await startPolling();
  const me = await bot.getMe();
  console.log(`Bot @${me.username} ready in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
}

console.log(`Binding host ${HOST}, port ${PORT}`);
app.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on [${HOST}]:${PORT}. Initializing bot...`);
  initialize().catch((e) => {
    console.error('Fatal bot init error:', e?.message || e);
    process.exit(1);
  });
});
// Console safety nets
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
