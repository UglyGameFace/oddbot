// src/bot.js – FINAL SCRIPT WITH FOUR DISTINCT PARLAY-BUILDING METHODS

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

// --- NEW Persistent Menu with All Methods ---
bot.setMyCommands([
    { command: '/parlay', description: '✨ AI Analyst Parlay' },
    { command: '/quant', description: '⚡️ Quick Quant Picks' },
    { command: '/player', description: '🤵 Parlay by Player' },
    { command: '/custom', description: '✍️ Build Your Own Parlay' }
]);

// --- State Management ---
const getAIConfig = async (chatId) => { const c = await redis.get(`ai_config:${chatId}`); return c ? JSON.parse(c) : { legs: 3, strategy: 'balanced', includeProps: true }; };
const setAIConfig = async (chatId, config) => { await redis.set(`ai_config:${chatId}`, JSON.stringify(config), 'EX', 600); };
const getParlaySlip = async (chatId) => { const s = await redis.get(`parlay_slip:${chatId}`); return s ? JSON.parse(s) : { picks: [], messageId: null }; };
const setParlaySlip = async (chatId, slip) => { await redis.set(`parlay_slip:${chatId}`, JSON.stringify(slip), 'EX', 7200); };
const setUserState = async (chatId, state, expiry = 300) => { await redis.set(`user_state:${chatId}`, state, 'EX', expiry); };
const getUserState = async (chatId) => { return await redis.get(`user_state:${chatId}`); };

// --- UTILITY FUNCTIONS ---
const formatGameTime = (isoString) => new Date(isoString).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
const getSportEmoji = (sportKey) => {
    if (sportKey.includes('americanfootball')) return '🏈';
    if (sportKey.includes('basketball')) return '🏀';
    if (sportKey.includes('baseball')) return '⚾';
    if (sportKey.includes('icehockey')) return '🏒';
    if (sportKey.includes('soccer')) return '⚽';
    return '🏆';
};

