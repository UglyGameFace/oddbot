// src/workers/notificationWorker.js - FINALIZED AND CORRECTED
import TelegramBot from 'node-telegram-bot-api';
import Redis from 'ioredis';
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';

const NOTIFICATION_QUEUE_KEY = 'notification_queue';

class EnterpriseNotificationEngine {
  constructor() {
    this.isReady = false;
    this.bot = null;
    this.redisClient = null;
    this.initialize().catch(error => {
        console.error('❌ FATAL: Failed to initialize the notification engine.', error);
        sentryService.captureError(error, { component: 'notification_worker_initialization' });
    });
  }

  async initialize() {
    if (env.TELEGRAM_BOT_TOKEN) {
        this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
        this.redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
        this.isReady = true;
        console.log('✅ Notification Engine initialized with dedicated Redis client.');
        this.startListening();
    } else {
        console.warn('🚨 Notification Engine disabled: TELEGRAM_BOT_TOKEN not set.');
    }
  }

  async startListening() {
    console.log('...Notification worker listening for messages on Redis queue...');
    while (true) {
        try {
            const result = await this.redisClient.blpop(NOTIFICATION_QUEUE_KEY, 0);
            if (result) {
                const notification = JSON.parse(result[1]);
                await this.deliverNotification(notification);
            }
        } catch (error) {
            console.error('❌ Notification worker error:', error);
            sentryService.captureError(error, { component: 'notification_worker' });
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
  }

  async deliverNotification(notification) {
    if (!this.isReady) return;
    try {
        await this.bot.sendMessage(notification.userId, notification.message, { parse_mode: 'Markdown' });
        console.log(`✉️ Notification sent to user ${notification.userId}`);
    } catch (error) {
        console.error(`Failed to send notification to ${notification.userId}:`, error.message);
        sentryService.captureError(error, {
            component: 'notification_delivery',
            context: { userId: notification.userId }
        });
    }
  }
}

new EnterpriseNotificationEngine();
