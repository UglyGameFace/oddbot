// src/bot.js - Core Application Entry Point (Final, Robust Version)
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import * as https from 'https';

import env from './config/env.js';
import sentryService from './services/sentryService.js';
import HealthService from './services/healthService.js';
// We are removing direct dependencies on other services here to ensure bot starts up
import { initializeHandlers } from './handlers/index.js';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

class ParlayBotApplication {
  constructor() {
    this.services = {};
    this.server = null;
    this.bot = null;
  }

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
      process.exit(1);
    }
  }
  
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

// Lazy load services inside the handlers index to avoid circular dependencies
// This requires a change in handlers/index.js
const app = new ParlayBotApplication();
app.start();
