// src/bot.js – FINAL COMPLETE SCRIPT WITH DUAL AI & MANUAL WORKFLOWS

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import env, { isProduction } from './config/env.js';
import sentryService from './services/sentryService.js';
import GamesDataService from './services/gamesService.js';
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
    bot.deleteWebHook().then(() => bot.startPolling()).catch(err => console.error('❌ Local polling error:', err));
    console.log('🤖 Bot is running in local development mode (polling)...');
}

// --- Setup Persistent Quick Access Menu ---
bot.setMyCommands([
    { command: '/parlay', description: '✨ AI-Generated Parlay' },
    { command: '/custom', description: '✍️ Build Your Own Parlay' },
    { command: '/help', description: '❓ Help & Info' },
]);

// --- State Management ---
const getAIConfig = async (chatId) => {
    const configStr = await redis.get(`ai_config:${chatId}`);
    return configStr ? JSON.parse(configStr) : { legs: 3, strategy: 'balanced', includeProps: true };
};
const setAIConfig = async (chatId, config) => { await redis.set(`ai_config:${chatId}`, JSON.stringify(config), 'EX', 600); };
const getParlaySlip = async (chatId) => {
    const slipStr = await redis.get(`parlay_slip:${chatId}`);
    return slipStr ? JSON.parse(slipStr) : { picks: [], messageId: null };
};
const setParlaySlip = async (chatId, slip) => { await redis.set(`parlay_slip:${chatId}`, JSON.stringify(slip), 'EX', 7200); };

// --- UTILITY FUNCTIONS ---
const formatGameTime = (isoString) => {
    return new Date(isoString).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
};
const getSportEmoji = (sportKey) => {
    if (sportKey.includes('americanfootball')) return '🏈';
    if (sportKey.includes('basketball')) return '🏀';
    if (sportKey.includes('baseball')) return '⚾';
    if (sportKey.includes('icehockey')) return '🏒';
    if (sportKey.includes('soccer')) return '⚽';
    return '🏆';
};

// --- AI-First Workflow (`/parlay`) ---
const sendAIConfigurationMenu = async (chatId, messageId = null) => {
    const config = await getAIConfig(chatId);
    const text = `*Configure Your AI-Generated Parlay*\n\n` +
                 `*Legs:* ${config.legs}\n` +
                 `*Strategy:* ${config.strategy.charAt(0).toUpperCase() + config.strategy.slice(1)}\n` +
                 `*Player Props:* ${config.includeProps ? 'Yes ✅' : 'No ❌'}\n\n` +
                 `Tap to change settings, then hit 'Build' when ready.`;
    const keyboard = [
        [{ text: 'Legs: 2', callback_data: 'config_legs_2' }, { text: '3', callback_data: 'config_legs_3' }, { text: '4', callback_data: 'config_legs_4' }, { text: '5', callback_data: 'config_legs_5' }],
        [{ text: '🔥 Hot Picks', callback_data: 'config_strategy_highprobability' }, { text: '💰 Value', callback_data: 'config_strategy_balanced' }, { text: '🚀 Lottery', callback_data: 'config_strategy_lottery' }],
        [{ text: `Player Props: ${config.includeProps ? 'DISABLE' : 'ENABLE'}`, callback_data: 'config_props_toggle' }],
        [{ text: '🤖 Build My Parlay', callback_data: 'config_build' }]
    ];
    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    try {
        if (messageId) await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
        else await bot.sendMessage(chatId, text, options);
    } catch (error) { if (messageId) await bot.sendMessage(chatId, text, options); }
};

