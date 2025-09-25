// src/bot.js - Core Application Entry Point (Final, Corrected Version)
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
// --- FIX: Import the native 'https' module for a secure agent ---
import * as https from 'https';

import env from './config/env.js';
import sentryService from './services/sentryService.js';
import HealthService from './services/healthService.js';
import rateLimitService from './services/rateLimitService.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import { initializeHandlers } from './handlers/index.js';

// --- FIX: Create a dedicated HTTPS agent to ensure secure, stable connections ---
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  timeout: 30000,
});

class ParlayBotApplication {
  constructor() {
    this.services = {};
    this.server = null;
    this.bot = null;
  }

  async start() {
    try {
      console.log('🚀 Starting Institutional Parlay Bot...');
      
      this.initializeServices();
      const app = this.initializeServer();
      
      this.services.healthService = new HealthService(app);
      this.services.healthService.initializeHealthCheckEndpoints();
      
      this.initializeBot();
      initializeHandlers(this.bot, this.services);
      
      console.log('✅ Bot is now running and connected to Telegram.');

    } catch (error) {
      console.error('❌ CRITICAL: Failed to start the application.', error);
      sentryService.captureError(error, { component: 'application_startup' });
      process.exit(1);
    }
  }
  
  initializeServices() {
    this.services.sentryService = sentryService;
    this.services.rateLimitService = rateLimitService;
    this.services.dbService = DatabaseService;
    this.services.aiService = AIService;
    this.services.oddsService = OddsService;
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
      // --- FIX: Pass the secure HTTPS agent to the request options ---
      request: { agent: httpsAgent }
    });
    this.bot.on('polling_error', (error) => {
      // Avoid spamming logs for known, recoverable network errors
      if (error.code !== 'EFATAL') {
        console.error('Telegram Polling Error:', error.message);
      }
      sentryService.captureError(error, { component: 'telegram_polling' });
    });
  }
}

// Start the application
const app = new ParlayBotApplication();
app.start();

