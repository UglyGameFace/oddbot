// src/bot/handlers/ai.js - FINAL, COMPLETE, AND CORRECTED
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { getAIConfig, setUserState, getUserState } from '../state.js';
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../bot.js';
import { formatGameTimeTZ } from '../../utils/botUtils.js';

const escapeHTML = (text) => {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

const PAGE_SIZE = 10;
let sportsCache = null;
let sportsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000;

function pageOf(arr, page) {
  const start = page * PAGE_SIZE;
  return arr.slice(start, start + PAGE_SIZE);
}

async function getCachedSports() {
  const now = Date.now();
  if (sportsCache && now - sportsCacheTime < CACHE_DURATION) {
    return sportsCache;
  }
  try {
    sportsCache = await gamesService.getAvailableSports();
    sportsCacheTime = now;
    console.log(`🎉 Sports cache refreshed: ${sportsCache.length} sports found`);
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    return sportsCache || [];
  }
}

export function registerAI(bot) {
  bot.onText(/^\/ai(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await setUserState(chatId, { page: 0 });
      await sendSportSelection(bot, chatId);
    } catch (error) {
      console.error('❌ AI command handler error:', error);
      await bot.sendMessage(chatId, '❌ Failed to start AI Parlay Builder. Please try again.');
    }
  });
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    try {
      await bot.answerCallbackQuery(cbq.id);
    } catch (error) {
      if (!error.message.includes("query is too old")) {
        console.error("Error answering callback query:", error);
      }
    }

    let state = await getUserState(chatId) || {};
    const parts = data.split('_');
    const action = parts[1];

    try {
      switch (action) {
        case 'page':
          const newPage = parseInt(parts[2], 10) || 0;
          state.page = newPage;
          await setUserState(chatId, state);
          if (parts.length > 3 && parts[3] === 'games') {
              await sendGameSelection(bot, chatId, message.message_id, newPage);
          } else {
              await sendSportSelection(bot, chatId, message.message_id, newPage);
          }
          break;
        case 'sport':
          state.sportKey = parts.slice(2).join('_');
          state.page = 0; // Reset game page
          await setUserState(chatId, state);
          await sendGameSelection(bot, chatId, message.message_id);
          break;
        case 'game':
          state.gameId = parts.slice(2).join('_');
          await setUserState(chatId, state);
          await sendLegSelection(bot, chatId, message.message_id);
          break;
        case 'legs':
          state.numLegs = parseInt(parts[2], 10);
          await setUserState(chatId, state);
          await sendModeSelection(bot, chatId, message.message_id);
          break;
        case 'mode':
          state.mode = parts[2];
          await setUserState(chatId, state);
          await sendBetTypeSelection(bot, chatId, message.message_id);
          break;
        case 'bettype':
          state.betType = parts[2];
          state.aiModel = 'perplexity';
          await setUserState(chatId, state);
          await sendQuantitativeModeSelection(bot, chatId, message.message_id);
          break;
        case 'quantitative':
          state.quantitativeMode = parts[2];
          await setUserState(chatId, state);
          await executeAiRequest(bot, chatId, message.message_id);
          break;
        case 'back':
          const to = parts[2];
          if (to === 'sport') await sendSportSelection(bot, chatId, message.message_id, state.page || 0);
          if (to === 'game') await sendGameSelection(bot, chatId, message.message_id, state.page || 0);
          if (to === 'legs') await sendLegSelection(bot, chatId, message.message_id);
          if (to === 'mode') await sendModeSelection(bot, chatId, message.message_id);
          if (to === 'bettype') await sendBetTypeSelection(bot, chatId, message.message_id);
          break;
      }
    } catch (error) {
      console.error('❌ AI callback processing error:', error);
      await safeEditMessage(chatId, message.message_id, `❌ Error: ${escapeHTML(error.message)}`, { parse_mode: 'HTML' });
    }
  });
}

