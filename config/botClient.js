 
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const isProduction = process.env.NODE_ENV === 'production';

if (!TOKEN) {
    throw new Error('FATAL ERROR: TELEGRAM_BOT_TOKEN is not defined in the environment variables.');
}

const bot = new TelegramBot(TOKEN, { polling: !isProduction });

export const setupWebhook = async () => {
    if (!WEBHOOK_URL) {
        console.error("CRITICAL ERROR: WEBHOOK_URL is not set for production environment.");
        return false;
    }
    const webhookPath = `/api/webhook/${TOKEN}`;
    try {
        await bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`);
        console.log(`Webhook set to ${WEBHOOK_URL}${webhookPath}`);
        return true;
    } catch (error) {
        console.error('Failed to set webhook:', error.message);
        return false;
    }
};

export { bot };
