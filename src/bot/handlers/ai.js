// src/bot/handlers/ai.js - COMPLETELY FIXED
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState } from '../state.js';
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../utils/asyncUtils.js';

const escapeHTML = (text) => {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (sportsCache && sportsCacheTime && (now - sportsCacheTime) < CACHE_DURATION) {
    return sportsCache;
  }
  try {
    sportsCache = await gamesService.getAvailableSports();
    sportsCacheTime = now;
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    return sportsCache || [];
  }
}

export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await setUserState(chatId, { page: 0 });
      await sendSportSelection(bot, chatId);
    } catch (error) {
      console.error('❌ Error in /ai command:', error);
      bot.sendMessage(chatId, '❌ Failed to start AI Parlay Builder. Please try again.');
    }
  });
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    
    try {
      await bot.answerCallbackQuery(cbq.id);
    } catch (error) {
      if (!error.message?.includes("query is too old")) {
        console.error("Error answering callback query:", error);
      }
    }

    let state = await getUserState(chatId) || {};
    const parts = data.split('_');
    const action = parts[1];

    try {
      if (action === 'page') {
        state.page = parseInt(parts[2], 10) || 0;
        await setUserState(chatId, state);
        return sendSportSelection(bot, chatId, messageId, state.page);
      }
      if (action === 'sport') {
        state.sportKey = parts.slice(2).join('_');
        await setUserState(chatId, state);
        return sendLegSelection(bot, chatId, messageId);
      }
      if (action === 'legs') {
        state.numLegs = parseInt(parts[2], 10);
        await setUserState(chatId, state);
        return sendModeSelection(bot, chatId, messageId);
      }
      if (action === 'mode') {
        state.mode = parts[2];
        await setUserState(chatId, state);
        return sendBetTypeSelection(bot, chatId, messageId);
      }
      if (action === 'bettype') {
        state.betType = parts[2];
        await setUserState(chatId, state);
        return sendAiModelSelection(bot, chatId, messageId);
      }
      if (action === 'model') {
        state.aiModel = parts[2];
        await setUserState(chatId, state);
        return executeAiRequest(bot, chatId, messageId);
      }
      if (action === 'fallback') {
          const selectedMode = parts[2];
          const { sportKey, numLegs, betType = 'mixed' } = state;
          if (!sportKey || !numLegs) return;
          
          try {
            await safeEditMessage(bot, chatId, messageId, `🔄 Switching to <b>${escapeHTML(selectedMode.toUpperCase())}</b> mode...`);
            const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, selectedMode, betType);
            await sendParlayResult(bot, chatId, parlay, state, messageId);
          } catch (error) {
            await safeEditMessage(bot, chatId, messageId, `❌ Fallback failed: <code>${escapeHTML(error.message)}</code>`);
          } finally {
            await setUserState(chatId, {});
          }
          return;
      }
      if (action === 'back') {
        const to = parts[2];
        if (to === 'sport') return sendSportSelection(bot, chatId, messageId, state.page || 0);
        if (to === 'legs') return sendLegSelection(bot, chatId, messageId);
        if (to === 'mode') return sendModeSelection(bot, chatId, messageId);
        if (to === 'bettype') return sendBetTypeSelection(bot, chatId, messageId);
      }
    } catch (error) {
      console.error('❌ Error in AI callback handler:', error);
      await safeEditMessage(bot, chatId, messageId, `❌ Error: ${escapeHTML(error.message)}`);
    }
  });
}

async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
    const sports = await getCachedSports();
    if (!sports || sports.length === 0) {
        const text = '⚠️ No sports available right now. Please try again later.';
        if (messageId) return safeEditMessage(bot, chatId, messageId, text);
        return bot.sendMessage(chatId, text);
    }
    const sortedSports = sortSports(sports);
    const totalPages = Math.ceil(sortedSports.length / PAGE_SIZE) || 1;
    page = Math.min(Math.max(0, page), totalPages - 1);
    const slice = pageOf(sortedSports, page).map(s => ({
        text: `${getSportEmoji(s.sport_key)} ${escapeHTML(s.sport_title)}`, 
        callback_data: `ai_sport_${s.sport_key}`
    }));
    const rows = [];
    for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));
    if (totalPages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
        nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'ai_noop' });
        if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
        rows.push(nav);
    }
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 1:</b> Select a sport.`;
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (messageId) {
        await safeEditMessage(bot, chatId, messageId, text, opts);
    } else {
        await bot.sendMessage(chatId, text, opts);
    }
}

async function sendLegSelection(bot, chatId, messageId) {
    const state = await getUserState(chatId);
    const sportTitle = getSportTitle(state.sportKey);
    const legOptions = [2, 3, 4, 5, 6, 7, 8];
    const buttons = legOptions.map(num => ({
      text: `${num} Legs`, callback_data: `ai_legs_${num}`
    }));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4));
    keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 2:</b> How many legs for your ${escapeHTML(sportTitle)} parlay?`;
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(bot, chatId, messageId, text, opts);
}