async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
    const sports = await getCachedSports();
    if (!sports || sports.length === 0) {
        const text = '⚠️ No sports available right now. Please try again later.';
        if (messageId) return safeEditMessage(chatId, messageId, text);
        return bot.sendMessage(chatId, text);
    }
    const sortedSports = sortSports(sports);
    const totalPages = Math.ceil(sortedSports.length / PAGE_SIZE) || 1;
    page = Math.min(Math.max(0, page), totalPages - 1);
    const slice = pageOf(sortedSports, page).map(s => ({ text: `${getSportEmoji(s.sport_key)} ${escapeHTML(s.sport_title)}`, callback_data: `ai_sport_${s.sport_key}` }));
    const rows = [];
    for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));
    if (totalPages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
        nav.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: 'ai_noop' });
        if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
        rows.push(nav);
    }
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 1:</b> Select a sport.`;
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (messageId) await safeEditMessage(chatId, messageId, text, opts);
    else await bot.sendMessage(chatId, text, opts);
}

async function sendGameSelection(bot, chatId, messageId, page = 0) {
    const state = await getUserState(chatId);
    const config = await getAIConfig(chatId);
    const games = await gamesService.getGamesForSport(state.sportKey, { hoursAhead: config.horizonHours || 72 });

    if (!games || games.length === 0) {
        const text = '⚠️ No upcoming games found for this sport within the selected time horizon. Please select another sport or adjust your settings.';
        return safeEditMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]] } });
    }

    const totalPages = Math.ceil(games.length / PAGE_SIZE) || 1;
    page = Math.min(Math.max(0, page), totalPages - 1);

    const keyboard = pageOf(games, page).map(game => {
        const gameTime = formatGameTimeTZ(game.commence_time);
        return [{ text: `${game.away_team} @ ${game.home_team}\n(${gameTime})`, callback_data: `ai_game_${game.event_id}` }];
    });
    
    if (totalPages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}_games` });
        nav.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: 'ai_noop' });
        if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}_games` });
        keyboard.push(nav);
    }

    keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 2:</b> Select a game to analyze.`;
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendLegSelection(bot, chatId, messageId) {
  const legOptions = [2, 3, 4, 5];
  const buttons = legOptions.map(num => ({ text: `${num} Legs`, callback_data: `ai_legs_${num}` }));
  const keyboard = [buttons.slice(0, 2), buttons.slice(2, 4)];
  keyboard.push([{ text: '« Back to Games', callback_data: 'ai_back_game' }]);
  const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 3:</b> How many legs for this game?`;
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendModeSelection(bot, chatId, messageId) {
  const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 4:</b> Select analysis mode.`;
  const keyboard = [
    [{ text: '🌐 Web Research (AI Picks)', callback_data: 'ai_mode_web'}],
    [{ text: '📡 Live API Data (AI Picks)', callback_data: 'ai_mode_live'}],
    [{ text: '💾 Database Only (Best Value)', callback_data: 'ai_mode_db'}],
    [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 5:</b> What kind of parlay?';
  const keyboard = [
    [{ text: '🎯 Moneyline Focus', callback_data: 'ai_bettype_moneyline'}],
    [{ text: '📊 Spreads & Totals', callback_data: 'ai_bettype_spreads'}],
    [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed'}],
    [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendQuantitativeModeSelection(bot, chatId, messageId) {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 6:</b> Select Analysis Strength';
    const keyboard = [
      [{ text: '🔬 Conservative (Recommended)', callback_data: 'ai_quantitative_conservative' }],
      [{ text: '🚀 Aggressive (High Risk)', callback_data: 'ai_quantitative_aggressive' }],
      [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function executeAiRequest(bot, chatId, messageId = null) {
    let sentMessage;
    if (messageId) {
        sentMessage = { chat: { id: chatId }, message_id: messageId };
    } else {
        sentMessage = await bot.sendMessage(chatId, '🤖 <b>Analyzing... Please wait.</b>', { parse_mode: 'HTML' });
    }
    const state = await getUserState(chatId);
    const { sportKey, numLegs, mode, betType, aiModel, quantitativeMode, gameId } = state || {};

    if (!sportKey || !numLegs || !mode || !betType || !gameId) {
        return safeEditMessage(chatId, sentMessage.message_id, '❌ Incomplete selection. Please start over using /ai.');
    }

    const game = await gamesService.getGameById(gameId);
    
    // CRITICAL FIX: Check for fallback data source
    if (!game || game.source === 'fallback') {
        const errorMessage = `❌ <b>Cannot Analyze Game: Invalid Data Source</b>\n\n` +
                             `The bot has detected that its live odds providers are failing. This usually means your API keys are expired or invalid.\n\n` +
                             `A real parlay cannot be generated without a working data source. Please check your API keys and try again.`;
        return safeEditMessage(chatId, sentMessage.message_id, errorMessage, { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: [[{ text: '« Change Game', callback_data: 'ai_back_game' }]] } 
        });
    }

    const gameTitle = game ? `${game.away_team} @ ${game.home_team}` : 'Selected Game';
    
    const sportTitle = getSportEmoji(sportKey) + ' ' + getSportTitle(sportKey);
    const text = `🤖 <b>Analyzing... This may take up to 90 seconds.</b>\n\n` +
                 `<b>Game:</b> ${escapeHTML(gameTitle)}\n`+
                 `<b>Strategy:</b> ${escapeHTML(numLegs)}-Leg Parlay\n` +
                 `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                 `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n\n` +
                 `<i>The AI is performing deep web research and running quantitative checks...</i>`;

    await safeEditMessage(chatId, sentMessage.message_id, text, { parse_mode: 'HTML' });

    try {
        const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, { 
            quantitativeMode, 
            horizonHours: (await getAIConfig(chatId)).horizonHours || 72,
            chatId: chatId,
            gameContext: game 
        });
        await sendParlayResult(bot, chatId, parlay, state, mode, sentMessage.message_id);
    } catch (error) {
        console.error('AI handler execution error:', error.message);
        const errorMessage = `❌ <b>AI Analysis Failed</b>\n\nThe AI provider failed to generate a parlay after multiple attempts. This can happen during periods of high demand or if the selected game has limited available data.\n\n` +
                             `<i>Please try again in a few moments or select a different game.</i>\n\n` +
                             `<b>Error Details:</b> <code>${escapeHTML(error.message)}</code>`;
        await safeEditMessage(chatId, sentMessage.message_id, errorMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Try Again', callback_data: `ai_game_${gameId}` }, { text: '« Change Game', callback_data: 'ai_back_game' }]] } });
    }
}

async function sendParlayResult(bot, chatId, parlay, state, mode, messageId) {
    const { sportKey, numLegs } = state;
    const { legs, parlay_price_american, quantitative_analysis, research_metadata, portfolio_construction } = parlay;
    const sportTitle = getSportTitle(sportKey);
    
    if (!legs || legs.length < numLegs) {
        const errorText = `❌ <b>No Profitable Parlay Found</b>\n\n` +
                         `The AI and quantitative models could not construct a valid ${numLegs}-leg parlay with a positive expected value (+EV) from the selected game.\n\n`+
                         `This is a feature, not a bug. A disciplined analyst does not force a bet when there's no value. Try another game or adjust your settings.`;
        const keyboard = [[{ text: '🔄 Try a Different Game', callback_data: 'ai_back_game' }, { text: '🔄 New Sport', callback_data: 'ai_back_sport' }]];
        return safeEditMessage(chatId, messageId, errorText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
    
    let response = `🧠 <b>QUANTUM PARLAY REPORT</b>\n`;
    response += `<b>Sport:</b> ${escapeHTML(sportTitle)}\n`;
    if (portfolio_construction?.overall_thesis) {
        response += `<b>Thesis:</b> <i>${escapeHTML(portfolio_construction.overall_thesis)}</i>\n`;
    }
    response += `\n`;

    legs.forEach((leg, index) => {
        const game = escapeHTML(leg.event || 'Unknown game');
        const pick = escapeHTML(leg.selection || 'Unknown pick');
        const oddsValue = leg.odds?.american;
        const odds = (oddsValue && Number.isFinite(oddsValue)) ? (oddsValue > 0 ? `+${oddsValue}` : oddsValue) : '';
        const gameTime = leg.commence_time ? formatGameTimeTZ(leg.commence_time) : 'Time TBD';

        response += `<b>Leg ${index + 1}: ${game}</b>\n`;
        response += `  <b>Time:</b> ${escapeHTML(gameTime)}\n`;
        response += `  <b>Pick:</b> ${pick} (${escapeHTML(odds)})\n`;
        if (leg.quantum_analysis?.analytical_basis) {
            response += `  <i>Rationale: ${escapeHTML(leg.quantum_analysis.analytical_basis)}</i>\n\n`;
        } else {
            response += `\n`;
        }
    });

    response += `<b>Total Odds:</b> ${parlay.parlay_price_american > 0 ? '+' : ''}${escapeHTML(parlay.parlay_price_american)}\n`;
    
    if (quantitative_analysis && !quantitative_analysis.error) {
        const { calibrated, riskAssessment } = quantitative_analysis;
        response += `<b>Calibrated EV:</b> ${escapeHTML(calibrated.evPercentage.toFixed(1))}% ${calibrated.evPercentage > 0 ? '👍' : '👎'}\n`;
        response += `<b>Win Probability:</b> ${escapeHTML((calibrated.jointProbability * 100).toFixed(1))}%\n`;
        response += `<b>Risk Level:</b> ${escapeHTML(riskAssessment.overallRisk)}\n`;
    }

    const finalKeyboard = [[{ text: '🔄 Build Another', callback_data: 'ai_back_sport' }]];
    await safeEditMessage(chatId, messageId, response, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } });
}
