// src/bot.js – Ultimate Telegram Parlay Bot WITH Full Parlay Builder UI (Date/Time always shown)

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import env from './config/env.js';
import sentryService from './services/sentryService.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';

const app = express();
app.use(express.json());

// In-memory user session state (use RedisService for production scale)
const userParlayState = new Map();

// Healthchecks
app.get('/health/liveness', (_req, res) => res.status(200).json({ status: 'alive' }));

// --- Telegram Bot Setup ---
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });

// ---- Parlay Builder UI Logic ----
bot.onText(/\/parlay/, async (msg) => {
  const chatId = msg.chat.id;
  userParlayState.set(chatId, { step: 'choose_legs', picks: [], games: [], oddsTarget: '', confirmed: false });
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
  let state = userParlayState.get(chatId) || {};

  if (cbq.data.startsWith('legs_')) {
    state.numLegs = parseInt(cbq.data.slice(5), 10);
    state.step = "choose_sport";
    userParlayState.set(chatId, state);

    // Get available sports from live odds
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
    // Fetch all games for this sport
    const allOdds = await OddsService.getSportOdds(pickedSport.toLowerCase());
    let menu = [];
    // partitions for keyboard UI, always with date/time!
    for (let game of allOdds.slice(0, 16)) {
      menu.push([{
        text: `${game.home_team} vs ${game.away_team}\n${game.commence_time}`,
        callback_data: `game_${pickedSport}_${game.id}`
      }]);
    }
    state.sport = pickedSport;
    state.gamesList = allOdds; // for later market selection
    state.step = "choose_game";
    userParlayState.set(chatId, state);
    bot.editMessageText(`Choose a game for Leg ${state.picks.length+1}:`, {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      reply_markup: { inline_keyboard: menu }
    });
    return;
  }

  if (cbq.data.startsWith('game_')) {
    // Format: game_SPORT_gameid
    const split = cbq.data.split('_');
    const pickedSport = split[1];
    const gameId = split.slice(2).join('_');
    const state = userParlayState.get(chatId);
    // Find the game
    const game = state.gamesList.find(g => String(g.id) === gameId);
    // Show market choices
    const markets = ['Moneyline','Spread','Total'];
    bot.editMessageText(
      `${game.home_team} vs ${game.away_team}\n${game.commence_time}\nSelect market type:`,
      {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        reply_markup: { inline_keyboard: [markets.map(mk => ({ text: mk, callback_data: `market_${game.id}_${mk}` }))] }
      }
    );
    return;
  }

  if (cbq.data.startsWith('market_')) {
    // Format: market_gameid_type
    const split = cbq.data.split('_');
    const gameId = split[1];
    const marketType = split.slice(2).join('_');
    const state = userParlayState.get(chatId);
    const game = state.gamesList.find(g => String(g.id) === gameId);

    // Add this leg
    const picks = state.picks || [];
    picks.push({
      sport: state.sport,
      gameId,
      market: marketType,
      home_team: game.home_team,
      away_team: game.away_team,
      commence_time: game.commence_time
    });
    state.picks = picks;

    if (picks.length < state.numLegs) {
      // Next leg - repeat selection
      state.step = "choose_sport";
      userParlayState.set(chatId, state);
      bot.sendMessage(chatId, `Select a sport for Leg ${picks.length+1}:`, {
        reply_markup: {
          inline_keyboard: [['NBA','NFL','NHL','MLB','Soccer','Tennis'].map(sport => ({ text: sport, callback_data: `sport_${sport}` }))]
        }
      });
    } else {
      // All legs chosen - now set odds/risk, then confirm
      state.step = "odds_target";
      userParlayState.set(chatId, state);
      bot.sendMessage(chatId,
        "Set your parlay's total target odds or risk level:",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Balanced", callback_data: "risk_Balanced" }, { text: "Long Shot", callback_data: "risk_LongShot" }],
              [{ text: "Custom Odds", callback_data: "odds_Custom" }]
            ]
          }
        }
      );
    }
    return;
  }

  if (cbq.data.startsWith('risk_') || cbq.data.startsWith('odds_')) {
    const state = userParlayState.get(chatId);
    state.oddsTarget = cbq.data.replace(/^risk_/, '').replace(/^odds_/, '');
    state.step = "confirm";
    userParlayState.set(chatId, state);

    // Show summary
    const legMsgs = state.picks.map((pick, idx) => 
      `Leg ${idx+1}: ${pick.sport} – ${pick.home_team} vs ${pick.away_team}\n${pick.market} | ${pick.commence_time}`
    ).join('\n\n');
    bot.sendMessage(chatId, `Your Custom Parlay:\n\n${legMsgs}\n\nRisk/Odds: ${state.oddsTarget}\n\nReady to generate parlay?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Lock & Analyze", callback_data: "confirm_yes" }],
          [{ text: "Start Over", callback_data: "confirm_restart" }]
        ]
      }
    });
    return;
  }

  if (cbq.data === "confirm_restart") {
    userParlayState.delete(chatId);
    bot.sendMessage(chatId, "Restarting your parlay builder. Type /parlay to begin again!");
    return;
  }

  if (cbq.data === "confirm_yes") {
    // Run full AI analysis/parlay build
    const state = userParlayState.get(chatId);
    bot.sendMessage(chatId, "Generating your custom parlay with full analysis...", { parse_mode: "Markdown" });

    // Use legacy OddsService & AIService: build userContext, pass in picks
    const userContext = {
      riskPreference: state.oddsTarget,
      picks: state.picks
    };

    const fullGamesData = []; // Optionally refetch expanded game/market data

    try {
      const analysis = await AIService.generateParlayAnalysis(userContext, fullGamesData, 'user_custom');
      let message = '*Your Tailored Parlay Portfolio*\n\n';
      analysis.parlay.legs.forEach((leg, idx) => {
        message += `Leg ${idx+1}: ${leg.sport} — ${leg.teams}\n${leg.market} | ${leg.commence_time}\nPick: ${leg.selection} (${leg.odds > 0 ? '+' : ''}${leg.odds})\n\n`;
      });
      message += 'Total Odds: ' + (analysis.parlay.total_odds > 0 ? '+' : '') + analysis.parlay.total_odds + '\n';
      message += 'AI Recommendation: ' + analysis.analysis.recommendation + '\n';
      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
      bot.sendMessage(chatId, 'Unable to generate parlay. Reason: ' + error.message, { parse_mode: "Markdown" });
      sentryService.captureError(error, { context: 'custom_parlay_generate', chatId });
    }
    // Reset state after run
    userParlayState.delete(chatId);
    return;
  }
});

// --- Legacy Quick /parlay /start still supported ---
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '*Ultimate AI Parlay Bot - All Sports Coverage*\n\nUse /parlay to get started!', { parse_mode: 'Markdown' });
});

// --- Error/uncaught handling ---
bot.on('polling_error', (error) => {
  sentryService.captureError(error, { component: 'telegram_polling' });
});
process.on('uncaughtException', (error) => {
  sentryService.captureError(error);
  process.exit(1);
});

// --- Start Express Server for health etc (if needed by Railway) ---
const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`Parlay Bot HTTP server live on port ${PORT}`));
