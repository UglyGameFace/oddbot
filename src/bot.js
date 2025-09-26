// src/bot.js – Ultimate Telegram Parlay Bot WITH Full Parlay Builder UI (Date/Time always shown)
// REFACTORED FOR PRODUCTION: Uses Redis for persistent user state and initializes health checks.

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import env from './config/env.js';
import sentryService from './services/sentryService.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import EnterpriseHealthService from './services/healthService.js';
import redis from './services/redisService.js';

const app = express();
app.use(express.json());

// --- Health Check Initialization (CRITICAL FOR DEPLOYMENT) ---
const healthService = new EnterpriseHealthService(app);
healthService.initializeHealthCheckEndpoints();

// --- Redis State Management (Replaces in-memory Map) ---
const REDIS_STATE_EXPIRY = 3600; // 1 hour

async function getUserState(chatId) {
  const stateStr = await redis.get(`parlay_state:${chatId}`);
  return stateStr ? JSON.parse(stateStr) : {};
}

async function setUserState(chatId, state) {
  await redis.set(`parlay_state:${chatId}`, JSON.stringify(state), 'EX', REDIS_STATE_EXPIRY);
}

async function deleteUserState(chatId) {
  await redis.del(`parlay_state:${chatId}`);
}

// --- Telegram Bot Setup ---
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });

// ---- Parlay Builder UI Logic ----
bot.onText(/\/parlay/, async (msg) => {
  const chatId = msg.chat.id;
  const initialState = { step: 'choose_legs', picks: [], games: [], oddsTarget: '', confirmed: false };
  await setUserState(chatId, initialState);
  bot.sendMessage(chatId, 'How many legs do you want for your parlay?', {
    reply_markup: {
      inline_keyboard: [
        [2,3,4,5,6,7,8].map(n => ({ text: `${n} legs`, callback_data: `legs_${n}` }))
      ]
    }
  });
});

