// src/workers/notificationWorker.js - ENTERPRISE MESSAGE BUS
import TelegramBot from 'node-telegram-bot-api';
import redis from '../services/redisService.js';
import env from '../config/env.js';
import sentryService from './sentryService.js';

const NOTIFICATION_QUEUE_KEY = 'notification_queue';

class EnterpriseNotificationEngine {
  constructor() {
    this.isReady = false;
    this.bot = null;
    this.initialize();
  }

  initialize() {
    if (env.TELEGRAM_BOT_TOKEN) {
        this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
        this.isReady = true;
        console.log('✅ Enterprise Notification Engine initialized.');
        this.startListening();
    } else {
        console.warn('🚨 Notification Engine disabled: TELEGRAM_BOT_TOKEN not set.');
    }
  }

  async startListening() {
    console.log('...Notification worker listening for messages on Redis queue...');
    while (true) {
        try {
            // Blocking pop with a timeout of 0 to wait forever
            const result = await redis.blpop(NOTIFICATION_QUEUE_KEY, 0);
            if (result) {
                const notification = JSON.parse(result[1]);
                await this.deliverNotification(notification);
            }
        } catch (error) {
            console.error('❌ Notification worker error:', error);
            sentryService.captureError(error, { component: 'notification_worker' });
            // Wait 5 seconds before retrying to prevent rapid-fire errors
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
