 the new function here
};
// src/bot/handlers/ai.js - FULLY RESTORED INTERACTIVE PARLAY BUILDER (v2)

import quantumAIService from '../../services/aiService.js';
import * as sportsSvc from '../../services/sportsService.js'; // Use your sports service
import gamesService from '../../services/gamesService.js'; // Needed for renderOrRetry
import { sentryService } from '../../services/sentryService.js';
import { stateManager } from '../state.js'; // Use your state manager
import { getAIConfig } from '../state.js'; // Get user's AI settings
import { formatParlayText as originalFormatParlayText } from '../../utils/enterpriseUtilities.js'; // Assuming formatter is here now

// --- UTILITIES ---

const escapeHTML = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const getSportTitle = sportsSvc.getSportTitle; // Use function from sportsService

async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    // Ensure reply_markup is always an object, even if empty
    const opts = { ...options, reply_markup: options.reply_markup || {} };
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } catch (err) {
    const msg = err?.response?.body?.description || err?.message || String(err);
    if (msg.includes('message is not modified')) return null; // Ignore "not modified"
    if (msg.includes('message to edit not found')) { // If original message deleted, send new one
      console.warn(`Original message ${messageId} not found, sending new message.`);
      return await bot.sendMessage(chatId, text, options);
    }
    console.error(`safeEditMessage failed: ${msg}`, err); // Log other errors
    throw err; // Re-throw for upstream handling
  }
}

// Ensure the original formatter is available
const formatParlayText = originalFormatParlayText || function(parlay, sportKey) {
    // Basic fallback formatter if the enterprise one isn't found
    const lines = [`🎯 ${getSportTitle(sportKey)} Parlay (${parlay.legs?.length || 0} legs)`];
    if (parlay.parlay_price_american) lines.push(`📈 Price: ${parlay.parlay_price_american > 0 ? '+' : ''}${parlay.parlay_price_american}`);
    (parlay.legs || []).forEach((leg, i) => {
        lines.push(`${i+1}) ${leg.event || 'N/A'}: ${leg.selection} (${leg.odds?.american || 'N/A'})`);
    });
    return lines.join('\n');
};


// --- MENU RENDERING FUNCTIONS ---

const ITEMS_PER_PAGE = 10; // 5 rows of 2 buttons

/**
 * Sends the paginated sports selection menu.
 */
async function sendAiSportSelectionMenu(bot, chatId, messageId = null, page = 0) {
  // Fetch and sort sports dynamically
  const allSports = sportsSvc.sortSports(await sportsSvc.getAllSports());
  if (!allSports || allSports.length === 0) {
    const errorText = '❌ No sports available currently. Please try again later.';
    if (messageId) return safeEditMessage(bot, chatId, messageId, errorText, { reply_markup: {} });
    return bot.sendMessage(chatId, errorText);
  }

  const totalPages = Math.ceil(allSports.length / ITEMS_PER_PAGE);
  page = Math.max(0, Math.min(page, totalPages - 1)); // Clamp page number

  const start = page * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const sportsOnPage = allSports.slice(start, end);

  const keyboard = [];
  for (let i = 0; i < sportsOnPage.length; i += 2) {
    const row = [];
    const sport1 = sportsOnPage[i];
    row.push({
      text: `${sportsSvc.getSportEmoji(sport1.key)} ${sport1.sport_title}`,
      callback_data: `ai_step_sport_${sport1.key}`
    });
    if (sportsOnPage[i + 1]) {
      const sport2 = sportsOnPage[i + 1];
      row.push({
        text: `${sportsSvc.getSportEmoji(sport2.key)} ${sport2.sport_title}`,
        callback_data: `ai_step_sport_${sport2.key}`
      });
    }
    keyboard.push(row);
  }

  // Pagination Controls
  const paginationRow = [];
  if (page > 0) {
    paginationRow.push({ text: '‹ Prev', callback_data: `ai_page_sport_${page - 1}` });
  }
  paginationRow.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: 'ai_noop' }); // No-op button
  if (end < allSports.length) {
    paginationRow.push({ text: 'Next ›', callback_data: `ai_page_sport_${page + 1}` });
  }
  if (paginationRow.length > 0) {
    keyboard.push(paginationRow);
  }

  // Add a cancel button
   keyboard.push([{ text: '❌ Cancel', callback_data: 'ai_cancel' }]);

  const text = '🤖 **AI Parlay Builder**\n\nStep 1: Select a sport.';
  const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

  // Update state for pagination
  await stateManager.setState(chatId, { current_step: 'ai_sport', currentPage: page });

  if (messageId) {
    await safeEditMessage(bot, chatId, messageId, text, options);
  } else {
    // If starting fresh, clear any old parlay slip message ID
    const slip = await stateManager.getParlaySlip(chatId);
    if (slip?.messageId) {
        await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
        await stateManager.setParlaySlip(chatId, { ...slip, messageId: null});
    }
    await bot.sendMessage(chatId, text, options);
  }
}

/**
 * Sends the leg selection menu.
 */
