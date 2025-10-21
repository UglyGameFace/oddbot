// src/bot/handlers/ai.js - FULLY RESTORED INTERACTIVE PARLAY BUILDER (v3 - Corrected Imports)

import quantumAIService from '../../services/aiService.js';
import * as sportsSvc from '../../services/sportsService.js'; // Use your sports service
import gamesService from '../../services/gamesService.js'; // Needed for renderOrRetry
import { sentryService } from '../../services/sentryService.js';
// ** FIX 1: Import specific state functions, not the manager itself **
import { setState, getState, getParlaySlip, setParlaySlip, getAIConfig } from '../state.js';
// Assuming the formatter is in enterpriseUtilities based on previous context
import { formatParlayText as originalFormatParlayText } from '../../utils/enterpriseUtilities.js';

// --- UTILITIES ---

const escapeHTML = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Use function directly from imported sportsService
const getSportTitle = sportsSvc.getSportTitle;

async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    const opts = { ...options, reply_markup: options.reply_markup || {} };
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } catch (err) {
    const msg = err?.response?.body?.description || err?.message || String(err);
    if (msg.includes('message is not modified')) return null;
    if (msg.includes('message to edit not found')) {
      console.warn(`Original message ${messageId} not found, sending new message.`);
      return await bot.sendMessage(chatId, text, options);
    }
    console.error(`safeEditMessage failed: ${msg}`, err);
    throw err;
  }
}

// Ensure the original formatter is available or use a fallback
const formatParlayText = originalFormatParlayText || function(parlay, sportKey) {
    const lines = [`🎯 <b>${getSportTitle(sportKey)} Parlay</b> (${parlay.legs?.length || 0} legs)`];
    if (parlay.parlay_price_american) lines.push(`📈 Price: ${parlay.parlay_price_american > 0 ? '+' : ''}${parlay.parlay_price_american}`);
    (parlay.legs || []).forEach((leg, i) => {
        lines.push(`${i+1}) ${escapeHTML(leg.event || 'N/A')}: ${escapeHTML(leg.selection)} (${leg.odds?.american || 'N/A'})`);
    });
     if (parlay.portfolio_construction?.overall_thesis) {
        lines.push(`\n📚 ${escapeHTML(parlay.portfolio_construction.overall_thesis)}`);
     }
     if (parlay.research_metadata?.generation_strategy) {
        lines.push(`\n🧭 Strategy: ${escapeHTML(parlay.research_metadata.generation_strategy)}`);
     }
    return lines.join('\n');
};


// --- MENU RENDERING FUNCTIONS ---

const ITEMS_PER_PAGE = 10; // 5 rows of 2 buttons

/**
 * Sends the paginated sports selection menu.
 */
async function sendAiSportSelectionMenu(bot, chatId, messageId = null, page = 0) {
  // ** FIX 2: Use getAllSports instead of getSupportedSports **
  const allSports = sportsSvc.sortSports(await sportsSvc.getAllSports()); // Fetch and sort
  if (!allSports || allSports.length === 0) {
    const errorText = '❌ No sports available currently. Please check data sources or try again later.';
    if (messageId) return safeEditMessage(bot, chatId, messageId, errorText, { reply_markup: {} });
    return bot.sendMessage(chatId, errorText);
  }

  const totalPages = Math.ceil(allSports.length / ITEMS_PER_PAGE);
  page = Math.max(0, Math.min(page, totalPages - 1));

  const start = page * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const sportsOnPage = allSports.slice(start, end);

  const keyboard = [];
  for (let i = 0; i < sportsOnPage.length; i += 2) {
    const row = [];
    const sport1 = sportsOnPage[i];
    // Use sport_key from the normalized sport object
    row.push({
      text: `${sportsSvc.getSportEmoji(sport1.key)} ${sport1.sport_title}`,
      callback_data: `ai_step_sport_${sport1.key}` // Use key here
    });
    if (sportsOnPage[i + 1]) {
      const sport2 = sportsOnPage[i + 1];
      row.push({
        text: `${sportsSvc.getSportEmoji(sport2.key)} ${sport2.sport_title}`,
        callback_data: `ai_step_sport_${sport2.key}` // Use key here
      });
    }
    keyboard.push(row);
  }

  const paginationRow = [];
  if (page > 0) {
    paginationRow.push({ text: '‹ Prev', callback_data: `ai_page_sport_${page - 1}` });
  }
  paginationRow.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: 'ai_noop' });
  if (end < allSports.length) {
    paginationRow.push({ text: 'Next ›', callback_data: `ai_page_sport_${page + 1}` });
  }
  if (paginationRow.length > 0) {
    keyboard.push(paginationRow);
  }
  keyboard.push([{ text: '❌ Cancel', callback_data: 'ai_cancel' }]);

  const text = '🤖 <b>AI Parlay Builder</b>\n\nStep 1: Select a sport.';
  const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  // Update state for pagination tracking
  await setState(chatId, { current_step: 'ai_sport', currentPage: page });

  if (messageId) {
    await safeEditMessage(bot, chatId, messageId, text, options);
  } else {
    // Clear any previous slip message when starting fresh
    const slip = await getParlaySlip(chatId);
    if (slip?.messageId) {
        await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
        await setParlaySlip(chatId, { ...slip, messageId: null});
    }
    await bot.sendMessage(chatId, text, options);
  }
}

