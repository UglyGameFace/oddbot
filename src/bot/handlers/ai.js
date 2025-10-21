// src/bot/handlers/ai.js - FULLY RESTORED INTERACTIVE PARLAY BUILDER (v4 - Corrected State Imports)

import quantumAIService from '../../services/aiService.js';
import * as sportsSvc from '../../services/sportsService.js'; // Use your sports service
import gamesService from '../../services/gamesService.js'; // Needed for renderOrRetry
import { sentryService } from '../../services/sentryService.js';
// ** FIX: Import CORRECT state function names **
import { setUserState, getUserState, getParlaySlip, setParlaySlip, getAIConfig, clearUserState } from '../state.js';
// Assuming the formatter is in enterpriseUtilities based on previous context
import { formatParlayText as originalFormatParlayText } from '../../utils/enterpriseUtilities.js';

// --- UTILITIES ---

const escapeHTML = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Use function directly from imported sportsService
const getSportTitle = sportsSvc.getSportTitle;

async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    const opts = { ...options, reply_markup: options.reply_markup || {} };
    // Add disable_web_page_preview to prevent link previews unless explicitly wanted
    if (opts.disable_web_page_preview === undefined) {
        opts.disable_web_page_preview = true;
    }
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } catch (err) {
    const msg = err?.response?.body?.description || err?.message || String(err);
    if (msg.includes('message is not modified')) return null; // Ignore "not modified"
    if (msg.includes('message to edit not found')) { // If original message deleted, send new one
      console.warn(`Original message ${messageId} not found, sending new message.`);
      // Ensure options are passed to sendMessage as well
      const sendOpts = { ...options };
       if (sendOpts.disable_web_page_preview === undefined) {
           sendOpts.disable_web_page_preview = true;
       }
      return await bot.sendMessage(chatId, text, sendOpts);
    }
    console.error(`safeEditMessage failed: ${msg}`, err); // Log other errors
    throw err; // Re-throw for upstream handling
  }
}

