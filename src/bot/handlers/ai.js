// src/bot/handlers/ai.js - FULLY RESTORED INTERACTIVE PARLAY BUILDER (v5 - Removed incorrect import)




import quantumAIService from '../../services/aiService.js';
import * as sportsSvc from '../../services/sportsService.js'; // Use your sports service
import gamesService from '../../services/gamesService.js'; // Needed for renderOrRetry
import { sentryService } from '../../services/sentryService.js';
// ** Import CORRECT state function names **
import { setUserState, getUserState, getParlaySlip, setParlaySlip, getAIConfig, clearUserState } from '../state.js';
// ** FIX: REMOVED incorrect import for formatParlayText from enterpriseUtilities **
// import { formatParlayText as originalFormatParlayText } from '../../utils/enterpriseUtilities.js'; // <--- REMOVED THIS LINE

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

// ** FIX: Define formatParlayText locally as it's not imported **
// (Using the definition from the earlier version of ai.js you provided)
function formatParlayText(parlay, sportKey) {
  if (!parlay) return "Error: Parlay data is missing."; // Handle null/undefined parlay
  const {
    legs = [],
    parlay_price_american,
    quantitative_analysis, // Include these for potential use
    research_metadata,
    portfolio_construction,
    validation,
  } = parlay;

  const sportTitle = getSportTitle(sportKey);
  const lines = [];

  lines.push(`🎯 <b>${escapeHTML(sportTitle)} Parlay</b> (${legs.length} legs)`);
  if (Number.isFinite(Number(parlay_price_american))) {
    const pa = Number(parlay_price_american);
    lines.push(`📈 Price: ${pa > 0 ? '+' : ''}${pa}`);
  }
  // Use validation info if available
  if (validation?.qualityScore != null) {
    lines.push(`✅ Validation quality: ${Math.round(validation.qualityScore)}%`);
  }

  if (legs.length > 0) lines.push(''); // Space before legs list
  legs.forEach((leg, i) => {
    // Defensive checks for leg properties
    const price = Number(leg?.odds?.american);
    const priceStr = Number.isFinite(price) ? (price > 0 ? `+${price}` : `${price}`) : 'N/A';
    const market = typeof leg?.market === 'string' ? leg.market : 'market';
    const selection = typeof leg?.selection === 'string' ? leg.selection : 'selection';
    const event = typeof leg?.event === 'string' ? leg.event : 'Unknown Event';
    // Format leg line
    lines.push(
      `${i + 1}) ${escapeHTML(event)}\n   • ${escapeHTML(market)} — ${escapeHTML(selection)} (${priceStr})`
    );
  });

  // Include analysis/thesis if present
  if (quantitative_analysis?.note) {
    lines.push(''); // Add space
    lines.push(`🧮 ${escapeHTML(quantitative_analysis.note)}`);
  }
  if (portfolio_construction?.overall_thesis) {
    lines.push(''); // Add space
    lines.push(`📚 ${escapeHTML(portfolio_construction.overall_thesis)}`);
  }
  if (research_metadata?.generation_strategy) {
    lines.push(''); // Add space
    lines.push(`🧭 Strategy: ${escapeHTML(research_metadata.generation_strategy)}`);
  }

  return lines.join('\n'); // Join with newlines
}


// --- MENU RENDERING FUNCTIONS ---

const ITEMS_PER_PAGE = 10;

async function sendAiSportSelectionMenu(bot, chatId, messageId = null, page = 0) {
  // Use getAllSports as confirmed in sportsService.js
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

  await setUserState(chatId, { current_step: 'ai_sport', currentPage: page });

  if (messageId) {
    await safeEditMessage(bot, chatId, messageId, text, options);
  } else {
    const slip = await getParlaySlip(chatId);
    if (slip?.messageId) {
        await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
        await setParlaySlip(chatId, { ...slip, messageId: null});














    }
    await bot.sendMessage(chatId, text, options);
  }
}