/**
 * Sends the leg selection menu.
 */
async function sendAiLegSelectionMenu(bot, chatId, messageId, sportKey) {
  const sportTitle = getSportTitle(sportKey);
  const text = `Selected: <b>${escapeHTML(sportTitle)}</b>\n\nStep 2: How many legs for your parlay?`;
  const keyboard = [
    [{ text: '2 Legs', callback_data: 'ai_step_legs_2' }, { text: '3 Legs', callback_data: 'ai_step_legs_3' }],
    [{ text: '4 Legs', callback_data: 'ai_step_legs_4' }, { text: '5 Legs', callback_data: 'ai_step_legs_5' }],
    [{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]
  ];

  await setState(chatId, { current_step: 'ai_legs', sportKey }); // Keep sportKey in state
  await safeEditMessage(bot, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
}

// --- PARLAY GENERATION AND DISPLAY ---

/**
 * Triggers AI generation and displays result using renderOrRetry.
 */
async function triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs) {
  const sportTitle = getSportTitle(sportKey);
  await safeEditMessage(bot, chatId, messageId, `🔎 Building a ${numLegs}-leg ${escapeHTML(sportTitle)} parlay...\n\n_AI analysis in progress (up to 60s)_`, {
    parse_mode: 'HTML',
    reply_markup: {}
  });

  let userStateForRender = {}; // Define state for renderOrRetry

  try {
    const userAiConfig = await getAIConfig(chatId);
    userStateForRender = { // Populate state for renderOrRetry
        sportKey,
        numLegs,
        horizonHours: userAiConfig.horizonHours || 72,
        gameContext: null, // Placeholder, add game selection later if needed
        proQuantMode: userAiConfig.proQuantMode || false
    };

    console.log(`Generating parlay with config:`, userStateForRender);

    const parlay = await quantumAIService.generateParlay(
      sportKey,
      numLegs,
      userAiConfig.mode || 'web',
      'sonar-pro',
      userAiConfig.betType || 'mixed',
      { chatId, horizonHours: userStateForRender.horizonHours, gameContext: userStateForRender.gameContext, proQuantMode: userStateForRender.proQuantMode }
    );

    // Call renderOrRetry with the generated parlay and the state used
    await renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, userStateForRender);

  } catch (error) {
    sentryService.captureError(error, { extra: { chatId, sportKey, numLegs, stage: 'triggerParlayGeneration' } });
    const errorMessage = `❌ AI generation failed: ${escapeHTML(error.message || 'Unknown Error')}`;
    await safeEditMessage(bot, chatId, messageId, errorMessage, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}_${numLegs}` }],
          [{ text: '« Change Legs', callback_data: `ai_back_legs_${sportKey}` }],
          [{ text: '« Change Sport', callback_data: 'ai_back_sport' }]
        ]
      }
    });
  } finally {
      // Clear intermediate state after completion or failure
      // Ensure state exists before clearing specific keys
       const finalState = await getState(chatId) || {};
       delete finalState.current_step;
       delete finalState.sportKey;
       delete finalState.numLegs;
       // Keep currentPage for potential back navigation
       await setState(chatId, finalState);
  }
}

// Gate AI legs to verified events before rendering (Copied from previous version)
async function gateLegsToVerified(legs, sportKey, horizonHours, gameContext) {
  const verified = await gamesService.getVerifiedRealGames(sportKey, horizonHours || 72);
  if (!Array.isArray(verified) || verified.length === 0) {
      console.warn(`No verified games found for ${sportKey} to gate parlay legs.`);
      return [];
  }

  // Ensure IDs are strings or numbers before adding to Set
  const idSet = new Set(verified.map(g => g.event_id ?? g.id).filter(id => typeof id === 'string' || typeof id === 'number'));
  const nameSet = new Set(verified.map(g => `${g.away_team} @ ${g.home_team}`.toLowerCase()));

  const filtered = (legs || []).filter((l) => {
    // Check game_id (must be string or number to match Set)
    if ((typeof l.game_id === 'string' || typeof l.game_id === 'number') && idSet.has(l.game_id)) return true;
    // Check event name
    if (l.event && typeof l.event === 'string' && nameSet.has(l.event.toLowerCase())) return true;
    // Allow if specific game context provided
    if (gameContext && typeof l.selection === 'string') return true;

    console.warn(`Leg filtered out (no match): ${l.event || 'No event'} - ${l.selection}`);
    return false;
  });

  if (gameContext) {
    for (const leg of filtered) {
      if (!leg.event) leg.event = `${gameContext.away_team} @ ${gameContext.home_team}`;
      if (!leg.commence_time) leg.commence_time = gameContext.commence_time;
       // Attempt to add game_id if missing
       if (!leg.game_id && (gameContext.event_id || gameContext.id)) {
           leg.game_id = gameContext.event_id || gameContext.id;
       }
    }
  }
  return filtered;
}


// Render or fail closed with a retry CTA (Copied from previous version)
async function renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state) {
  const { horizonHours, gameContext } = state || {}; // Ensure state exists

  // Ensure parlay is an object and has legs
   if (typeof parlay !== 'object' || parlay === null) {
        parlay = { legs: [] }; // Default to empty legs if parlay is invalid
        console.error("renderOrRetry received invalid 'parlay' object:", parlay);
   }
   if (!Array.isArray(parlay.legs)) {
        parlay.legs = []; // Ensure legs is always an array
        console.warn("renderOrRetry received parlay with non-array 'legs':", parlay);
   }


  const gatedLegs = await gateLegsToVerified(parlay.legs, sportKey, horizonHours, gameContext);

  if (!Array.isArray(gatedLegs) || gatedLegs.length < numLegs) {
    const errorText = `❌ Could not generate enough valid & verified legs (${gatedLegs?.length || 0}/${numLegs}) for ${escapeHTML(getSportTitle(sportKey))}. Common issues: No upcoming games, AI errors, or strict validation.`;
    await safeEditMessage(bot, chatId, messageId, errorText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}_${numLegs}` }],
          [{ text: '« Change Legs', callback_data: `ai_back_legs_${sportKey}` }],
          [{ text: '« Change Sport', callback_data: 'ai_back_sport' }]
        ]
      }
    });
    return;
  }

  const finalParlay = { ...parlay, legs: gatedLegs };
  // Use the formatter function (either original or fallback)
  const text = formatParlayText(finalParlay, sportKey);

  await safeEditMessage(bot, chatId, messageId, text, {
      parse_mode: 'HTML', // Formatter uses HTML
      reply_markup: {
          inline_keyboard: [
              [{ text: '✨ Start New AI Parlay', callback_data: 'ai_start_new' }],
              [{ text: '🔄 Retry Same Settings', callback_data: `ai_retry_${sportKey}_${numLegs}` }]
          ]
      }
  });
}

