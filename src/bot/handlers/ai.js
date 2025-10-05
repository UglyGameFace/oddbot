// src/bot/handlers/ai.js - COMPLETELY FIXED
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState, getAIConfig } from '../state.js';
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../bot.js';

// Helper to escape text for Telegram's HTML parse mode
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
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// --- Helper Functions ---
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
    console.log(`🎉 Sports cache refreshed: ${sportsCache.length} sports found`);
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    return sportsCache || []; // Return stale cache on error
  }
}

// --- Command Registration ---
export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /ai command received from ${chatId}`);
    try {
      await setUserState(chatId, { page: 0 });
      await sendSportSelection(bot, chatId);
    } catch (error) {
      console.error('❌ Error in /ai command:', error);
      bot.sendMessage(chatId, '❌ Failed to start AI Parlay Builder. Please try again.');
    }
  });
}

// --- Callback Handler ---
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    
    console.log(`🔄 AI callback: ${data} from ${chatId}`);

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
        return sendQuantitativeModeSelection(bot, chatId, messageId);
      }
      if (action === 'quantitative') {
        state.quantitativeMode = parts[2];
        await setUserState(chatId, state);
        return executeAiRequest(bot, chatId, messageId);
      }
      if (action === 'fallback') {
        const selectedMode = parts[2];
        const { sportKey, numLegs, betType = 'mixed' } = state;
        if (!sportKey || !numLegs) return;
        
        try {
          await safeEditMessage(chatId, messageId, `🔄 Switching to <b>${escapeHTML(selectedMode.toUpperCase())}</b> mode...`, { parse_mode: 'HTML' });
          const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, selectedMode, betType);
          await sendParlayResult(bot, chatId, parlay, state, selectedMode, messageId);
        } catch (error) {
          await safeEditMessage(chatId, messageId, `❌ Fallback failed: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
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
        if (to === 'model') return sendAiModelSelection(bot, chatId, messageId);
      }
      if (action === 'quick' && parts[2] === 'retry') {
        await safeEditMessage(chatId, messageId, '🔄 Retrying with same parameters...', { parse_mode: 'HTML' });
        return executeAiRequest(bot, chatId, messageId);
      }
    } catch (error) {
      console.error('❌ Error in AI callback handler:', error);
      await safeEditMessage(chatId, messageId, `❌ Error: ${escapeHTML(error.message)}`, { parse_mode: 'HTML' });
    }
  });
}

// --- UI Message Functions ---

async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
    try {
        const sports = await getCachedSports();
        if (!sports || sports.length === 0) {
            const text = '⚠️ No sports available right now. Data sources may be temporarily down. Please try again later.';
            if (messageId) return safeEditMessage(chatId, messageId, text);
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
            await safeEditMessage(chatId, messageId, text, opts);
        } else {
            await bot.sendMessage(chatId, text, opts);
        }
    } catch (error) {
        console.error('❌ Error sending sport selection:', error);
        const errorText = '❌ Failed to load sports. Please try again.';
        if (messageId) {
            await safeEditMessage(chatId, messageId, errorText);
        } else {
            await bot.sendMessage(chatId, errorText);
        }
    }
}

async function sendLegSelection(bot, chatId, messageId) {
  try {
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
    await safeEditMessage(chatId, messageId, text, opts);
  } catch (error) {
    console.error('❌ Error sending leg selection:', error);
    await safeEditMessage(chatId, messageId, '❌ Error loading leg selection. Please try again.');
  }
}

