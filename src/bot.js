// src/bot.js - Fixed with Webhooks to Resolve Polling Conflict (No More 409 Errors)

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import * as https from 'https';
import env from './config/env.js';
import sentryService from './services/sentryService.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import redis from './services/redisService.js';
import HealthService from './services/healthService.js';

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100
});

// Single global Express app
const app = express();

// Add health endpoints to the global app
app.get('/health/liveness', (_req, res) => res.status(200).json({ status: 'alive' }));
app.get('/health/readiness', async (_req, res) => {
  try {
    await DatabaseService.healthCheck();
    const redisPing = await redis.ping();
    if (redisPing !== 'PONG') throw new Error('Redis ping failed');
    res.status(200).json({ status: 'ready', checks: { db: 'ok', redis: 'ok' } });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});

class UltimateParlayBot {
  constructor() {
    this.services = {};
  }

  initializeCoreServices() {
    this.services.sentryService = sentryService;
    console.log('Core services initialized.');
  }

  initializeServer() {
    // Return the existing global app (no new app or listen here)
    return app;
  }

  initializeBot() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { webhook: true });

    // Set webhook URL (use your app's public URL, e.g., from Railway)
    this.bot.setWebHook(`${env.APP_URL}/bot${env.TELEGRAM_BOT_TOKEN}`);

    // Handle incoming webhook updates via Express
    app.post(`/bot${env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
      this.bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    this.bot.on('webhook_error', (error) => {
      console.error('Webhook Error:', error.message);
      sentryService.captureError(error, { component: 'telegram_webhook' });
    });
  }

  setupCommandHandlers() {
    this.bot.onText(/\/start/, (msg) => this.handleStartCommand(msg));
    this.bot.onText(/\/parlay/, (msg) => this.handleParlayCommand(msg));
  }

  setupErrorHandling() {
    this.bot.on('polling_error', (error) => {
      console.error('POLLING ERROR:', error.message);
      sentryService.captureError(error, { component: 'telegram_polling' });
    });

    process.on('uncaughtException', (error) => {
      console.error('UNCAUGHT EXCEPTION:', error);
      sentryService.captureError(error);
      process.exit(1);
    });
  }

  async start() {
    try {
      console.log('Starting Ultimate Parlay Bot...');

      this.initializeCoreServices();
      const serverApp = this.initializeServer();

      this.services.healthService = new HealthService(serverApp);
      this.services.healthService.initializeHealthCheckEndpoints();

      this.initializeBot();
      this.setupCommandHandlers();
      this.setupErrorHandling();

      this.setupGracefulShutdown();

      console.log('Bot is now running and connected to Telegram.');

      // Single listen call at the end
      this.server = app.listen(env.PORT, env.HOST || '0.0.0.0', () => {
        console.log('Server is live on port ' + env.PORT);
      });
    } catch (error) {
      console.error('Failed to start the application.', error);
      sentryService.captureError(error, { component: 'application_startup' });
      process.exit(1);
    }
  }

  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    try {
      await DatabaseService.createOrUpdateUser(msg.from);
      const welcomeMessage = '*Ultimate AI Parlay Bot - All Sports Coverage*\n\nUse /parlay to get started!';
      this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      this.sendErrorMessage(chatId, 'Could not process start command', error);
    }
  }

  async handleParlayCommand(msg) {
    const chatId = msg.chat.id;
    const loadingMessage = await this.bot.sendMessage(chatId, 'Analyzing markets...', { parse_mode: 'Markdown' });
    try {
      const gamesData = await OddsService.getAllSportsOdds();
      if (!gamesData || gamesData.length === 0) {
        throw new Error('No games are available right now. Please check back later.');
      }

      const userContext = { riskTolerance: 'medium' };
      const analysis = await AIService.generateParlayAnalysis(userContext, gamesData, 'balanced');

      const parlayMessage = this.formatParlayMessage(analysis);
      this.bot.editMessageText(parlayMessage, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      this.bot.editMessageText('Unable to generate parlay. Reason: ' + error.message, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown'
      });
      this.sendErrorMessage(chatId, 'Parlay generation failed', error);
    }
  }

  formatParlayMessage(analysis) {
    if (!analysis || !analysis.parlay || !analysis.parlay.legs) {
      throw new Error('AI returned an invalid analysis format.');
    }
    let message = '*AI-Generated Parlay Portfolio*\n\n';
    analysis.parlay.legs.forEach((leg, index) => {
      message += (index + 1) + '. ' + leg.sport + ': ' + leg.teams + '\n';
      message += '   Pick: ' + leg.selection + ' (' + (leg.odds > 0 ? '+' : '') + leg.odds + ')\n\n';
    });
    message += 'Total Odds: ' + (analysis.parlay.total_odds > 0 ? '+' : '') + analysis.parlay.total_odds + '\n';
    message += 'AI Recommendation: ' + analysis.analysis.recommendation + '\n';
    return message;
  }

  sendErrorMessage(chatId, context, error) {
    console.error('ERROR [' + context + ']:', error.message);
    sentryService.captureError(error, { extra: { context: context, chatId: chatId } });
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log('\nReceived ' + signal + '. Shutting down gracefully...');
      if (this.bot) {
        await this.bot.deleteWebHook();  // Clean up webhook on shutdown
        console.log('Webhook removed.');
      }
      if (this.server) {
        this.server.close(() => {
          console.log('HTTP server closed.');
          process.exit(0);
        });
      }
      setTimeout(() => {
        console.error('Forcefully shutting down after timeout.');
        process.exit(1);
      }, 5000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

const botApp = new UltimateParlayBot();
botApp.start();