async function sendAiLegSelectionMenu(bot, chatId, messageId, sportKey) {
  const sportTitle = getSportTitle(sportKey);
  const text = `Selected: **${escapeHTML(sportTitle)}**\n\nStep 2: How many legs for your parlay?`;
  const keyboard = [
    // Common leg counts
    [
      { text: '2 Legs', callback_data: 'ai_step_legs_2' },
      { text: '3 Legs', callback_data: 'ai_step_legs_3' },
    ],
    [
      { text: '4 Legs', callback_data: 'ai_step_legs_4' },
      { text: '5 Legs', callback_data: 'ai_step_legs_5' },
    ],
    // Back button
    [{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]
  ];

  await stateManager.setState(chatId, { current_step: 'ai_legs', sportKey }); // Update state
  await safeEditMessage(bot, chatId, messageId, text, {
    parse_mode: 'HTML', // Use HTML for bold
    reply_markup: { inline_keyboard: keyboard },
  });
}

// --- PARLAY GENERATION AND DISPLAY ---

/**
 * Triggers the AI parlay generation and displays the result.
 */
async function triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs) {
  const sportTitle = getSportTitle(sportKey);
  await safeEditMessage(bot, chatId, messageId, `🔎 Building a ${numLegs}-leg ${escapeHTML(sportTitle)} parlay...\n\n_This may take up to 60 seconds._`, {
    parse_mode: 'HTML',
    reply_markup: {} // Clear buttons while generating
  });

  try {
    // Retrieve user's AI settings for mode, betType, horizon, and quant mode
    const userAiConfig = await getAIConfig(chatId);
    const state = { // Pass state to renderOrRetry
        sportKey,
        numLegs,
        horizonHours: userAiConfig.horizonHours || 72,
        gameContext: null, // Add game context selection later if needed
        proQuantMode: userAiConfig.proQuantMode || false // Respect the quant setting
    };

    console.log(`Generating parlay with config:`, state);

    const parlay = await quantumAIService.generateParlay(
      sportKey,
      numLegs,
      userAiConfig.mode || 'web',
      'sonar-pro', // Model is usually fixed
      userAiConfig.betType || 'mixed',
      { // Pass necessary options to aiService
          chatId,
          horizonHours: state.horizonHours,
          gameContext: state.gameContext,
          // Include proQuantMode if aiService uses it
          proQuantMode: state.proQuantMode
      }
    );

    // Use the existing renderOrRetry function which handles validation and formatting
    await renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state);

  } catch (error) {
    sentryService.captureError(error, { extra: { chatId, sportKey, numLegs, stage: 'triggerParlayGeneration' } });
    const errorMessage = `❌ AI generation failed: ${escapeHTML(error.message)}`;
    await safeEditMessage(bot, chatId, messageId, errorMessage, {
      parse_mode: 'HTML',
      reply_markup: { // Provide retry and back options on failure
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}_${numLegs}` }],
          [{ text: '« Back to Legs', callback_data: `ai_back_legs_${sportKey}` }], // Go back to leg selection
          [{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]
        ]
      }
    });
  } finally {
      // Clear intermediate state after completion or failure
      await stateManager.setState(chatId, {});
  }
}

// Gate AI legs to verified events before rendering (Copied from previous version, seems useful)
async function gateLegsToVerified(legs, sportKey, horizonHours, gameContext) {
  const verified = await gamesService.getVerifiedRealGames(sportKey, horizonHours || 72);
  if (!Array.isArray(verified) || verified.length === 0) {
      console.warn(`No verified games found for ${sportKey} to gate parlay legs.`);
      return []; // Return empty if no verified games
  }

  const idSet = new Set(verified.map((g) => g.event_id ?? g.id).filter(Boolean));
  const nameSet = new Set(verified.map((g) => `${g.away_team} @ ${g.home_team}`.toLowerCase()));

  const filtered = (legs || []).filter((l) => {
    if (l.game_id && idSet.has(l.game_id)) return true;
    if (l.event && nameSet.has(l.event.toLowerCase())) return true;
    // Allow legs without specific game if a gameContext was provided (AI might fill it in)
    if (gameContext && typeof l.selection === 'string') return true;
    console.warn(`Leg filtered out (no match): ${l.event || 'No event'} - ${l.selection}`);
    return false;
  });

  // Normalize legs if gameContext exists
  if (gameContext) {
    for (const leg of filtered) {
      if (!leg.event) leg.event = `${gameContext.away_team} @ ${gameContext.home_team}`;
      if (!leg.commence_time) leg.commence_time = gameContext.commence_time;
      if (!leg.game_id) leg.game_id = gameContext.event_id || gameContext.id;
    }
  }
  return filtered;
}


// Render or fail closed with a retry CTA (Copied from previous version)
async function renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state) {
  const { horizonHours, gameContext } = state;
  const gatedLegs = await gateLegsToVerified(parlay?.legs || [], sportKey, horizonHours, gameContext);

  // Check if enough *valid* legs were generated AND verified
  if (!gatedLegs || gatedLegs.length < numLegs) {
    const errorText = `❌ Could not generate enough valid & verified legs (${gatedLegs?.length || 0}/${numLegs}) for ${escapeHTML(getSportTitle(sportKey))}. Common issues: No upcoming games, AI errors, or strict validation.`;
    await safeEditMessage(bot, chatId, messageId, errorText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [ // Use specific retry data
          [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}_${numLegs}` }],
          [{ text: '« Change Legs', callback_data: `ai_back_legs_${sportKey}` }], // Go back to leg selection
          [{ text: '« Change Sport', callback_data: 'ai_back_sport' }]
        ]
      }
    });
    return;
  }

  // Use the validated legs for the final parlay object
  const finalParlay = { ...parlay, legs: gatedLegs };
  const text = formatParlayText(finalParlay, sportKey); // Use the formatter

  await safeEditMessage(bot, chatId, messageId, text, {
      parse_mode: 'HTML', // Formatter uses HTML
      reply_markup: { // Add buttons to start over or retry
          inline_keyboard: [
              [{ text: '🔄 Generate New Parlay', callback_data: 'ai_start_new' }],
              [{ text: 'Retry Same Settings', callback_data: `ai_retry_${sportKey}_${numLegs}` }]
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
    // Start the flow by sending the sports menu
    await sendAiSportSelectionMenu(bot, chatId);
  });
}

/**
 * Registers all callbacks for the interactive AI menu.
 */
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cq) => {
    const { data, message } = cq;
    if (!data || !message || !data.startsWith('ai_')) return; // Only handle 'ai_' callbacks

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
        await bot.answerCallbackQuery(cq.id); // Acknowledge callback quickly

        // --- Cancel Button ---
        if (data === 'ai_cancel') {
            await stateManager.setState(chatId, {}); // Clear state
            await safeEditMessage(bot, chatId, messageId, 'AI Parlay Builder cancelled.', { reply_markup: {} });
            return;
        }

        // --- Start New Button ---
        if (data === 'ai_start_new') {
            await sendAiSportSelectionMenu(bot, chatId, messageId, 0); // Restart from page 0
            return;
        }

        // --- Pagination ---
        if (data.startsWith('ai_page_sport_')) {
            const page = parseInt(data.split('_')[3], 10);
            await sendAiSportSelectionMenu(bot, chatId, messageId, page);
            return;
        }

        // --- Step 1: Sport Selection ---
        if (data.startsWith('ai_step_sport_')) {
            const sportKey = data.substring('ai_step_sport_'.length);
            await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
            return;
        }

        // --- Step 2: Leg Selection ---
        if (data.startsWith('ai_step_legs_')) {
            const numLegs = parseInt(data.split('_')[3], 10);
            const userState = await stateManager.getState(chatId);
            if (userState && userState.sportKey && userState.current_step === 'ai_legs') {
                await stateManager.setState(chatId, { ...userState, numLegs, current_step: 'ai_generate' });
                // Now trigger the generation
                await triggerParlayGeneration(bot, chatId, messageId, userState.sportKey, numLegs);
            } else {
                // State mismatch, likely expired or user clicked old button
                await safeEditMessage(bot, chatId, messageId, "❌ Session error. Please start again with /ai.", { reply_markup: {} });
                await stateManager.setState(chatId, {}); // Clear state
            }
            return;
        }

        // --- Back Buttons ---
        if (data === 'ai_back_sport') {
            const userState = await stateManager.getState(chatId);
            await sendAiSportSelectionMenu(bot, chatId, messageId, userState?.currentPage || 0);
            return;
        }
        if (data.startsWith('ai_back_legs_')) {
             const sportKey = data.substring('ai_back_legs_'.length);
             await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
             return;
        }


        // --- Retry Logic ---
        if (data.startsWith('ai_retry_')) {
            const parts = data.split('_');
            if (parts.length === 4) { // Expecting ai_retry_SPORTKEY_NUMLEGS
                const sportKey = parts[2];
                const numLegs = parseInt(parts[3], 10);
                if (sportKey && !isNaN(numLegs)) {
                    await triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs);
                } else {
                     await safeEditMessage(bot, chatId, messageId, "❌ Invalid retry data. Please start again with /ai.", { reply_markup: {} });
                }
            } else {
                 await safeEditMessage(bot, chatId, messageId, "❌ Invalid retry data. Please start again with /ai.", { reply_markup: {} });
            }
            return;
        }

        // --- No-op for pagination display ---
        if (data === 'ai_noop') {
            return; // Do nothing, just acknowledge
        }

        // --- Fallback for unknown ai_ callbacks ---
        console.warn(`Unhandled AI callback data: ${data}`);
        // Optionally send a message or just ignore

    } catch (error) {
        console.error(`Callback Error (${data}):`, error);
        sentryService.captureError(error, { extra: { callbackData: data, chatId, messageId } });
        try {
            // Try to inform the user, but don't crash if this fails
            await safeEditMessage(bot, chatId, messageId, "❌ An unexpected error occurred. Please try again.", {
                 reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_start_new' }]] }
            });
        } catch (editError) {
             console.error(`Failed to send error message back to user:`, editError);
        }
    }
  });
}

// Export necessary functions
export default {
  registerAI,
  registerAICallbacks,
};