// Ensure the original formatter is available or use a fallback
const formatParlayText = originalFormatParlayText || function(parlay, sportKey) {
    if (!parlay) return "Error: Parlay data is missing."; // Handle null/undefined parlay
    const legs = parlay.legs || [];
    const sportTitle = getSportTitle(sportKey);
    const lines = [`🎯 <b>${escapeHTML(sportTitle)} Parlay</b> (${legs.length} legs)`];

    const price = parlay.parlay_price_american;
    if (Number.isFinite(Number(price))) {
        lines.push(`📈 Price: ${price > 0 ? '+' : ''}${price}`);
    }
    if (parlay.validation?.qualityScore != null) {
       lines.push(`✅ Validation: ${Math.round(parlay.validation.qualityScore)}%`);
    }


    if (legs.length > 0) lines.push(''); // Add space before legs

    legs.forEach((leg, i) => {
        const priceLeg = leg?.odds?.american;
        const priceStr = Number.isFinite(Number(priceLeg)) ? (priceLeg > 0 ? `+${priceLeg}` : `${priceLeg}`) : 'N/A';
        const market = leg?.market || 'N/A';
        const selection = leg?.selection || 'N/A';
        const event = leg?.event || 'Unknown Event';
        // Basic HTML escaping for leg details
        lines.push(
          `${i + 1}) ${escapeHTML(event)}\n   • ${escapeHTML(market)} — ${escapeHTML(selection)} (${priceStr})`
        );
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
  const allSports = sportsSvc.sortSports(await sportsSvc.getAllSports());
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

  // Update state with current step and page
  await setUserState(chatId, { current_step: 'ai_sport', currentPage: page });

  if (messageId) {
    await safeEditMessage(bot, chatId, messageId, text, options);
  } else {
    // Clear old slip message if starting fresh
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

  // Keep sportKey in state, update step
  const currentState = await getUserState(chatId); // Get current state to preserve currentPage
  await setUserState(chatId, { ...currentState, current_step: 'ai_legs', sportKey });
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
    reply_markup: {} // Clear buttons
  });

  let userStateForRender = {};

  try {
    const userAiConfig = await getAIConfig(chatId);
    userStateForRender = { // State needed by renderOrRetry and aiService
        sportKey,
        numLegs,
        horizonHours: userAiConfig.horizonHours || 72,
        gameContext: null, // Still placeholder
        proQuantMode: userAiConfig.proQuantMode || false
    };

    console.log(`Generating parlay with config:`, userStateForRender);

    const parlay = await quantumAIService.generateParlay(
      sportKey,
      numLegs,
      userAiConfig.mode || 'web',
      'sonar-pro', // Model seems fixed
      userAiConfig.betType || 'mixed',
      { chatId, horizonHours: userStateForRender.horizonHours, gameContext: userStateForRender.gameContext, proQuantMode: userStateForRender.proQuantMode }
    );

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
       // Clear intermediate state after completion or failure, preserving currentPage
       const finalState = await getUserState(chatId) || {};
       delete finalState.current_step;
       delete finalState.sportKey;
       delete finalState.numLegs;
       await setUserState(chatId, finalState); // Keep other state like currentPage
  }
}

// Gate AI legs to verified events before rendering
async function gateLegsToVerified(legs, sportKey, horizonHours, gameContext) {
  try {
      const verified = await gamesService.getVerifiedRealGames(sportKey, horizonHours || 72);
      if (!Array.isArray(verified) || verified.length === 0) {
          console.warn(`No verified games found for ${sportKey} to gate parlay legs.`);
          return []; // Return empty if no verified games available
      }

      const idSet = new Set(verified.map(g => g.event_id ?? g.id).filter(id => typeof id === 'string' || typeof id === 'number'));
      const nameSet = new Set(verified.map(g => `${g.away_team} @ ${g.home_team}`.toLowerCase()));

      const filtered = (legs || []).filter((leg) => {
          if (!leg || typeof leg !== 'object') return false; // Skip invalid leg objects

          // Check game_id (must be string or number)
          if ((typeof leg.game_id === 'string' || typeof leg.game_id === 'number') && idSet.has(leg.game_id)) return true;
          // Check event name (must be string)
          if (leg.event && typeof leg.event === 'string' && nameSet.has(leg.event.toLowerCase())) return true;
          // Allow if specific game context provided and selection is present
          if (gameContext && typeof leg.selection === 'string') return true;

          console.warn(`Leg filtered (no match): ${leg.event || 'No event'} - ${leg.selection || 'No Selection'}`);
          return false;
      });

      // Normalize legs if gameContext exists
      if (gameContext) {
          for (const leg of filtered) {
              if (!leg.event) leg.event = `${gameContext.away_team} @ ${gameContext.home_team}`;
              if (!leg.commence_time) leg.commence_time = gameContext.commence_time;
              if (!leg.game_id && (gameContext.event_id || gameContext.id)) {
                  leg.game_id = gameContext.event_id || gameContext.id;
              }
          }
      }
      return filtered;
  } catch (error) {
      console.error(`Error during gateLegsToVerified for ${sportKey}:`, error);
      sentryService.captureError(error, { extra: { sportKey, stage: 'gateLegsToVerified' } });
      return []; // Return empty array on error
  }
}


// Render or fail closed with a retry CTA
async function renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state) {
  const { horizonHours, gameContext } = state || {}; // Default state if undefined

  // Defensive coding: Ensure parlay is an object and has legs array
   if (typeof parlay !== 'object' || parlay === null) {
        parlay = { legs: [] };
        console.error("renderOrRetry received invalid 'parlay' object:", parlay);
   }
   if (!Array.isArray(parlay.legs)) {
        parlay.legs = [];
        console.warn("renderOrRetry received parlay with non-array 'legs':", parlay);
   }

  const gatedLegs = await gateLegsToVerified(parlay.legs, sportKey, horizonHours, gameContext);

  if (!Array.isArray(gatedLegs) || gatedLegs.length < numLegs) {
    const errorText = `❌ Could not generate enough valid & verified legs (${gatedLegs?.length || 0}/${numLegs}) for ${escapeHTML(getSportTitle(sportKey))}.\n\n_Common issues: No upcoming games in the selected horizon (${horizonHours || 72}h), AI data errors, or strict internal validation filters._`;
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

  // Use the validated legs for the final parlay object
  const finalParlay = { ...parlay, legs: gatedLegs };
  // Use the formatter function (either original or fallback)
  const text = formatParlayText(finalParlay, sportKey); // Pass the final parlay object

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
    if (!msg || !msg.chat || !msg.chat.id) return; // Basic validation
    const chatId = msg.chat.id;
    try {
        await sendAiSportSelectionMenu(bot, chatId); // Start interactive flow
    } catch (error) {
        console.error(`Error starting /ai flow for chat ${chatId}:`, error);
        sentryService.captureError(error, { extra: { chatId, command: '/ai' } });
        await bot.sendMessage(chatId, "❌ Sorry, something went wrong starting the AI builder. Please try again.").catch(e => console.error("Failed to send error message:", e));
    }
  });
}

