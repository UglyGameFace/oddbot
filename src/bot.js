// src/bot.js – FINAL VERSION WITH BUTTON DATA FIX & ROBUST CALLBACKS

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import env, { isProduction } from './config/env.js';
import sentryService from './services/sentryService.js';
import OddsService from './services/oddsService.js';
import EnterpriseHealthService from './services/healthService.js';
import redis from './services/redisService.js';
import AIService from './services/aiService.js';

const app = express();
app.use(express.json());

// --- Health Check & Webhook Setup ---
const healthService = new EnterpriseHealthService(app);
healthService.initializeHealthCheckEndpoints();
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: !isProduction });

if (isProduction) {
    const webhookUrl = `${env.APP_URL}/api/webhook/${env.TELEGRAM_BOT_TOKEN}`;
    bot.setWebHook(webhookUrl).then(() => console.log(`✅ Webhook set`)).catch(err => console.error('❌ Failed to set webhook:', err));
    app.post(`/api/webhook/${env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    console.log('🤖 Bot is running in local development mode (polling)...');
}

// --- Setup Persistent Quick Access Menu ---
bot.setMyCommands([
    { command: '/parlay', description: '✨ AI-Generated Parlay' },
    { command: '/custom', description: '✍️ Build a Parlay Manually' },
    { command: '/help', description: '❓ Help & Info' },
]);

// --- Redis State Management for AI Configuration ---
const REDIS_CONFIG_EXPIRY = 600; // 10 minutes

async function getAIConfig(chatId) {
    const configStr = await redis.get(`ai_config:${chatId}`);
    return configStr ? JSON.parse(configStr) : {
        legs: 3, strategy: 'balanced', sportsFocus: 'All Major Sports', includeProps: true
    };
}

async function setAIConfig(chatId, config) {
    await redis.set(`ai_config:${chatId}`, JSON.stringify(config), 'EX', REDIS_CONFIG_EXPIRY);
}

// --- UI Generation for AI Configuration ---
async function sendAIConfigurationMenu(chatId, messageId = null) {
    const config = await getAIConfig(chatId);
    const text = `*Configure Your AI-Generated Parlay*\n\n` +
                 `*Legs:* ${config.legs}\n` +
                 `*Strategy:* ${config.strategy.charAt(0).toUpperCase() + config.strategy.slice(1)}\n` +
                 `*Player Props:* ${config.includeProps ? 'Yes ✅' : 'No ❌'}\n\n` +
                 `Tap to change settings, then hit 'Build' when ready.`;

    const keyboard = [
        [{ text: 'Legs: 2', callback_data: 'config_legs_2' }, { text: '3', callback_data: 'config_legs_3' }, { text: '4', callback_data: 'config_legs_4' }, { text: '5', callback_data: 'config_legs_5' }],
        [{ text: '🔥 Hot Picks', callback_data: 'config_strategy_highprobability' }, { text: '🚀 Lottery', callback_data: 'config_strategy_lottery' }],
        [{ text: `Player Props: ${config.includeProps ? 'DISABLE' : 'ENABLE'}`, callback_data: 'config_props_toggle' }],
        [{ text: '🤖 Build My Parlay', callback_data: 'config_build' }]
    ];
    
    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

    try {
        if (messageId) {
            await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        console.error("Error sending config menu:", error.message);
        // If editing fails, it might be because the message is old. Try sending a new one.
        if (messageId) await bot.sendMessage(chatId, text, options);
    }
}


// --- Bot Command Handlers ---
bot.onText(/\/parlay/, (msg) => sendAIConfigurationMenu(msg.chat.id));

bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq;
    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

    if (data.startsWith('config_')) {
        const [_, type, value] = data.split('_');
        const config = await getAIConfig(chatId);

        if (type === 'legs') config.legs = parseInt(value);
        else if (type === 'strategy') config.strategy = value;
        else if (type === 'props') config.includeProps = !config.includeProps;
        else if (type === 'build') {
            await handleAIBuildRequest(chatId, config, message.message_id);
            return;
        }

        await setAIConfig(chatId, config);
        await sendAIConfigurationMenu(chatId, message.message_id);
    }
});

async function handleAIBuildRequest(chatId, config, messageId) {
    await bot.editMessageText("🤖 Accessing real-time market data and running deep quantitative analysis... This may take up to 90 seconds.", {
        chat_id: chatId, message_id: messageId, reply_markup: null
    });

    try {
        const popularLeagues = ['americanfootball_nfl', 'basketball_nba', 'soccer_epl', 'icehockey_nhl', 'baseball_mlb'];
        const promises = popularLeagues.map(key => OddsService.getSportOdds(key));
        const results = await Promise.allSettled(promises);
        const availableGames = results
            .filter(res => res.status === 'fulfilled' && res.value?.length > 0)
            .flatMap(res => res.value);
            
        if (availableGames.length < config.legs) {
            await bot.sendMessage(chatId, `There aren't enough upcoming games to build a ${config.legs}-leg parlay right now. Please try again later.`);
            await bot.deleteMessage(chatId, messageId);
            return;
        }

        const result = await AIService.buildAIParlay(config, availableGames);
        const { parlay } = result;
        
        const totalDecimalOdds = parlay.legs.reduce((acc, leg) => {
            const decimal = leg.odds > 0 ? (leg.odds / 100) + 1 : (100 / Math.abs(leg.odds)) + 1;
            return acc * decimal;
        }, 1);
        const totalAmericanOdds = totalDecimalOdds >= 2 ? (totalDecimalOdds - 1) * 100 : -100 / (totalDecimalOdds - 1);
        parlay.total_odds = Math.round(totalAmericanOdds);
        
        let messageText = `📈 *${parlay.title || 'Your AI-Generated Parlay'}*\n\n_${parlay.overall_narrative}_\n\n`;
        parlay.legs.forEach(leg => {
            messageText += `*Leg ${leg.leg_number}*: ${leg.sport} — ${leg.game}\n`;
            messageText += `*Pick*: *${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})*\n`;
            messageText += `*Confidence*: ${'🟢'.repeat(Math.round(leg.confidence_score / 2))}${'⚪'.repeat(5 - Math.round(leg.confidence_score / 2))} (${leg.confidence_score}/10)\n`;
            messageText += `*Justification*: _${leg.justification}_\n\n`;
        });
        messageText += `*Total Odds*: *${parlay.total_odds > 0 ? '+' : ''}${parlay.total_odds}*`;
        
        await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
        await bot.deleteMessage(chatId, messageId);

    } catch (error) {
        sentryService.captureError(error, { component: 'ai_build_request' });
        await bot.sendMessage(chatId, `🚨 The AI analysis failed. This can happen during periods of high demand.\n\n_Error: ${error.message}_`);
        await bot.deleteMessage(chatId, messageId);
    }
}

// --- Error Handling ---
process.on('unhandledRejection', (reason, promise) => {
    sentryService.captureError(new Error('Unhandled Rejection'), { extra: { reason } });
});
process.on('uncaughtException', (error) => { 
    sentryService.captureError(error, { component: 'uncaught_exception' });
    process.exit(1);
});

// --- Start Express Server ---
const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
