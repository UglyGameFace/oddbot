// src/bot.js – FINAL VERSION WITH DYNAMIC & PAGINATED UI
// Supports all sports from the API and uses the interactive "Parlay Slip" model.

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import env from './config/env.js';
import sentryService from './services/sentryService.js';
import OddsService from './services/oddsService.js';
import EnterpriseHealthService from './services/healthService.js';
import redis from './services/redisService.js';
import AIService from './services/aiService.js';

const app = express();
app.use(express.json());

// --- Health Check Initialization ---
const healthService = new EnterpriseHealthService(app);
healthService.initializeHealthCheckEndpoints();

// --- Telegram Bot Setup ---
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });

// --- Setup Persistent Quick Access Menu ---
bot.setMyCommands([
    { command: '/parlay', description: 'Build a Custom Parlay' },
    { command: '/picks', description: 'Get Quick AI Picks' },
    { command: '/stats', description: 'View My Betting Stats' },
    { command: '/help', description: 'Show Help & Info' },
]);

// --- Redis State Management for Parlay Slips ---
const REDIS_STATE_EXPIRY = 7200; // 2 hours

async function getParlaySlip(chatId) {
  const slipStr = await redis.get(`parlay_slip:${chatId}`);
  return slipStr ? JSON.parse(slipStr) : { picks: [], messageId: null };
}

async function setParlaySlip(chatId, slip) {
  await redis.set(`parlay_slip:${chatId}`, JSON.stringify(slip), 'EX', REDIS_STATE_EXPIRY);
}

// --- Time Zone Solution: Displaying UTC ---
function formatGameTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
    });
}

// --- UI Generation Functions ---

function getSportEmoji(sportKey) {
    if (sportKey.includes('americanfootball')) return '🏈';
    if (sportKey.includes('basketball')) return '🏀';
    if (sportKey.includes('baseball')) return '⚾';
    if (sportKey.includes('icehockey')) return '🏒';
    if (sportKey.includes('soccer')) return '⚽';
    if (sportKey.includes('tennis')) return '🎾';
    if (sportKey.includes('mma')) return '🥊';
    return '🏆';
}

async function sendSportSelection(chatId, page = 0, messageId = null) {
    const sports = await OddsService.getSupportedSports();
    if (!sports || sports.length === 0) {
        bot.sendMessage(chatId, "Could not load sports leagues at this time. Please try again later.");
        return;
    }
    
    const ITEMS_PER_PAGE = 8;
    const startIndex = page * ITEMS_PER_PAGE;
    const pageSports = sports.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const keyboardRows = pageSports.map(sport => ([{
        text: `${getSportEmoji(sport.key)} ${sport.title}`,
        callback_data: `ps_${sport.key}` // ps_ = Parlay Sport
    }]));

    const navButtons = [];
    if (page > 0) navButtons.push({ text: '◀️ Back', callback_data: `sportspage_${page - 1}` });
    if (startIndex + ITEMS_PER_PAGE < sports.length) {
        navButtons.push({ text: 'Next ▶️', callback_data: `sportspage_${page + 1}` });
    }
    if (navButtons.length > 0) keyboardRows.push(navButtons);

    const text = "Select a sport to add a leg to your parlay:";
    const options = { reply_markup: { inline_keyboard: keyboardRows } };

    if (messageId) {
        await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
    } else {
        await bot.sendMessage(chatId, text, options);
    }
}