const handleAIBuildRequest = async (chatId, config, messageId) => {
    await bot.editMessageText("🤖 Accessing real-time market data and running deep quantitative analysis... This may take up to 90 seconds.", { chat_id: chatId, message_id: messageId, reply_markup: null });
    try {
        const popularLeagues = ['americanfootball_nfl', 'basketball_nba', 'soccer_epl', 'icehockey_nhl', 'baseball_mlb'];
        const promises = popularLeagues.map(key => GamesDataService.getGamesForSport(key));
        const results = await Promise.allSettled(promises);
        const availableGames = results.filter(res => res.status === 'fulfilled' && res.value?.length > 0).flatMap(res => res.value);
        if (availableGames.length < config.legs) {
            await bot.sendMessage(chatId, `There aren't enough upcoming games to build a ${config.legs}-leg parlay right now. Please try again later.`);
            return bot.deleteMessage(chatId, messageId);
        }
        const result = await AIService.buildAIParlay(config, availableGames);
        const { parlay } = result;
        const totalDecimalOdds = parlay.legs.reduce((acc, leg) => acc * (leg.odds > 0 ? (leg.odds/100)+1 : (100/Math.abs(leg.odds))+1), 1);
        const totalAmericanOdds = totalDecimalOdds >= 2 ? (totalDecimalOdds-1)*100 : -100/(totalDecimalOdds-1);
        parlay.total_odds = Math.round(totalAmericanOdds);
        let messageText = `📈 *${parlay.title || 'AI-Generated Parlay'}*\n\n_${parlay.overall_narrative}_\n\n`;
        parlay.legs.forEach(leg => {
            messageText += `*Leg ${leg.leg_number}*: ${leg.sport} — ${leg.game}\n*Pick*: *${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})*\n*Confidence*: ${'🟢'.repeat(Math.round(leg.confidence_score/2))}${'⚪'.repeat(5-Math.round(leg.confidence_score/2))}\n*Justification*: _${leg.justification}_\n\n`;
        });
        messageText += `*Total Odds*: *${parlay.total_odds > 0 ? '+' : ''}${parlay.total_odds}*`;
        await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
        await bot.deleteMessage(chatId, messageId);
    } catch (error) {
        sentryService.captureError(error, { component: 'ai_build_request' });
        await bot.sendMessage(chatId, `🚨 AI analysis failed.\n\n_Error: ${error.message}_`);
        await bot.deleteMessage(chatId, messageId);
    }
};

// --- Manual Parlay Builder Workflow (`/custom`) ---
const sendCustomSportSelection = async (chatId) => {
    const sports = await GamesDataService.getAvailableSports();
    if (!sports || sports.length === 0) {
        return bot.sendMessage(chatId, "There are no upcoming games in the database right now. Please try again in a few minutes.");
    }
    const keyboard = sports.map(sport => ([{ text: `${getSportEmoji(sport.sport_key)} ${sport.sport_title}`, callback_data: `cs_${sport.sport_key}` }]));
    await bot.sendMessage(chatId, "✍️ *Manual Parlay Builder*\n\nSelect a sport to view upcoming games:", {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
};

const sendCustomGameSelection = async (chatId, sportKey, messageId) => {
    const games = await GamesDataService.getGamesForSport(sportKey);
    if (!games || games.length === 0) {
        return bot.editMessageText("No upcoming games found for this sport.", { chat_id: chatId, message_id: messageId });
    }
    const keyboard = games.slice(0, 8).map(game => ([{ text: `${game.away_team} @ ${game.home_team}`, callback_data: `cg_${game.id}` }]));
    keyboard.push([{ text: '« Back to Sports', callback_data: 'cback_sports'}]);
    await bot.editMessageText("Select a game to add to your parlay:", {
        chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard }
    });
};

const sendMarketSelection = async (chatId, gameId, messageId) => {
    const game = await GamesDataService.getGameDetails(gameId);
    if (!game || !game.bookmakers || game.bookmakers.length === 0) {
        return bot.editMessageText("Could not find market data for this game.", { chat_id: chatId, message_id: messageId });
    }
    const availableMarkets = game.bookmakers[0].markets.map(market => market.key);
    const keyboard = [];
    if (availableMarkets.includes('h2h')) keyboard.push({ text: 'Moneyline', callback_data: `cm_${game.id}_h2h` });
    if (availableMarkets.includes('spreads')) keyboard.push({ text: 'Spreads', callback_data: `cm_${game.id}_spreads` });
    if (availableMarkets.includes('totals')) keyboard.push({ text: 'Totals', callback_data: `cm_${game.id}_totals` });

    await bot.editMessageText(`*${game.away_team} @ ${game.home_team}*\n${formatGameTime(game.commence_time)}\n\nSelect a market:`, {
        parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, 
        reply_markup: { inline_keyboard: [keyboard, [{ text: '« Back to Games', callback_data: `cback_games_${game.sport_key}` }]] }
    });
};

const sendPickSelection = async (chatId, gameId, marketKey, messageId) => {
    const game = await GamesDataService.getGameDetails(gameId);
    const market = game.bookmakers[0].markets.find(m => m.key === marketKey);
    if (!market) return bot.editMessageText("Market not available.", { chat_id: chatId, message_id: messageId });

    const keyboard = market.outcomes.map(outcome => {
        const pointText = outcome.point ? (outcome.point > 0 ? `+${outcome.point}` : outcome.point) : '';
        const priceText = outcome.price > 0 ? `+${outcome.price}` : outcome.price;
        return [{
            text: `${outcome.name} ${pointText} (${priceText})`,
            callback_data: `cpick_${game.id}_${marketKey}_${outcome.name}_${outcome.point || 0}_${outcome.price}`
        }];
    });
    keyboard.push([{ text: '« Back to Markets', callback_data: `cg_${game.id}` }]);
    await bot.editMessageText(`Select your pick for *${marketKey}*:`, {
        parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard }
    });
};