// --- Method 1: AI Analyst (`/parlay`) ---
const sendAIConfigurationMenu = async (chatId, messageId = null) => {
    const config = await getAIConfig(chatId);
    const text = `*✨ AI Analyst Parlay*\n\nConfigure the AI's parameters and let it build a deeply researched parlay for you.`;
    const keyboard = [
        [{ text: `Legs: ${config.legs}`, callback_data: `config_legs_menu` }],
        [{ text: `Strategy: ${config.strategy}`, callback_data: 'config_strategy_menu' }],
        [{ text: `Player Props: ${config.includeProps ? '✅ Yes' : '❌ No'}`, callback_data: 'config_props_toggle' }],
        [{ text: '🤖 Build My Parlay', callback_data: 'config_build' }]
    ];
    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    if (messageId) await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
    else await bot.sendMessage(chatId, text, options);
};
const handleAIBuildRequest = async (chatId, config, messageId) => {
    await bot.editMessageText("🤖 Accessing real-time market data and running deep quantitative analysis...", { chat_id: chatId, message_id: messageId, reply_markup: null });
    try {
        const popularLeagues = ['americanfootball_nfl', 'basketball_nba', 'soccer_epl', 'icehockey_nhl'];
        const promises = popularLeagues.map(key => GamesDataService.getGamesForSport(key));
        const results = await Promise.allSettled(promises);
        const availableGames = results.filter(res => res.status === 'fulfilled' && res.value?.length > 0).flatMap(res => res.value);
        if (availableGames.length < config.legs) {
            await bot.sendMessage(chatId, `There aren't enough games to build a ${config.legs}-leg parlay.`);
            return bot.deleteMessage(chatId, messageId);
        }
        const result = await AIService.buildAIParlay(config, availableGames);
        const { parlay } = result;
        const totalDecimalOdds = parlay.legs.reduce((acc, leg) => acc * (leg.odds > 0 ? (leg.odds / 100) + 1 : (100 / Math.abs(leg.odds)) + 1), 1);
        const totalAmericanOdds = totalDecimalOdds >= 2 ? (totalDecimalOdds - 1) * 100 : -100 / (totalDecimalOdds - 1);
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

// --- Method 2: Quant Picks (`/quant`) ---
const sendQuantPickSelection = async (chatId) => {
    // This is a simple quant model for demonstration. It finds the heaviest favorite.
    const allGames = await GamesDataService.getGamesForSport('americanfootball_nfl'); // Example
    if (!allGames || allGames.length === 0) return bot.sendMessage(chatId, "No game data for quant analysis.");
    
    let heaviestFavorite = { odds: 0 };
    allGames.forEach(game => {
        const market = game.bookmakers[0]?.markets.find(m => m.key === 'h2h');
        if (!market) return;
        market.outcomes.forEach(outcome => {
            if (outcome.price < heaviestFavorite.odds) {
                heaviestFavorite = { ...outcome, game };
            }
        });
    });
    const message = `⚡️ *Today's Top Quant Pick*\n\nBased on market data, the heaviest favorite is:\n\n- *${heaviestFavorite.name} ML* (${heaviestFavorite.price})\n   _${heaviestFavorite.game.away_team} @ ${heaviestFavorite.game.home_team}_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
};

// --- Method 3: Parlay by Player (`/player`) ---
const handlePlayerSearch = async (chatId, playerName) => {
    const waitingMessage = await bot.sendMessage(chatId, `🔍 Searching for all available prop bets for *${playerName}*...`, { parse_mode: 'Markdown' });
    try {
        const result = await AIService.findPlayerProps(playerName);
        if (!result.props || result.props.length === 0) {
            return bot.editMessageText(`No prop bets found for *${playerName}*. They may not have an upcoming game or lines have not been posted.`, { chat_id: chatId, message_id: waitingMessage.message_id, parse_mode: 'Markdown' });
        }
        let text = `*Available Props for ${result.player_name}*\n_Game: ${result.game}_\n\nSelect props to add to your parlay slip:`;
        const keyboard = result.props.map(prop => ([{ text: `${prop.selection} (${prop.odds})`, callback_data: `ppick_${result.game}_${prop.selection}_${prop.odds}` }]));
        await bot.editMessageText(text, { chat_id: chatId, message_id: waitingMessage.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch(error) {
        await bot.editMessageText(`Could not find player props. Error: ${error.message}`, { chat_id: chatId, message_id: waitingMessage.message_id });
    }
};

// --- Method 4: Manual Builder (`/custom`) ---
const sendCustomSportSelection = async (chatId) => {
    const sports = await GamesDataService.getAvailableSports();
    if (!sports || sports.length === 0) return bot.sendMessage(chatId, "No upcoming games found.");
    const keyboard = sports.map(sport => ([{ text: `${getSportEmoji(sport.sport_key)} ${sport.sport_title}`, callback_data: `cs_${sport.sport_key}` }]));
    await bot.sendMessage(chatId, "✍️ *Manual Parlay Builder*\n\nSelect a sport:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
};
const sendCustomGameSelection = async (chatId, sportKey, messageId) => {
    const games = await GamesDataService.getGamesForSport(sportKey);
    if (!games || games.length === 0) return bot.editMessageText("No upcoming games found for this sport.", { chat_id: chatId, message_id: messageId });
    const keyboard = games.slice(0, 8).map(game => ([{ text: `${game.away_team} @ ${game.home_team}`, callback_data: `cg_${game.id}` }]));
    keyboard.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
    await bot.editMessageText("Select a game:", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
};
const sendMarketSelection = async (chatId, gameId, messageId) => {
    const game = await GamesDataService.getGameDetails(gameId);
    if (!game || !game.bookmakers || game.bookmakers.length === 0) return bot.editMessageText("Could not find market data.", { chat_id: chatId, message_id: messageId });
    const markets = game.bookmakers[0].markets.map(market => ({ text: market.key.charAt(0).toUpperCase() + market.key.slice(1), callback_data: `cm_${game.id}_${market.key}` }));
    const keyboard = [markets, [{ text: '« Back to Games', callback_data: `cback_games_${game.sport_key}` }]];
    await bot.editMessageText(`*${game.away_team} @ ${game.home_team}*\n${formatGameTime(game.commence_time)}\n\nSelect a market:`, { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
};
const sendPickSelection = async (chatId, gameId, marketKey, messageId) => {
    const game = await GamesDataService.getGameDetails(gameId);
    const market = game.bookmakers[0].markets.find(m => m.key === marketKey);
    if (!market) return bot.editMessageText("Market not available.", { chat_id: chatId, message_id: messageId });
    const keyboard = market.outcomes.map(outcome => {
        const pointText = outcome.point ? (outcome.point > 0 ? `+${outcome.point}` : outcome.point) : '';
        const priceText = outcome.price > 0 ? `+${outcome.price}` : outcome.price;
        return [{ text: `${outcome.name} ${pointText} (${priceText})`, callback_data: `cpick_${game.id}_${marketKey}_${outcome.name}_${outcome.point || 0}_${outcome.price}` }];
    });
    keyboard.push([{ text: '« Back to Markets', callback_data: `cg_${game.id}` }]);
    await bot.editMessageText(`Select your pick for *${marketKey}*:`, { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
};
const renderParlaySlip = async (chatId) => {
    const slip = await getParlaySlip(chatId);
    if (!slip.messageId) {
        const sentMessage = await bot.sendMessage(chatId, "Initializing your parlay slip...");
        slip.messageId = sentMessage.message_id;
    }
    if (slip.picks.length === 0) {
        await bot.editMessageText("Your parlay slip is empty. Select a sport to add a leg.", { chat_id: chatId, message_id: slip.messageId });
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
    await bot.editMessageText(slipText, { parse_mode: 'Markdown', chat_id: chatId, message_id: slip.messageId, reply_markup: { inline_keyboard: keyboard } });
    await setParlaySlip(chatId, slip);
};

// --- Bot Command & Message Handlers ---
bot.onText(/\/parlay/, (msg) => sendAIConfigurationMenu(msg.chat.id));
bot.onText(/\/quant/, (msg) => sendQuantPickSelection(msg.chat.id));
bot.onText(/\/custom/, (msg) => sendCustomSportSelection(msg.chat.id));
bot.onText(/\/player/, async (msg) => {
    await setUserState(msg.chat.id, 'awaiting_player_name');
    await bot.sendMessage(msg.chat.id, "🤵 Which player are you looking for?");
});
bot.on('message', async (msg) => {
    if (msg.text && (msg.text.startsWith('/') || !msg.text)) return;
    const state = await getUserState(msg.chat.id);
    if (state === 'awaiting_player_name') {
        await setUserState(msg.chat.id, 'none'); // Clear state
        await handlePlayerSearch(msg.chat.id, msg.text);
    }
});
bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq;
    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);
    if (data.startsWith('config_')) {
        const config = await getAIConfig(chatId);
        const [_, type, value] = data.split('_');
        if (type === 'legs') config.legs = parseInt(value); else if (type === 'strategy') config.strategy = value; else if (type === 'props') config.includeProps = !config.includeProps;
        else if (type === 'build') return handleAIBuildRequest(chatId, config, message.message_id);
        await setAIConfig(chatId, config);
        await sendAIConfigurationMenu(chatId, message.message_id);
    } else if (data.startsWith('cs_')) {
        await sendCustomGameSelection(chatId, data.substring(3), message.message_id);
    } else if (data.startsWith('cg_')) {
        await sendMarketSelection(chatId, data.substring(3), message.message_id);
    } else if (data.startsWith('cm_')) {
        const [_, gameId, marketKey] = data.split('_');
        await sendPickSelection(chatId, gameId, marketKey, message.message_id);
    } else if (data.startsWith('cpick_')) {
        const [__, gameId, marketKey, name, point, price] = data.split('_');
        const slip = await getParlaySlip(chatId);
        const game = await GamesDataService.getGameDetails(gameId);
        const pointText = parseFloat(point) !== 0 ? (parseFloat(point) > 0 ? `+${point}` : point) : '';
        slip.picks.push({ game: `${game.away_team} @ ${game.home_team}`, selection: `${name} ${pointText}`, odds: parseInt(price) });
        await bot.deleteMessage(chatId, message.message_id);
        await renderParlaySlip(chatId);
    } else if (data.startsWith('cslip_')) {
        const action = data.substring(6);
        const slip = await getParlaySlip(chatId);
        if (action === 'add') {
            await bot.deleteMessage(chatId, slip.message_id);
            await setParlaySlip(chatId, { picks: slip.picks, messageId: null });
            await sendCustomSportSelection(chatId);
        } else if (action === 'clear') {
            await bot.deleteMessage(chatId, slip.messageId);
            await setParlaySlip(chatId, { picks: [], messageId: null });
            await bot.sendMessage(chatId, "Parlay slip cleared.");
        }
    } else if (data.startsWith('ppick_')) { // Player Prop Pick
        const [_, game, selection, odds] = data.split('_');
        const slip = await getParlaySlip(chatId);
        slip.picks.push({ game, selection, odds: parseInt(odds) });
        await bot.deleteMessage(chatId, message.message_id);
        await renderParlaySlip(chatId);
    } else if (data.startsWith('cback_')) {
        const type = data.split('_')[1];
        if (type === 'sports') {
            await bot.deleteMessage(chatId, message.message_id);
            await sendCustomSportSelection(chatId);
        } else if (type === 'games') {
            await sendCustomGameSelection(chatId, data.substring(12), message.message_id);
        }
    }
});

// --- Error Handling & Server Start ---
process.on('unhandledRejection', (reason) => { sentryService.captureError(new Error('Unhandled Rejection'), { extra: { reason } }); });
process.on('uncaughtException', (error) => { sentryService.captureError(error, { component: 'uncaught_exception' }); process.exit(1); });
const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
