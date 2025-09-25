// src/bot.js - Core Application Entry Point (Corrected)
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import * as http from 'http';

import env from './config/env.js';
import sentryService from './services/sentryService.js';
import HealthService from './services/healthService.js';
import rateLimitService from './services/rateLimitService.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import { initializeHandlers } from './handlers/index.js';

const agent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 30000 });

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
      const app = this.initializeServer(); // This now returns the express app
      
      // --- FIX: Initialize HealthService AFTER the server is ready ---
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
    return app; // Return the app instance
  }

  initializeBot() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
      polling: true,
      request: { agent }
    });
    this.bot.on('polling_error', (error) => {
      console.error('Telegram Polling Error:', error.message);
      sentryService.captureError(error, { component: 'telegram_polling' });
    });
  }
}

const app = new ParlayBotApplication();
app.start();