async function sendAiLegSelectionMenu(bot, chatId, messageId, sportKey) {
  const sportTitle = getSportTitle(sportKey);
  const text = `Selected: <b>${escapeHTML(sportTitle)}</b>\n\nStep 2: How many legs for your parlay?`;
  const keyboard = [
    [{ text: '2 Legs', callback_data: 'ai_step_legs_2' }, { text: '3 Legs', callback_data: 'ai_step_legs_3' }],
    [{ text: '4 Legs', callback_data: 'ai_step_legs_4' }, { text: '5 Legs', callback_data: 'ai_step_legs_5' }],
    [{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]
  ];

  const currentState = await getUserState(chatId);
  await setUserState(chatId, { ...currentState, current_step: 'ai_legs', sportKey });
  await safeEditMessage(bot, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
}

// --- PARLAY GENERATION AND DISPLAY ---

async function triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs) {
  const sportTitle = getSportTitle(sportKey);
  await safeEditMessage(bot, chatId, messageId, `🔎 Building a ${numLegs}-leg ${escapeHTML(sportTitle)} parlay...\n\n_AI analysis in progress (up to 60s)_`, {
    parse_mode: 'HTML',
    reply_markup: {}
  });

  let userStateForRender = {};

  try {
    const userAiConfig = await getAIConfig(chatId);
    userStateForRender = {
        sportKey,
        numLegs,
        horizonHours: userAiConfig.horizonHours || 72,
        gameContext: null, // Placeholder
        proQuantMode: userAiConfig.proQuantMode || false
    };

    console.log(`Generating parlay with config:`, userStateForRender);

    const parlay = await quantumAIService.generateParlay(
      sportKey, numLegs,
      userAiConfig.mode || 'web', 'sonar-pro', userAiConfig.betType || 'mixed',
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
       const finalState = await getUserState(chatId) || {};
       delete finalState.current_step;
       delete finalState.sportKey;
       delete finalState.numLegs;
       await setUserState(chatId, finalState);
  }
}

async function gateLegsToVerified(legs, sportKey, horizonHours, gameContext) {
  try {
      const verified = await gamesService.getVerifiedRealGames(sportKey, horizonHours || 72);
      if (!Array.isArray(verified) || verified.length === 0) {
          console.warn(`No verified games found for ${sportKey}. Cannot gate legs.`);
          return [];













      }
      const idSet = new Set(verified.map(g => g.event_id ?? g.id).filter(id => typeof id === 'string' || typeof id === 'number'));
      const nameSet = new Set(verified.map(g => `${g.away_team} @ ${g.home_team}`.toLowerCase()));

      const filtered = (legs || []).map(leg => { // Use map to add validation flag
          if (!leg || typeof leg !== 'object') return null; // Skip invalid leg structures

          let isValid = false;
          if ((typeof leg.game_id === 'string' || typeof leg.game_id === 'number') && idSet.has(leg.game_id)) {
              isValid = true;
          } else if (leg.event && typeof leg.event === 'string' && nameSet.has(leg.event.toLowerCase())) {
              isValid = true;
          } else if (gameContext && typeof leg.selection === 'string') {
              // Assume valid if context provided, but might lack specific game_id initially
              isValid = true;
          }

          if (isValid) {
              // Normalize if context exists
              if (gameContext) {
                  if (!leg.event) leg.event = `${gameContext.away_team} @ ${gameContext.home_team}`;
                  if (!leg.commence_time) leg.commence_time = gameContext.commence_time;
                  if (!leg.game_id && (gameContext.event_id || gameContext.id)) {
                      leg.game_id = gameContext.event_id || gameContext.id;
                  }
              }
              return { ...leg, real_game_validated: true }; // Add flag
          } else {
              console.warn(`Leg filtered (no verified match): ${leg.event || 'No event'} - ${leg.selection || 'No Selection'}`);
              return null; // Exclude this leg
          }
      }).filter(Boolean); // Remove null entries

      return filtered;
  } catch (error) {
      console.error(`Error gating legs for ${sportKey}:`, error);
      sentryService.captureError(error, { extra: { sportKey, stage: 'gateLegsToVerified' } });
      return []; // Return empty on error
  }
}


async function renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state) {
  const { horizonHours, gameContext } = state || {};

   if (typeof parlay !== 'object' || parlay === null) {
        parlay = { legs: [] };
        console.error("renderOrRetry received invalid 'parlay' object:", parlay);
   }
   if (!Array.isArray(parlay.legs)) {
        parlay.legs = [];
        console.warn("renderOrRetry received parlay with non-array 'legs':", parlay);
   }

  // Gate the legs first
  const gatedLegs = await gateLegsToVerified(parlay.legs, sportKey, horizonHours, gameContext);

  // Check if enough *verified* legs exist
  if (!Array.isArray(gatedLegs) || gatedLegs.length < numLegs) {
    const errorText = `❌ Could not generate enough valid & verified legs (${gatedLegs?.length || 0}/${numLegs}) for ${escapeHTML(getSportTitle(sportKey))}.\n\n_This can happen if the AI suggests games outside the ${horizonHours || 72}h window, if games aren't found on official schedules, or due to AI errors._`;
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

  // Use ONLY the gated legs for the final parlay object
  const finalParlay = { ...parlay, legs: gatedLegs };
  // Pass the final parlay to the formatter
  const text = formatParlayText(finalParlay, sportKey); // Ensure this uses the locally defined function

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

export function registerAI(bot) {
  bot.onText(/\/(ai|parlay)/, async (msg) => {
    if (!msg || !msg.chat || !msg.chat.id) return;
    const chatId = msg.chat.id;
    try {
        await sendAiSportSelectionMenu(bot, chatId);
    } catch (error) {
        console.error(`Error in /ai handler for chat ${chatId}:`, error);
        sentryService.captureError(error, { extra: { chatId, command: '/ai' } });
        await bot.sendMessage(chatId, "❌ Oops! Something went wrong initiating the AI builder. Please try again.").catch(e => console.error("Failed to send error message:", e));
    }
  });
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cq) => {
    const { data, message, id: callbackQueryId } = cq;
    if (!data || !message || typeof data !== 'string' || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
        await bot.answerCallbackQuery(callbackQueryId).catch(e => {
            if (!e.message.includes('query is too old')) { console.warn(`Failed to ack callback ${callbackQueryId}: ${e.message}`); }
        });

        if (data === 'ai_cancel') {
            await clearUserState(chatId);
            await safeEditMessage(bot, chatId, messageId, 'AI Parlay Builder cancelled.', { reply_markup: {} });
            return;
        }
        if (data === 'ai_start_new') {
            await sendAiSportSelectionMenu(bot, chatId, messageId, 0);
            return;
        }
        if (data.startsWith('ai_page_sport_')) {
            const page = parseInt(data.substring('ai_page_sport_'.length), 10);
            if (!isNaN(page)) await sendAiSportSelectionMenu(bot, chatId, messageId, page);
            return;
        }
        if (data.startsWith('ai_step_sport_')) {
            const sportKey = data.substring('ai_step_sport_'.length);
            if (sportKey && /^[a-z0-9_]+$/.test(sportKey) && sportKey.length < 50) {
                 await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
            } else {
                 await safeEditMessage(bot, chatId, messageId, "❌ Invalid sport selection. Try again.", { reply_markup: {} });
                 await clearUserState(chatId);
            }
            return;
        }
        if (data.startsWith('ai_step_legs_')) {
            const numLegs = parseInt(data.substring('ai_step_legs_'.length), 10);
            const userState = await getUserState(chatId);
            if (userState?.sportKey && userState.current_step === 'ai_legs' && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                await setUserState(chatId, { ...userState, numLegs, current_step: 'ai_generate' });
                await triggerParlayGeneration(bot, chatId, messageId, userState.sportKey, numLegs);
            } else {
                await safeEditMessage(bot, chatId, messageId, "❌ Session error or invalid legs (2-10). Start again /ai.", { reply_markup: {} });
                await clearUserState(chatId);
            }
            return;
        }
        if (data === 'ai_back_sport') {
            const userState = await getUserState(chatId);
            await sendAiSportSelectionMenu(bot, chatId, messageId, userState?.currentPage || 0);
            return;
        }
        if (data.startsWith('ai_back_legs_')) {
             const sportKey = data.substring('ai_back_legs_'.length);
             if (sportKey) await sendAiLegSelectionMenu(bot, chatId, messageId, sportKey);
             else await sendAiSportSelectionMenu(bot, chatId, messageId, 0);
             return;
        }
        if (data.startsWith('ai_retry_')) {
            const parts = data.split('_');
            if (parts.length === 4) {
                const sportKey = parts[2];
                const numLegs = parseInt(parts[3], 10);
                if (sportKey && !isNaN(numLegs) && numLegs >= 2 && numLegs <= 10) {
                    await triggerParlayGeneration(bot, chatId, messageId, sportKey, numLegs);
                } else {
                     await safeEditMessage(bot, chatId, messageId, "❌ Invalid retry data.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] } });
                }
            } else {
                 await safeEditMessage(bot, chatId, messageId, "❌ Error processing retry.", { reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] } });
            }
            return;
        }
        if (data === 'ai_noop') return;

        console.warn(`Unhandled AI callback: ${data}`);

    } catch (error) {
        console.error(`Callback Handler Error (${data}):`, error);
        sentryService.captureError(error, { extra: { callbackData: data, chatId, messageId, stage: 'callback_handler' } });
        try {
            await safeEditMessage(bot, chatId, messageId, "❌ An unexpected error occurred. Please start over.", {
                 reply_markup: { inline_keyboard: [[{ text: 'Start Over /ai', callback_data: 'ai_start_new' }]] }
            });
        } catch (messagingError) {
             console.error(`Failed to send error message after callback failure:`, messagingError);
        } finally {
             await clearUserState(chatId).catch(clearErr => console.error(`Failed to clear state after error:`, clearErr));
        }
    }
  });
}

export default {
  registerAI,
  registerAICallbacks,
};