const renderParlaySlip = async (chatId) => {
    const slip = await getParlaySlip(chatId);
    if (!slip.messageId) {
        const sentMessage = await bot.sendMessage(chatId, "Initializing your parlay slip...");
        slip.messageId = sentMessage.message_id;
    }
    if (slip.picks.length === 0) {
        await bot.editMessageText("Your parlay slip is empty. Select a sport to add a leg.", {
            chat_id: chatId, message_id: slip.messageId
        });
        await bot.deleteMessage(chatId, slip.messageId);
        await setParlaySlip(chatId, { picks: [], messageId: null });
        return sendCustomSportSelection(chatId);
    }
    let slipText = "✍️ *Your Custom Parlay*\n\n";
    let totalOdds = 1;
    slip.picks.forEach((pick, index) => {
        const decimal = pick.odds > 0 ? (pick.odds / 100) + 1 : (100 / Math.abs(pick.odds)) + 1;
        totalOdds *= decimal;
        slipText += `*${index + 1}*: ${pick.selection} (${pick.odds > 0 ? '+' : ''}${pick.odds})\n   _${pick.game}_\n`;
    });
    const finalAmericanOdds = totalOdds >= 2 ? (totalOdds - 1) * 100 : -100 / (totalOdds - 1);
    slip.totalOdds = Math.round(finalAmericanOdds);
    slipText += `\n*Total Legs*: ${slip.picks.length}\n*Total Odds*: ≈ ${slip.totalOdds > 0 ? '+' : ''}${slip.totalOdds}`;
    const keyboard = [
        [{ text: '➕ Add Another Leg', callback_data: 'cslip_add' }],
        [{ text: `🗑️ Clear Slip (${slip.picks.length})`, callback_data: 'cslip_clear' }]
    ];
    await bot.editMessageText(slipText, {
        parse_mode: 'Markdown', chat_id: chatId, message_id: slip.messageId, reply_markup: { inline_keyboard: keyboard }
    });
    await setParlaySlip(chatId, slip);
};

// --- Bot Command Handlers ---
bot.onText(/\/parlay/, (msg) => sendAIConfigurationMenu(msg.chat.id));
bot.onText(/\/custom/, (msg) => sendCustomSportSelection(msg.chat.id));

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
    else if (data.startsWith('cback_sports')) {
        await bot.deleteMessage(chatId, message.message_id);
        await sendCustomSportSelection(chatId);
    }
    else if (data.startsWith('cback_games_')) {
        const sportKey = data.substring(12);
        await sendCustomGameSelection(chatId, sportKey, message.message_id);
    }
    else if (data.startsWith('cs_')) {
        const sportKey = data.substring(3);
        await sendCustomGameSelection(chatId, sportKey, message.message_id);
    }
    else if (data.startsWith('cg_')) {
        const gameId = data.substring(3);
        await sendMarketSelection(chatId, gameId, message.message_id);
    }
    else if (data.startsWith('cm_')) {
        const [_, gameId, marketKey] = data.split('_');
        await sendPickSelection(chatId, gameId, marketKey, message.message_id);
    }
    else if (data.startsWith('cpick_')) {
        const [__, gameId, marketKey, name, point, price] = data.split('_');
        const slip = await getParlaySlip(chatId);
        const game = await GamesDataService.getGameDetails(gameId);
        const pointText = parseFloat(point) !== 0 ? (parseFloat(point) > 0 ? `+${point}` : point) : '';
        slip.picks.push({
            game: `${game.away_team} @ ${game.home_team}`,
            selection: `${name} ${pointText}`,
            odds: parseInt(price)
        });
        await bot.deleteMessage(chatId, message.message_id);
        await renderParlaySlip(chatId);
    }
    else if (data.startsWith('cslip_')) {
        const action = data.substring(6);
        const slip = await getParlaySlip(chatId);
        if (action === 'add') {
            await bot.deleteMessage(chatId, slip.messageId);
            await setParlaySlip(chatId, { picks: [], messageId: null });
            await sendCustomSportSelection(chatId);
        } else if (action === 'clear') {
            await bot.deleteMessage(chatId, slip.messageId);
            await setParlaySlip(chatId, { picks: [], messageId: null });
            await bot.sendMessage(chatId, "Parlay slip cleared.");
        }
    }
});

// --- Error Handling & Server Start ---
process.on('unhandledRejection', (reason) => { sentryService.captureError(new Error('Unhandled Rejection'), { extra: { reason } }); });
process.on('uncaughtException', (error) => { sentryService.captureError(error, { component: 'uncaught_exception' }); process.exit(1); });

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