async function sendModeSelection(bot, chatId, messageId) {
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 3:</b> Select analysis mode.`;
    const keyboard = [
      [{ text: '🌐 Web Research (Recommended)', callback_data: 'ai_mode_web'}],
      [{ text: '📡 Live API Data (Fastest)', callback_data: 'ai_mode_live'}],
      [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db'}],
      [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(bot, chatId, messageId, text, opts);
}

async function sendBetTypeSelection(bot, chatId, messageId) {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 4:</b> What kind of parlay?';
    const keyboard = [
      [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props'}],
      [{ text: '🎯 Moneyline Focus', callback_data: 'ai_bettype_moneyline'}],
      [{ text: '📊 Spreads & Totals', callback_data: 'ai_bettype_spreads'}],
      [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed'}],
      [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(bot, chatId, messageId, text, opts);
}

async function sendAiModelSelection(bot, chatId, messageId) {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 5:</b> Choose Research AI.';
    const keyboard = [
      [{ text: '🧠 Gemini (Creative)', callback_data: 'ai_model_gemini'}],
      [{ text: '⚡️ Perplexity (Data-Focused)', callback_data: 'ai_model_perplexity'}],
      [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(bot, chatId, messageId, text, opts);
}

async function executeAiRequest(bot, chatId, messageId) {
    const state = await getUserState(chatId);
    const { sportKey, numLegs, mode, betType, aiModel } = state || {};
    if (!sportKey || !numLegs || !mode || !betType) {
        return safeEditMessage(bot, chatId, messageId, '❌ Incomplete selection. Please start over using /ai.');
    }
    const sportTitle = getSportEmoji(sportKey) + ' ' + getSportTitle(sportKey);
    const text = `🤖 <b>Analyzing...</b>\n\n` +
                 `<b>Strategy:</b> ${escapeHTML(numLegs)}-Leg Parlay\n` +
                 `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                 `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n\n` +
                 `<i>Please wait...</i>`;
    await safeEditMessage(bot, chatId, messageId, text, { parse_mode: 'HTML' });
    try {
        const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, {});
        await sendParlayResult(bot, chatId, parlay, state, messageId);
    } catch (error) {
        console.error('❌ AI handler execution error:', error.message);
        if (error.fallbackAvailable) {
            await sendFallbackOptions(bot, chatId, messageId, error);
        } else {
            const errorMessage = `❌ Critical error: <code>${escapeHTML(error.message)}</code>`;
            await safeEditMessage(bot, chatId, messageId, errorMessage, { parse_mode: 'HTML' });
        }
    }
}

async function sendParlayResult(bot, chatId, parlay, state, messageId) {
    const { sportKey } = state;
    const { legs, parlay_price_american, quantitative_analysis } = parlay;
    const sportTitle = getSportTitle(sportKey);
    let response = `🧠 <b>AI-Generated Parlay</b>\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n\n`;
    legs.forEach((leg, index) => {
        const game = escapeHTML(leg.event || leg.game);
        const pick = escapeHTML(leg.selection || leg.pick);
        const odds = leg.price_american > 0 ? `+${leg.price_american}` : leg.price_american;
        response += `<b>Leg ${index + 1}: ${game}</b>\n`;
        response += `  <b>Pick:</b> ${pick} (${escapeHTML(odds)})\n\n`;
    });
    response += `<b>Total Odds:</b> ${parlay_price_american > 0 ? '+' : ''}${escapeHTML(parlay_price_american)}\n`;
    if (quantitative_analysis) {
        const { calibrated, riskAssessment } = quantitative_analysis;
        response += `<b>Calibrated EV:</b> ${escapeHTML(calibrated.evPercentage.toFixed(1))}% ${calibrated.evPercentage > 0 ? '👍' : '👎'}\n`;
        response += `<b>Win Probability:</b> ${escapeHTML((calibrated.jointProbability * 100).toFixed(1))}%\n`;
        response += `<b>Risk Level:</b> ${escapeHTML(riskAssessment.overallRisk)}\n`;
    }
    const finalKeyboard = [[{ text: '🔄 Build Another', callback_data: 'ai_back_sport' }]];
    await safeEditMessage(bot, chatId, messageId, response, { 
        parse_mode: 'HTML', 
        reply_markup: { inline_keyboard: finalKeyboard } 
    });
    await setUserState(chatId, {});
}

async function sendFallbackOptions(bot, chatId, messageId, error) {
    const text = `❌ <b>Web Research Failed</b>\n\n` +
                 `<b>Error:</b> ${escapeHTML(error.message)}\n\n` +
                 `Choose a fallback option:`;
    const keyboard = [
      [{ text: '🔴 Use Live Mode', callback_data: 'ai_fallback_live' }],
      [{ text: '💾 Use Database Mode', callback_data: 'ai_fallback_db' }],
      [{ text: '🔄 Try Different Sport', callback_data: 'ai_back_sport' }]
    ];
    await safeEditMessage(bot, chatId, messageId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    });
}