bot.on('callback_query', async (cbq) => {
  const chatId = cbq.message.chat.id;
  let state = await getUserState(chatId);

  // If state is empty, it might have expired or been cleared.
  if (!state.step) {
    bot.answerCallbackQuery(cbq.id, { text: "Your session has expired. Please start over." });
    bot.sendMessage(chatId, "Your parlay building session has expired. Please type /parlay to begin again.");
    return;
  }

  if (cbq.data.startsWith('legs_')) {
    state.numLegs = parseInt(cbq.data.slice(5), 10);
    state.step = "choose_sport";
    await setUserState(chatId, state);

    const sports = ['NBA','NFL','NHL','MLB','Soccer','Tennis'];
    bot.editMessageText("Select a sport for your first leg:", {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      reply_markup: {
        inline_keyboard: [sports.map(sport => ({ text: sport, callback_data: `sport_${sport}` }))]
      }
    });
    return;
  }

  if (cbq.data.startsWith('sport_')) {
    const pickedSport = cbq.data.slice(6);
    const allOdds = await OddsService.getSportOdds(pickedSport.toLowerCase());
    
    if (!allOdds || allOdds.length === 0) {
        bot.answerCallbackQuery(cbq.id, { text: `No upcoming games found for ${pickedSport}.` });
        return;
    }

    let menu = [];
    for (let game of allOdds.slice(0, 16)) {
      const gameDate = new Date(game.commence_time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      menu.push([{
        text: `${game.home_team} vs ${game.away_team}\n${gameDate}`,
        callback_data: `game_${pickedSport}_${game.id}`
      }]);
    }
    state.sport = pickedSport;
    state.gamesList = allOdds;
    state.step = "choose_game";
    await setUserState(chatId, state);
    bot.editMessageText(`Choose a game for Leg ${state.picks.length+1}:`, {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      reply_markup: { inline_keyboard: menu }
    });
    return;
  }

  if (cbq.data.startsWith('game_')) {
    const split = cbq.data.split('_');
    const gameId = split.slice(2).join('_');
    const game = state.gamesList.find(g => String(g.id) === gameId);

    if (!game) {
        bot.answerCallbackQuery(cbq.id, { text: "Game not found or session expired. Please restart." });
        return;
    }

    const gameDate = new Date(game.commence_time).toLocaleString();
    const markets = ['Moneyline','Spread','Total'];
    bot.editMessageText(
      `${game.home_team} vs ${game.away_team}\n${gameDate}\nSelect market type:`,
      {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        reply_markup: { inline_keyboard: [markets.map(mk => ({ text: mk, callback_data: `market_${game.id}_${mk}` }))] }
      }
    );
    return;
  }

  if (cbq.data.startsWith('market_')) {
    const split = cbq.data.split('_');
    const gameId = split[1];
    const marketType = split.slice(2).join('_');
    const game = state.gamesList.find(g => String(g.id) === gameId);
    
    if (!game) {
        bot.answerCallbackQuery(cbq.id, { text: "Game not found or session expired. Please restart." });
        return;
    }

    state.picks.push({
      sport: state.sport,
      gameId,
      market: marketType,
      home_team: game.home_team,
      away_team: game.away_team,
      commence_time: game.commence_time
    });

    if (state.picks.length < state.numLegs) {
      state.step = "choose_sport";
      await setUserState(chatId, state);
      bot.editMessageText(`Leg ${state.picks.length} added. Select a sport for Leg ${state.picks.length+1}:`, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        reply_markup: {
          inline_keyboard: [['NBA','NFL','NHL','MLB','Soccer','Tennis'].map(sport => ({ text: sport, callback_data: `sport_${sport}` }))]
        }
      });
    } else {
      state.step = "odds_target";
      await setUserState(chatId, state);
      bot.editMessageText(
        "All legs added. Set your parlay's total target odds or risk level:",
        {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Balanced", callback_data: "risk_balanced" }, { text: "Lottery", callback_data: "risk_lottery" }],
              [{ text: "High Probability", callback_data: "risk_highprobability" }]
            ]
          }
        }
      );
    }
    return;
  }

  if (cbq.data.startsWith('risk_')) {
    state.oddsTarget = cbq.data.replace('risk_', '');
    state.step = "confirm";
    await setUserState(chatId, state);

    const legMsgs = state.picks.map((pick, idx) => {
        const gameDate = new Date(pick.commence_time).toLocaleString();
        return `*Leg ${idx+1}*: ${pick.sport} – ${pick.home_team} vs ${pick.away_team}\n*Market*: ${pick.market}\n*Date*: ${gameDate}`;
    }).join('\n\n');
    
    bot.editMessageText(`*Your Custom Parlay:*\n\n${legMsgs}\n\n*Risk Profile*: ${state.oddsTarget}\n\nReady to generate parlay analysis?`, {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Lock & Analyze", callback_data: "confirm_yes" }],
          [{ text: "❌ Start Over", callback_data: "confirm_restart" }]
        ]
      }
    });
    return;
  }

  if (cbq.data === "confirm_restart") {
    await deleteUserState(chatId);
    bot.editMessageText("Parlay builder has been reset. Type /parlay to begin again!", {
        chat_id: chatId,
        message_id: cbq.message.message_id
    });
    return;
  }

  if (cbq.data === "confirm_yes") {
    bot.editMessageText("Building your portfolio... This involves complex quantitative analysis and may take a moment.", {
        chat_id: chatId,
        message_id: cbq.message.message_id
    });

    const userContext = { riskTolerance: state.oddsTarget, preferredSports: [...new Set(state.picks.map(p => p.sport))] };
    const gamesData = state.gamesList;

    try {
      const analysis = await AIService.generateParlayAnalysis(userContext, gamesData, state.oddsTarget);
      let message = '📈 *Your Tailored Parlay Portfolio*\n\n';
      analysis.parlay.legs.forEach((leg, idx) => {
        const gameDate = new Date(leg.commence_time).toLocaleString();
        message += `*Leg ${idx+1}*: ${leg.sport} — ${leg.teams}\n`;
        message += `*Pick*: ${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})\n`;
        message += `*Date*: ${gameDate}\n`;
        message += `*Justification*: _${leg.reasoning}_\n\n`;
      });
      message += `*Total Odds*: ${analysis.parlay.total_odds > 0 ? '+' : ''}${analysis.parlay.total_odds}\n`;
      message += `*Risk Assessment*: ${analysis.parlay.risk_assessment}\n`;
      message += `*AI Recommendation*: *${analysis.analysis.recommendation}* — ${analysis.analysis.strengths.join('. ')}\n`;
      
      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
      bot.sendMessage(chatId, '🚨 Unable to generate parlay analysis. The AI model may be overloaded or an internal error occurred. Please try again shortly.', { parse_mode: "Markdown" });
      sentryService.captureError(error, { context: 'custom_parlay_generate', chatId });
    }
    await deleteUserState(chatId);
    return;
  }
  
  // Acknowledge the callback query to remove the loading icon
  bot.answerCallbackQuery(cbq.id);
});

// --- Legacy Quick /start ---
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '💎 *Welcome to the Institutional AI Parlay Bot*\n\nUse `/parlay` to build a custom parlay with our advanced AI analysis.', { parse_mode: 'Markdown' });
});

// --- Error/uncaught handling ---
bot.on('polling_error', (error) => {
  sentryService.captureError(error, { component: 'telegram_polling' });
});
process.on('uncaughtException', (error) => {
  sentryService.captureError(error, { component: 'uncaught_exception' });
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    sentryService.captureError(new Error('Unhandled Rejection'), { extra: { reason, promise } });
});


// --- Start Express Server for health checks ---
const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