async function sendGameSelection(chatId, sportKey, messageId) {
    const games = await OddsService.getSportOdds(sportKey);
    if (!games || games.length === 0) {
        bot.editMessageText("No upcoming games found for this sport. Please select another.", { chat_id: chatId, message_id: messageId });
        setTimeout(() => sendSportSelection(chatId, 0, messageId), 2000); // Go back after 2 seconds
        return;
    }

    const keyboard = [];
    games.slice(0, 8).forEach(game => {
        const gameTime = formatGameTime(game.commence_time);
        const moneyline = game.bookmakers?.[0]?.markets.find(m => m.key === 'h2h');
        if (moneyline && moneyline.outcomes.length >= 2) {
            const homePick = moneyline.outcomes.find(o => o.name === game.home_team);
            const awayPick = moneyline.outcomes.find(o => o.name === game.away_team);
            if (homePick && awayPick) {
                keyboard.push([
                    { text: `${awayPick.name} (${awayPick.price > 0 ? '+' : ''}${awayPick.price})`, callback_data: `pick_${game.id}_${awayPick.name}_${awayPick.price}` },
                    { text: `${homePick.name} (${homePick.price > 0 ? '+' : ''}${homePick.price})`, callback_data: `pick_${game.id}_${homePick.name}_${homePick.price}` },
                ]);
                keyboard.push([{ text: `🗓️ ${gameTime}`, callback_data: 'noop' }]);
            }
        }
    });

    if (keyboard.length === 0) {
        bot.editMessageText("Could not find valid odds for upcoming games. Please select another sport.", { chat_id: chatId, message_id: messageId });
        setTimeout(() => sendSportSelection(chatId, 0, messageId), 2000);
        return;
    }
    keyboard.push([{ text: '« Back to Sports', callback_data: 'back_sports_0'}]);
    
    await bot.editMessageText(`*Select a pick for ${games[0].sport_title}*`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
}

async function renderParlaySlip(chatId, slip) {
    if (!slip.messageId) {
        const sentMessage = await bot.sendMessage(chatId, "Initializing your parlay slip...");
        slip.messageId = sentMessage.message_id;
    }

    let slipText = "📋 *Your Parlay Slip*\n\n";
    let totalOdds = 1;

    slip.picks.forEach((pick, index) => {
        const decimalOdds = pick.odds > 0 ? (pick.odds / 100) + 1 : (100 / Math.abs(pick.odds)) + 1;
        totalOdds *= decimalOdds;
        slipText += `*${index + 1}*: ${pick.selection} (${pick.odds > 0 ? '+' : ''}${pick.odds})\n`;
        slipText += `   _${pick.home_team} vs ${pick.away_team}_\n`;
    });

    const finalAmericanOdds = totalOdds > 1 ? (totalOdds >= 2 ? (totalOdds - 1) * 100 : -100 / (totalOdds - 1)) : 0;
    slip.totalOdds = Math.round(finalAmericanOdds);
    
    slipText += `\n*Total Legs*: ${slip.picks.length}\n*Total Odds*: ≈ ${slip.totalOdds > 0 ? '+' : ''}${slip.totalOdds}`;
    
    const keyboard = [
        [{ text: '➕ Add Another Leg', callback_data: 'slip_add' }],
        [{ text: '🤖 Generate AI Analysis', callback_data: 'slip_analyze' }],
        [{ text: `🗑️ Clear Slip (${slip.picks.length})`, callback_data: 'slip_clear' }]
    ];

    await bot.editMessageText(slipText, {
        chat_id: chatId, message_id: slip.messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    await setParlaySlip(chatId, slip);
}

// --- Bot Command Handlers ---
bot.onText(/\/parlay/, (msg) => sendSportSelection(msg.chat.id, 0));

bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq;
    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

    if (data.startsWith('sportspage_') || data.startsWith('back_sports_')) {
        const page = parseInt(data.split('_')[2]);
        await sendSportSelection(chatId, page, message.message_id);
        return;
    }
    
    if (data.startsWith('ps_')) {
        const sportKey = data.substring(3);
        await sendGameSelection(chatId, sportKey, message.message_id);
        return;
    }
    
    if (data.startsWith('pick_')) {
        const [_, gameId, selection, odds] = data.split('_');
        const slip = await getParlaySlip(chatId);
        const allOdds = await OddsService.getAllSportsOdds(); // Should be cached
        const game = allOdds.find(g => g.id === gameId);

        if (game) {
             slip.picks.push({
                gameId: game.id, selection, odds: parseInt(odds),
                home_team: game.home_team, away_team: game.away_team, sport: game.sport_title
            });
            await renderParlaySlip(chatId, slip);
        }
        return;
    }
    
    if (data.startsWith('slip_')) {
        const action = data.substring(5);
        const slip = await getParlaySlip(chatId);

        if (action === 'add') {
            await sendSportSelection(chatId, 0, slip.messageId);
        } else if (action === 'clear') {
             await bot.deleteMessage(chatId, slip.messageId);
             await redis.del(`parlay_slip:${chatId}`);
             await bot.sendMessage(chatId, "Parlay slip cleared.");
        } else if (action === 'analyze') {
            if (slip.picks.length < 2) {
                await bot.answerCallbackQuery(cbq.id, { text: "You need at least 2 legs to build a parlay.", show_alert: true });
                return;
            }
            await bot.editMessageText("🤖 Analyzing your parlay with our institutional AI model...", {
                chat_id: chatId, message_id: slip.messageId, reply_markup: null
            });
            
            try {
                const userContext = { riskTolerance: 'balanced', preferredSports: [...new Set(slip.picks.map(p => p.sport))] };
                const analysis = await AIService.generateParlayAnalysis(userContext, [], 'balanced'); // Pass picks for more context
                
                let messageText = '📈 *Your Tailored Parlay Portfolio*\n\n';
                analysis.parlay.legs.forEach((leg, idx) => {
                    const gameDate = new Date(leg.commence_time).toLocaleString();
                    messageText += `*Leg ${idx+1}*: ${leg.sport} — ${leg.teams}\n`;
                    messageText += `*Pick*: ${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})\n`;
                    messageText += `*Justification*: _${leg.reasoning}_\n\n`;
                });
                messageText += `*Total Odds*: ${analysis.parlay.total_odds > 0 ? '+' : ''}${analysis.parlay.total_odds}\n`;
                messageText += `*AI Recommendation*: *${analysis.analysis.recommendation}*`;
                
                await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
            } catch (error) {
                sentryService.captureError(error, { component: 'ai_analysis_slip' });
                await bot.sendMessage(chatId, "🚨 AI analysis failed. Please try again later.");
            } finally {
                await bot.deleteMessage(chatId, slip.messageId);
                await redis.del(`parlay_slip:${chatId}`);
            }
        }
        return;
    }
});

// --- Error/uncaught handling ---
bot.on('polling_error', (error) => sentryService.captureError(error, { component: 'telegram_polling' }));
process.on('uncaughtException', (error) => { sentryService.captureError(error, { component: 'uncaught_exception' }); process.exit(1); });

// --- Start Express Server ---
const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
