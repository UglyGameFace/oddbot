// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import sentryService from './services/sentryService.js';
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCache } from './bot/handlers/cache.js';

const app = express();

// LIVENESS PROBE
app.get('/liveness', (_req, res) => res.sendStatus(200));
app.head('/liveness', (_req, res) => res.sendStatus(200));

sentryService.attachExpressPreRoutes(app);
app.use(express.json());

// HEALTH ENDPOINTS
const healthOk = (_req, res) => res.status(200).send('OK');
['/', '/health', '/healthz', '/health/readiness', '/health/liveness'].forEach((path) => {
  app.get(path, healthOk);
  app.head(path, healthOk);
});

const TOKEN = env.TELEGRAM_BOT_TOKEN;
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
  console.log('✅ All handlers registered.');
}

async function initialize() {
  await wireHandlers();
  const useWebhook = Boolean(env.APP_URL && env.APP_URL.startsWith('http'));
  if (useWebhook) {
    const secret = env.TELEGRAM_WEBHOOK_SECRET || undefined;
    const path = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
    app.post(path, (req, res) => {
      if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
        return res.sendStatus(401);
      }
      bot.processUpdate(req.body || {});
      res.sendStatus(200);
    });
    const url = `${env.APP_URL.replace(/\/+$/, '')}${path}`;
    await bot.setWebHook(url, { secret_token: secret });
    console.log(`Webhook set: ${url}`);
  } else {
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    await bot.startPolling({ params: { allowed_updates: ['message', 'callback_query'] } });
    console.log('Polling started.');
  }
  const me = await bot.getMe();
  console.log(`Bot @${me.username} ready.`);
}

sentryService.attachExpressPostRoutes(app);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
  initialize().catch((e) => {
    console.error('Initialization error:', e);
    process.exit(1);
  });
});

process.on('SIGTERM', () => app.close(() => process.exit(0)));
process.on('SIGINT', () => app.close(() => process.exit(0)));
