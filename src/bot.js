import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import sentryService from './services/sentryService.js';
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
// Create Express app
const app = express();

// LIVENESS & HEALTH PROBES
app.get('/liveness', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));
const healthOk = (_req, res) => res.status(200).send('OK');
['/', '/health', '/healthz', '/health/readiness', '/health/liveness'].forEach((path) => {
  app.get(path, healthOk);
  app.head(path, healthOk);
});

sentryService.attachExpressPreRoutes?.(app);
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

async function wireHandlers() {
  console.log('Wiring handlers...');
  registerAnalytics(bot);
  registerModel(bot);
  registerCache(bot);
  // Register any other modules/handlers here
  console.log('✅ All handlers registered.');
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
  await bot.setWebHook(fullWebhook, { secret_token: SECRET || undefined, allowed_updates: ['message','callback_query'] });
  console.log(`Webhook set: ${fullWebhook}`);
}
async function startPolling() {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.startPolling({ params: { allowed_updates: ['message','callback_query'] } });
  console.log('Polling started.');
}

sentryService.attachExpressPostRoutes?.(app);

async function initialize() {
  await wireHandlers();
  if (USE_WEBHOOK) await startWebhook(); else await startPolling();
  const me = await bot.getMe();
  console.log(`Bot @${me.username} ready in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
console.log(`Binding host ${HOST}, port ${PORT}`);
app.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on [${HOST}]:${PORT}. Initializing bot...`);
  initialize().catch((e) => {
    console.error('Fatal bot init error:', e?.message || e);
    process.exit(1);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => app.close?.(() => process.exit(0)));
process.on('SIGINT', () => app.close?.(() => process.exit(0)));
