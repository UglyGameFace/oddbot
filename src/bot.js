<<<<<<< HEAD
// src/bot.js - Final, Stable, and Complete Version
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
=======
// src/bot.js - Core Application Entry Point (Final, Robust Version)
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
>>>>>>> 2b5cac90c34e2386d8fda21964d40901acbf9f3b
import * as https from 'https';

import env from './config/env.js';
import sentryService from './services/sentryService.js';
<<<<<<< HEAD
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import redis from './services/redisService.js'; // Ensure Redis is imported

// --- STABILITY FIX: Create a dedicated HTTPS agent for reliable connections ---
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
});
=======
import HealthService from './services/healthService.js';
// We are removing direct dependencies on other services here to ensure bot starts up
import { initializeHandlers } from './handlers/index.js';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
>>>>>>> 2b5cac90c34e2386d8fda21964d40901acbf9f3b

// --- STABILITY FIX: Express App for Health Checks ---
const app = express();
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
app.listen(env.PORT, () => console.log(`✅ Health endpoints live on port ${env.PORT}`));


class UltimateParlayBot {
  constructor() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
      polling: {
        interval: 300,
        autoStart: true,
        params: {
          timeout: 10,
        },
      },
      request: { agent: httpsAgent }
    });
    this.setupErrorHandling();
    this.setupCommandHandlers();
  }

<<<<<<< HEAD
  setupErrorHandling() {
    this.bot.on('polling_error', (error) => {
        console.error('POLLING ERROR:', error.message);
        sentryService.captureError(error, { component: 'telegram_polling' });
    });
    process.on('uncaughtException', (error) => {
      console.error('UNCAUGHT EXCEPTION:', error);
      sentryService.captureError(error);
=======
  async start() {
    try {
      console.log('🚀 Starting Institutional Parlay Bot...');
      
      this.initializeCoreServices();
      const app = this.initializeServer();
      
      this.services.healthService = new HealthService(app);
      this.services.healthService.initializeHealthCheckEndpoints();
      
      this.initializeBot();
      // We pass the service loader to the handlers, not the bot itself
      initializeHandlers(this.bot, this.services);
      
      this.setupGracefulShutdown(); // Add shutdown handler
      
      console.log('✅ Bot is now running and connected to Telegram.');

    } catch (error) {
      console.error('❌ CRITICAL: Failed to start the application.', error);
      sentryService.captureError(error, { component: 'application_startup' });
>>>>>>> 2b5cac90c34e2386d8fda21964d40901acbf9f3b
      process.exit(1);
    });
  }

  setupCommandHandlers() {
    this.bot.onText(/\/start/, (msg) => this.handleStartCommand(msg));
    this.bot.onText(/\/parlay/, (msg) => this.handleParlayCommand(msg));
  }

  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    try {
      await DatabaseService.createOrUpdateUser(msg.from);
      const welcomeMessage = `🎯 *Ultimate AI Parlay Bot - All Sports Coverage*\n\n` +
                             `Use /parlay to get started!`;
      this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      this.sendErrorMessage(chatId, 'Could not process start command', error);
    }
  }

  async handleParlayCommand(msg) {
    const chatId = msg.chat.id;
    const loadingMessage = await this.bot.sendMessage(chatId, '🤖 Analyzing markets...', { parse_mode: 'Markdown' });
    try {
      const gamesData = await OddsService.getAllSportsOdds();
      if (!gamesData || gamesData.length === 0) {
        throw new Error('No games are available right now. Please check back later.');
      }
      // Simplified user context for stability
      const userContext = { riskTolerance: 'medium' }; 
      const analysis = await AIService.generateParlayAnalysis(userContext, gamesData, 'balanced');
      
      const parlayMessage = this.formatParlayMessage(analysis);
      this.bot.editMessageText(parlayMessage, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      this.bot.editMessageText(`❌ *Unable to generate parlay.*\n\n*Reason:* ${error.message}`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
      });
      this.sendErrorMessage(chatId, 'Parlay generation failed', error);
    }
  }
  
<<<<<<< HEAD
  formatParlayMessage(analysis) {
    if (!analysis || !analysis.parlay || !analysis.parlay.legs) {
        throw new Error('AI returned an invalid analysis format.');
    }
    let message = `🎯 *AI-Generated Parlay Portfolio*\n\n`;
    analysis.parlay.legs.forEach((leg, index) => {
      message += `*${index + 1}. ${leg.sport}:* ${leg.teams}\n`;
      message += `   └ *Pick:* ${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})\n\n`;
    });
    message += `*Total Odds:* ${analysis.parlay.total_odds > 0 ? '+' : ''}${analysis.parlay.total_odds}\n`;
    message += `*AI Recommendation:* ${analysis.analysis.recommendation}\n`;
    return message;
  }
  
  sendErrorMessage(chatId, context, error) {
      console.error(`ERROR [${context}]:`, error.message);
      sentryService.captureError(error, { extra: { context, chatId } });
=======
  initializeCoreServices() {
    this.services.sentryService = sentryService;
    // Lazy load other services inside handlers to prevent startup race conditions
    console.log('✅ Core services initialized.');
  }

  initializeServer() {
    const app = express();
    this.server = app.listen(env.PORT, env.HOST, () => {
      console.log(`🌐 Server is live at http://${env.HOST}:${env.PORT}`);
    });
    return app;
  }

  initializeBot() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
      polling: true,
      request: { agent: httpsAgent }
    });
    this.bot.on('polling_error', (error) => {
      console.error('Telegram Polling Error:', error.message);
      sentryService.captureError(error, { component: 'telegram_polling' });
    });
>>>>>>> 2b5cac90c34e2386d8fda21964d40901acbf9f3b
  }
  
  // --- FIX: Add a graceful shutdown handler ---
  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🚦 Received ${signal}. Shutting down gracefully...`);
      if (this.bot && this.bot.isPolling()) {
        await this.bot.stopPolling();
        console.log(' Bot polling stopped.');
      }
      if (this.server) {
        this.server.close(() => {
          console.log(' HTTP server closed.');
          process.exit(0);
        });
      }
      setTimeout(() => {
        console.error(' Forcefully shutting down after timeout.');
        process.exit(1);
      }, 5000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

<<<<<<< HEAD
// --- STABILITY FIX: Graceful shutdown to prevent 409 Conflict error ---
const shutdown = (signal) => {
    console.log(`\n🚦 Received ${signal}. Shutting down...`);
    // The bot instance might not be available if startup fails
    if (botInstance && botInstance.bot && botInstance.bot.isPolling()) {
        botInstance.bot.stopPolling().then(() => {
            console.log(' Bot polling stopped.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

let botInstance;
try {
    console.log('✅ Initializing bot...');
    botInstance = new UltimateParlayBot();
    console.log('✅ Bot is live and accepting commands.');
} catch(error) {
    console.error('❌ CRITICAL: Failed to initialize bot.', error);
    sentryService.captureError(error, { component: 'bot_initialization' });
    process.exit(1);
}
=======
// Lazy load services inside the handlers index to avoid circular dependencies
// This requires a change in handlers/index.js
const app = new ParlayBotApplication();
app.start();
>>>>>>> 2b5cac90c34e2386d8fda21964d40901acbf9f3b