// --- BOT HANDLER REGISTRATION ---

/**
 * Registers the main /ai command.
 */
export function registerAI(bot) {
  bot.onText(/\/(ai|parlay)/, async (msg) => {
    const chatId = msg.chat.id;
    await sendAiSportSelectionMenu(bot, chatId); // Start interactive flow
  });
}

/**
 * Registers all callbacks for the interactive AI menu.
 */
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cq) => {
    const { data, message } = cq;
    // Basic validation first
    if (!data || !message || typeof data !== 'string' || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
        await bot.answerCallbackQuery(cq.id); // Acknowledge early

        // --- Cancel Button ---
        if (data === 'ai_cancel') {
            await setState(chatId, {}); // Clear state is crucial
            await safeEditMessage(bot, chatId, messageId, 'AI Parlay Builder cancelled.', { reply_markup: {} });
            return;
        }

        // --- Start New Button ---
        if (data === 'ai_start_new') {
            await sendAiSportSelectionMenu(bot, chatId, messageId, 0);
            return;
        }

        // --- Pagination ---
        if (data.startsWith('ai_page_sport_')) {
            const page = parseInt(data.substring('ai_page_sport_'.length), 10);
            if (!isNaN(page)) {
                await sendAiSportSelectionMenu(bot, chatId, messageId, page);
            }
            return;
        }

        // --- Step 1: Sport Selection ---
        if (data.startsWith('ai_step_sport_')) {
            const sportKey = data.substring('ai_step_sport_'.length);
            // Verify sportKey looks reasonable before proceeding
            if (sportKey && sportKey.length > 2 && sportKey.length < 50) {
                 await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
            } else {
                 console.warn(`Invalid sportKey from callback: ${sportKey}`);
                 await safeEditMessage(bot, chatId, messageId, "❌ Invalid sport selection. Please try again.", { reply_markup: {} });
            }
            return;
        }

        // --- Step 2: Leg Selection ---
        if (data.startsWith('ai_step_legs_')) {
            const numLegs = parseInt(data.substring('ai_step_legs_'.length), 10);
            const userState = await getState(chatId);

            // Check if state is valid for this step
            if (userState && userState.sportKey && userState.current_step === 'ai_legs' && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                await setState(chatId, { ...userState, numLegs, current_step: 'ai_generate' });
                await triggerParlayGeneration(bot, chatId, messageId, userState.sportKey, numLegs);
            } else {
                console.warn("State mismatch or invalid numLegs during leg selection", { userState, numLegs, data });
                await safeEditMessage(bot, chatId, messageId, "❌ Session error or invalid input. Please start again with /ai.", { reply_markup: {} });
                await setState(chatId, {}); // Clear potentially corrupt state
            }
            return;
        }

        // --- Back Buttons ---
        if (data === 'ai_back_sport') {
            const userState = await getState(chatId);
            await sendAiSportSelectionMenu(bot, chatId, messageId, userState?.currentPage || 0);
            return;
        }
        if (data.startsWith('ai_back_legs_')) {
             const sportKey = data.substring('ai_back_legs_'.length);
             if (sportKey) { // Ensure sportKey is present
                await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
             } else {
                console.warn("Back to legs called without sportKey");
                await sendAiSportSelectionMenu(bot, chatId, messageId, 0); // Fallback to sports menu
             }
             return;
        }

        // --- Retry Logic ---
        if (data.startsWith('ai_retry_')) {
            const parts = data.split('_');
            // Expecting ai_retry_SPORTKEY_NUMLEGS (4 parts)
            if (parts.length === 4) {
                const sportKey = parts[2];
                const numLegs = parseInt(parts[3], 10);
                // Validate extracted data before retrying
                if (sportKey && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                    await triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs);
                } else {
                     console.warn("Invalid retry data:", { sportKey, numLegs });
                     await safeEditMessage(bot, chatId, messageId, "❌ Invalid retry data. Please start again.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_start_new' }]] } });
                }
            } else {
                 console.warn("Malformed retry callback data:", data);
                 await safeEditMessage(bot, chatId, messageId, "❌ Error processing retry. Please start again.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_start_new' }]] } });
            }
            return;
        }

        // --- No-op for pagination display ---
        if (data === 'ai_noop') {
            return; // Just acknowledge
        }

        // --- Fallback ---
        console.warn(`Unhandled AI callback: ${data}`);
        // Optionally notify user about unrecognized action
        // await safeEditMessage(bot, chatId, messageId, "Unknown action.", {});

    } catch (error) {
        console.error(`Callback Error (${data}):`, error);
        sentryService.captureError(error, { extra: { callbackData: data, chatId, messageId, stage: 'callback_handler_main' } });
        try {
            await safeEditMessage(bot, chatId, messageId, "❌ An unexpected error occurred handling your request. Please try starting over.", {
                 reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] }
            });
        } catch (editError) {
             console.error(`Failed to send error message back to user after callback failure:`, editError);
        } finally {
             // Attempt to clear state in case of error to prevent broken flows
             await setState(chatId, {}).catch(clearErr => console.error("Failed to clear state after error:", clearErr));
        }
    }
  });
}

// Ensure default export includes both registration functions
export default {
  registerAI,
  registerAICallbacks,
};