async function sendModeSelection(bot, chatId, messageId) {
  try {
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 3:</b> Select analysis mode.`;
    const keyboard = [
      [{ text: '🌐 Web Research (Recommended)', callback_data: 'ai_mode_web'}],
      [{ text: '📡 Live API Data (Fastest)', callback_data: 'ai_mode_live'}],
      [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db'}],
      [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
  } catch (error) {
    console.error('❌ Error sending mode selection:', error);
    await safeEditMessage(chatId, messageId, '❌ Error loading mode selection. Please try again.');
  }
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  try {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 4:</b> What kind of parlay?';
    const keyboard = [
      [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props'}],
      [{ text: '🎯 Moneyline Focus', callback_data: 'ai_bettype_moneyline'}],
      [{ text: '📊 Spreads & Totals', callback_data: 'ai_bettype_spreads'}],
      [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed'}],
      [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
  } catch (error) {
    console.error('❌ Error sending bet type selection:', error);
    await safeEditMessage(chatId, messageId, '❌ Error loading bet type selection. Please try again.');
  }
}

async function sendAiModelSelection(bot, chatId, messageId) {
  try {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 5:</b> Choose Research AI.';
    const keyboard = [
      [{ text: '🧠 Gemini (Creative)', callback_data: 'ai_model_gemini'}],
      [{ text: '⚡️ Perplexity (Data-Focused)', callback_data: 'ai_model_perplexity'}],
      [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
  } catch (error) {
    console.error('❌ Error sending AI model selection:', error);
    await safeEditMessage(chatId, messageId, '❌ Error loading AI model selection. Please try again.');
  }
}

async function sendQuantitativeModeSelection(bot, chatId, messageId) {
    try {
        const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 6:</b> Select Analysis Mode';
        const keyboard = [
          [{ text: '🔬 Conservative (Recommended)', callback_data: 'ai_quantitative_conservative' }],
          [{ text: '🚀 Aggressive (High Risk)', callback_data: 'ai_quantitative_aggressive' }],
          [{ text: '« Back to AI Model', callback_data: 'ai_back_model' }]
        ];
        const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
        await safeEditMessage(chatId, messageId, text, opts);
    } catch (error) {
        console.error('❌ Error sending quantitative mode selection:', error);
        await safeEditMessage(chatId, messageId, '❌ Error loading quantitative mode selection. Please try again.');
    }
}

async function sendFallbackOptions(bot, chatId, messageId, error) {
  try {
    const text = `❌ <b>Web Research Failed</b>\n\n` +
                 `<b>Error:</b> ${escapeHTML(error.message)}\n\n` +
                 `Choose a fallback option:`;
    const keyboard = [
      [{ text: '🔴 Use Live Mode', callback_data: 'ai_fallback_live' }],
      [{ text: '💾 Use Database Mode', callback_data: 'ai_fallback_db' }],
      [{ text: '🔄 Try Different Sport', callback_data: 'ai_back_sport' }]
    ];
    await safeEditMessage(chatId, messageId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    });
  } catch (fallbackError) {
    console.error('❌ Error sending fallback options:', fallbackError);
  }
}

async function sendScheduleValidationError(bot, chatId, messageId, error) {
    try {
        const text = `❌ <b>Schedule Validation Failed</b>\n\n` +
                     `The AI proposed games that do not exist in the official schedule. This is a safeguard against errors.\n\n` +
                     `<i>Error: ${escapeHTML(error.message)}</i>`;
        const keyboard = [
            [{ text: '🔴 Use Live Mode (Verified)', callback_data: 'ai_fallback_live' }],
            [{ text: '🔄 Try Again', callback_data: 'ai_quick_retry' }],
            [{ text: '🎯 Change Sport', callback_data: 'ai_back_sport' }]
        ];
        await safeEditMessage(chatId, messageId, text, {
            parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
        });
    } catch (validationError) {
        console.error('❌ Error sending schedule validation error:', validationError);
    }
}

// --- AI Request Execution & Result Formatting ---
async function executeAiRequest(bot, chatId, messageId) {
    try {
        const state = await getUserState(chatId);
        const { sportKey, numLegs, mode, betType, aiModel, includeProps, quantitativeMode } = state || {};

        if (!sportKey || !numLegs || !mode || !betType) {
            return safeEditMessage(chatId, messageId, '❌ Incomplete selection. Please start over using /ai.');
        }
        
        const sportTitle = getSportEmoji(sportKey) + ' ' + getSportTitle(sportKey);
        const text = `🤖 <b>Analyzing...</b>\n\n` +
                     `<b>Strategy:</b> ${escapeHTML(numLegs)}-Leg Parlay\n` +
                     `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                     `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n\n` +
                     `<i>Validating against real schedules and running quantitative checks. Please wait...</i>`;
        await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML' });

        const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, {
            includeProps,
            quantitativeMode,
            horizonHours: 72
        });
        
        await sendParlayResult(bot, chatId, parlay, state, mode, messageId);
    } catch (error) {
        console.error('❌ AI handler execution error:', error.message);
        if (error.fallbackAvailable) {
            await sendFallbackOptions(bot, chatId, messageId, error);
        } else if (error.message.includes('SCHEDULE')) {
            await sendScheduleValidationError(bot, chatId, messageId, error);
        } else {
            const errorMessage = `❌ Critical error: <code>${escapeHTML(error.message)}</code>`;
            await safeEditMessage(chatId, messageId, errorMessage, { parse_mode: 'HTML' });
        }
    }
}

async function sendParlayResult(bot, chatId, parlay, state, mode, messageId) {
    try {
        const { sportKey } = state;
        const { legs, parlay_price_american, quantitative_analysis, research_metadata } = parlay;
        const sportTitle = getSportTitle(sportKey);
        
        let response = `🧠 <b>AI-Generated Parlay</b>\n`;
        response += `<b>Sport:</b> ${escapeHTML(sportTitle)}\n`;
        if (research_metadata?.real_games_validated) {
            response += `✅ <b>Verified Real Games</b>\n`;
        }
        response += `\n`;

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
        await safeEditMessage(chatId, messageId, response, { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: finalKeyboard } 
        });
        
        // Clear state after successful parlay generation
        await setUserState(chatId, {});
    } catch (error) {
        console.error('❌ Error sending parlay result:', error);
        await safeEditMessage(chatId, messageId, '❌ Error displaying parlay result. Please try again.');
    }
}
