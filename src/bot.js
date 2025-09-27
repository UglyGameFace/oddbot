// src/bot.js
import env from './config/env.js';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import sentryService from './services/sentryService.js';
import { registerAnalytics } from './bot/handlers/analytics.js';
import { registerModel } from './bot/handlers/model.js';
import { registerCacheHandler } from './bot/handlers/cache.js';
import { registerCustom, registerCustomCallbacks } from './bot/handlers/custom.js';
import { registerAI, registerAICallbacks } from './bot/handlers/ai.js';
import { registerQuant } from './bot/handlers/quant.js';
import { registerPlayer } from './bot/handlers/player.js'; // FIX: Removed non-existent import
import { registerSettings } from './bot/handlers/settings.js'; // FIX: Removed non-existent import
import { registerSystem } from './bot/handlers/system.js'; // FIX: Removed non-existent import
import { registerTools, registerCommonCallbacks } from './bot/handlers/tools.js';

const app = express();
app.get('/liveness', (_req, res) => res.sendStatus(200));
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
const bot = new TelegramBot(TOKEN, { polling: !USE_WEBHOOK, filepath: false });

async function wireHandlers() {
  console.log('Wiring handlers...');
  registerAnalytics(bot);
  registerModel(bot);
  registerCacheHandler(bot);
  registerCustom(bot);
  registerCustomCallbacks(bot);
  registerAI(bot);
  registerAICallbacks(bot);
  registerQuant(bot);
  registerPlayer(bot); // FIX: No second callback function needed
  registerSettings(bot); // FIX: No second callback function needed
  registerSystem(bot); // FIX: No second callback function needed
  registerTools(bot);
  registerCommonCallbacks(bot);
  console.log('✅ All handlers registered.');
}

const webhookPath = `/webhook/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}`;
async function startWebhook() {
  app.post(webhookPath, (req, res) => {
    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
      return res.status(401).send('Unauthorized');
    }
    try { 
      bot.processUpdate(req.body || {}); 
      res.sendStatus(200); 
    } catch (e) { 
      console.error('processUpdate failed:', e?.message || e); 
      res.sendStatus(500); 
    }
  });
  const fullWebhook = `${APP_URL.replace(/\/+$/, '')}${webhookPath}`;
  await bot.setWebHook(fullWebhook, { secret_token: SECRET || undefined, allowed_updates: ['message','callback_query'] });
  console.log(`Webhook set: ${fullWebhook}`);
}

sentryService.attachExpressPostRoutes?.(app);

async function initialize() {
  await wireHandlers();
  if (USE_WEBHOOK) {
    await startWebhook();
  }
  const me = await bot.getMe();
  console.log(`Bot @${me.username} ready in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.`);
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on [${HOST}]:${PORT}. Initializing bot...`);
  initialize().catch((e) => {
    console.error('Fatal bot init error:', e?.message || e);
    process.exit(1);
  });
});