/**
 * Registers all callbacks for the interactive AI menu.
 */
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cq) => {
    // Basic validation
    const { data, message, id: callbackQueryId } = cq; // Use unique name for cq.id
    if (!data || !message || typeof data !== 'string' || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
        // Acknowledge callback immediately to prevent user seeing "loading"
        await bot.answerCallbackQuery(callbackQueryId).catch(e => {
            // Ignore "query is too old" errors, log others
            if (!e.message.includes('query is too old')) {
                console.warn(`Failed to answer callback query ${callbackQueryId}: ${e.message}`);
            }
        });

        // --- Cancel Button ---
        if (data === 'ai_cancel') {
            await clearUserState(chatId); // Use clearUserState from state.js
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
            } else {
                 console.warn("Invalid page number in callback:", data);
            }
            return;
        }

        // --- Step 1: Sport Selection ---
        if (data.startsWith('ai_step_sport_')) {
            const sportKey = data.substring('ai_step_sport_'.length);
            // Basic validation for sportKey format
            if (sportKey && /^[a-z0-9_]+$/.test(sportKey) && sportKey.length < 50) {
                 await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
            } else {
                 console.warn(`Invalid sportKey format from callback: ${sportKey}`);
                 await safeEditMessage(bot, chatId, messageId, "❌ Invalid sport selection format. Please try again.", { reply_markup: {} });
                 await clearUserState(chatId); // Clear state if invalid selection
            }
            return;
        }

        // --- Step 2: Leg Selection ---
        if (data.startsWith('ai_step_legs_')) {
            const numLegs = parseInt(data.substring('ai_step_legs_'.length), 10);
            // ** Use getUserState **
            const userState = await getUserState(chatId);

            if (userState && userState.sportKey && userState.current_step === 'ai_legs' && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                 // ** Use setUserState **
                await setUserState(chatId, { ...userState, numLegs, current_step: 'ai_generate' });
                await triggerParlayGeneration(bot, chatId, messageId, userState.sportKey, numLegs);
            } else {
                console.warn("State/Input mismatch during leg selection:", { userState, numLegs, data });
                await safeEditMessage(bot, chatId, messageId, "❌ Session error or invalid leg count (2-10). Please start again.", { reply_markup: {} });
                await clearUserState(chatId); // Clear potentially corrupt state
            }
            return;
        }

        // --- Back Buttons ---
        if (data === 'ai_back_sport') {
            // ** Use getUserState **
            const userState = await getUserState(chatId);
            await sendAiSportSelectionMenu(bot, chatId, messageId, userState?.currentPage || 0);
            return;
        }
        if (data.startsWith('ai_back_legs_')) {
             const sportKey = data.substring('ai_back_legs_'.length);
             if (sportKey) {
                await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
             } else {
                console.warn("Back to legs called without sportKey, falling back to sports menu.");
                await sendAiSportSelectionMenu(bot, chatId, messageId, 0); // Go back to first page of sports
             }
             return;
        }

        // --- Retry Logic ---
        if (data.startsWith('ai_retry_')) {
            const parts = data.split('_');
            if (parts.length === 4) {
                const sportKey = parts[2];
                const numLegs = parseInt(parts[3], 10);
                if (sportKey && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                    await triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs);
                } else {
                     console.warn("Invalid data in retry callback:", { sportKey, numLegs, data });
                     await safeEditMessage(bot, chatId, messageId, "❌ Invalid retry data. Please start over.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] } });
                }
            } else {
                 console.warn("Malformed retry callback data:", data);
                 await safeEditMessage(bot, chatId, messageId, "❌ Error processing retry request. Please start over.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] } });
            }
            return;
        }

        // --- No-op Button ---
        if (data === 'ai_noop') {
            return; // Acknowledge was already sent
        }

        // --- Fallback for unknown ai_ callbacks ---
        console.warn(`Unhandled AI callback received: ${data}`);
        // Optionally inform the user, but often best to just ignore unrecognized clicks
        // await safeEditMessage(bot, chatId, messageId, "Unrecognized action.", {});

    } catch (error) {
        // Log detailed error and inform user generically
        console.error(`Callback Handler Error (${data}):`, error);
        sentryService.captureError(error, { extra: { callbackData: data, chatId, messageId, stage: 'callback_handler' } });
        try {
            // Send a user-friendly error message with an option to restart
            await safeEditMessage(bot, chatId, messageId, "❌ Sorry, an unexpected error occurred. Please try starting the AI builder again.", {
                 reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] }
            });
        } catch (messagingError) {
             console.error(`Failed to send error message to user ${chatId} after callback failure:`, messagingError);
        } finally {
             // Attempt to clear state to prevent user being stuck
             await clearUserState(chatId).catch(clearErr => console.error(`Failed to clear user state for ${chatId} after error:`, clearErr));
        }
    }
  });
}

// Ensure default export includes both registration functions
export default {
  registerAI,
  registerAICallbacks,
};
