// src/bot/handlers/ai.js - FINAL, COMPLETE, AND CORRECTED (with EV Display Update & Error Fix)
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState, getAIConfig } from '../state.js'; // Added getAIConfig
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../bot.js';
import { sentryService } from '../../services/sentryService.js'; // Added Sentry

// HTML escaping function
const escapeHTML = (text) => {
  // Ensure input is a string or number before escaping
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const PAGE_SIZE = 10; // Number of sports per page
let sportsCache = null;
let sportsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache for sports list

// *** ADD CONSTANT HERE ***
const DEFAULT_HORIZON_HOURS_AI = 72; // Define the default horizon for AI requests within this handler

// Helper function for pagination
function pageOf(arr, page) {
  if (!Array.isArray(arr)) return [];
  const start = page * PAGE_SIZE;
  return arr.slice(start, start + PAGE_SIZE);
}

// Fetches and caches the available sports list
async function getCachedSports() {
  const now = Date.now();
  if (sportsCache && now - (sportsCacheTime || 0) < CACHE_DURATION) {
    return sportsCache;
  }
  try {
    const sports = await gamesService.getAvailableSports();
     if (!Array.isArray(sports) || sports.length === 0) {
         console.error('❌ Failed to fetch any sports from gamesService.');
         // Return previous cache if available, else empty array
         return sportsCache || [];
     }
    sportsCache = sports;
    sportsCacheTime = now;
    console.log(`[Cache] Sports cache refreshed: ${sportsCache.length} sports found.`);
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    sentryService.captureError(error, { component: 'ai_handler', operation: 'getCachedSports' });
    // Return previous cache if available, else empty array on error
    return sportsCache || [];
  }
}

// Registers the main /ai command
export function registerAI(bot) {
  bot.onText(/^\/ai(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[/ai Command] Received from chat ID: ${chatId}`);
    try {
      // Reset state for a new AI session, keeping page 0
      await setUserState(chatId, { page: 0, chat: null, parlay_slip: null }, 1800); // Clear other states, 30 min TTL
      await sendSportSelection(bot, chatId);
    } catch (error) {
      console.error('❌ AI command handler error:', error);
      sentryService.captureError(error, { component: 'ai_handler', operation: '/ai_command' });
      await bot.sendMessage(chatId, '❌ Failed to start AI Parlay Builder. Please try again later.');
    }
  });

  // Optional: Keep /ai_quick for fast testing/presets
  bot.onText(/^\/ai_quick(?:\s|$)/, async (msg) => {
     const chatId = msg.chat.id;
     console.log(`[/ai_quick Command] Received from chat ID: ${chatId}`);
     try {
       // Fetch user config to potentially override defaults
       const userConfig = await getAIConfig(chatId);
       const defaultSport = 'basketball_nba'; // Hardcoded default for quick command
       await setUserState(chatId, {
         sportKey: defaultSport,
         numLegs: 3, // Common default
         mode: userConfig.mode || 'web', // Use user's preferred mode or fallback
         betType: userConfig.betType || 'mixed',
         // aiModel: userConfig.model || 'perplexity', // Model selection is internal now
         quantitativeMode: userConfig.quantitativeMode || 'conservative',
         // Pass user config directly to executeAiRequest
         userConfig: userConfig
       }, 1800); // Set TTL
       await executeAiRequest(bot, chatId); // Pass userConfig implicitly via state
     } catch (error) {
       console.error('❌ AI quick command error:', error);
       sentryService.captureError(error, { component: 'ai_handler', operation: '/ai_quick_command' });
       await bot.sendMessage(chatId, '❌ Quick AI parlay failed. Please try the full /ai builder.');
     }
  });

} // End registerAI

// Registers all callbacks starting with 'ai_'
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    // Ensure basic validity and correct prefix
    if (!data || !message || typeof data !== 'string' || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    // Answer callback quickly to remove loading state
    try {
      await bot.answerCallbackQuery(cbq.id, { cache_time: 2 }); // Short cache time
    } catch (error) {
      // Ignore "query is too old" errors, log others
      if (!error.message?.includes("query is too old")) {
        console.error("Error answering callback query:", error);
      }
      // Don't stop execution for this error
    }

    let state = await getUserState(chatId) || {};
    // Ensure state TTL is refreshed on interaction
    const currentStateTTL = 1800; // 30 minutes

    const parts = data.split('_');
    const action = parts[1];
     console.log(`[AI Callback] Action: ${action}, Data: ${data}, Chat ID: ${chatId}`);


    try {
      switch (action) {
        case 'page':
          const requestedPage = parseInt(parts[2], 10);
          if (!isNaN(requestedPage)) {
              state.page = requestedPage;
              await setUserState(chatId, state, currentStateTTL); // Refresh TTL
              await sendSportSelection(bot, chatId, messageId, state.page);
          } else {
               console.warn(`[AI Callback] Invalid page number in data: ${data}`);
          }
          break;
        case 'sport':
          // Sport key might contain underscores
          state.sportKey = parts.slice(2).join('_');
           // Validate sport key slightly
           if (!state.sportKey || state.sportKey.length < 3) {
                console.warn(`[AI Callback] Invalid sport key selected: ${state.sportKey}`);
                await safeEditMessage(chatId, messageId, '❌ Invalid sport selected. Please try again.');
                await sendSportSelection(bot, chatId, messageId, state.page || 0); // Resend sport selection
                break;
           }
          state.page = 0; // Reset page when sport is chosen
          await setUserState(chatId, state, currentStateTTL);
          await sendLegSelection(bot, chatId, messageId);
          break;
        case 'legs':
           const numLegs = parseInt(parts[2], 10);
           if (!isNaN(numLegs) && numLegs >= 2 && numLegs <= 8) { // Validate leg count
                state.numLegs = numLegs;
                await setUserState(chatId, state, currentStateTTL);
                await sendModeSelection(bot, chatId, messageId);
           } else {
                console.warn(`[AI Callback] Invalid number of legs in data: ${data}`);
           }
          break;
        case 'mode':
           const mode = parts[2];
           if (['web', 'live', 'db'].includes(mode)) { // Validate mode
                state.mode = mode;
                // Fetch user config for the next step if not already in state
                if (!state.userConfig) state.userConfig = await getAIConfig(chatId);
                await setUserState(chatId, state, currentStateTTL);
                await sendBetTypeSelection(bot, chatId, messageId);
           } else {
                console.warn(`[AI Callback] Invalid mode in data: ${data}`);
           }
          break;
        case 'bettype':
           const betType = parts[2];
            // Allow 'moneyline', 'spreads', 'totals', 'props', 'mixed' (adjust if needed)
           if (['moneyline', 'spreads', 'totals', 'props', 'mixed'].includes(betType)) {
                state.betType = betType;
                // aiModel is now determined internally by aiService based on keys
                // state.aiModel = 'perplexity'; // No longer set here
                await setUserState(chatId, state, currentStateTTL);
                 // Skip quantitative mode selection for simplicity or keep it?
                 // Keeping it for now based on previous flow:
                await sendQuantitativeModeSelection(bot, chatId, messageId);
                // Alternatively, go straight to execution:
                // await executeAiRequest(bot, chatId, messageId);
            } else {
                 console.warn(`[AI Callback] Invalid bet type in data: ${data}`);
            }
          break;
         case 'quantitative': // Optional step retained
             const quantMode = parts[2];
             if (['conservative', 'aggressive'].includes(quantMode)) {
                 state.quantitativeMode = quantMode;
                 // Ensure user config is loaded before execution
                 if (!state.userConfig) state.userConfig = await getAIConfig(chatId);
                 await setUserState(chatId, state, currentStateTTL);
                 await executeAiRequest(bot, chatId, messageId); // Pass state implicitly
             } else {
                 console.warn(`[AI Callback] Invalid quantitative mode in data: ${data}`);
             }
             break;

        case 'back':
          const targetStep = parts[2];
          console.log(`[AI Callback] Navigating back to: ${targetStep}`);
          // Navigate back to the appropriate menu
          if (targetStep === 'sport') await sendSportSelection(bot, chatId, messageId, state.page || 0);
          else if (targetStep === 'legs') await sendLegSelection(bot, chatId, messageId);
          else if (targetStep === 'mode') await sendModeSelection(bot, chatId, messageId);
          else if (targetStep === 'bettype') await sendBetTypeSelection(bot, chatId, messageId);
          else if (targetStep === 'quantmode') await sendQuantitativeModeSelection(bot, chatId, messageId); // Add back to quant mode if needed
           else console.warn(`[AI Callback] Unknown back target: ${targetStep}`);
          break;

        case 'noop': // Callback for static elements like page numbers
             console.log(`[AI Callback] No-op action received.`);
             break; // Do nothing

        default:
             console.warn(`[AI Callback] Unknown action: ${action} in data: ${data}`);
      }
    } catch (error) {
      console.error(`❌ AI callback processing error (Action: ${action}):`, error);
      sentryService.captureError(error, { component: 'ai_handler', operation: `callback_${action}`, chatId, data });
      // Try to inform the user, default to simple message
      try {
           await safeEditMessage(chatId, messageId, `❌ An error occurred processing your request (${action}). Please try again or start over with /ai. Error: ${escapeHTML(error.message)}`, { parse_mode: 'HTML' });
      } catch (editError) {
           await bot.sendMessage(chatId, `❌ An error occurred processing your request. Please try again or start over with /ai.`);
      }
    }
  });
} // End registerAICallbacks

// --- Menu Sending Functions ---

async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
    const sports = await getCachedSports();
    if (!Array.isArray(sports) || sports.length === 0) {
        const text = '⚠️ No sports available right now. Please check back later or try /cache_refresh.';
        // Attempt to edit if messageId provided, otherwise send new message
        if (messageId) return safeEditMessage(chatId, messageId, text);
        return bot.sendMessage(chatId, text);
    }

    const sortedSports = sortSports(sports); // Ensure sorting
    const totalPages = Math.ceil(sortedSports.length / PAGE_SIZE);
    // Ensure page is within valid bounds
    page = Math.max(0, Math.min(page, totalPages - 1));

    // Get sports for the current page
    const sportsOnPage = pageOf(sortedSports, page);
    const sportButtons = sportsOnPage.map(s => ({
        text: `${getSportEmoji(s.sport_key)} ${escapeHTML(s.sport_title)}`,
        callback_data: `ai_sport_${s.sport_key}` // Ensure sport_key is valid
    }));

    // Arrange buttons in rows (max 2 per row)
    const rows = [];
    for (let i = 0; i < sportButtons.length; i += 2) {
        rows.push(sportButtons.slice(i, i + 2));
    }

    // Add navigation buttons if multiple pages
    if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
        // Add a static page indicator (non-clickable)
        navRow.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: 'ai_noop' }); // No-op callback
        if (page < totalPages - 1) navRow.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
        rows.push(navRow);
    }

    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 1 of 5:</b> Select a sport.`;
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };

    try {
        if (messageId) {
            await safeEditMessage(chatId, messageId, text, opts);
        } else {
            await bot.sendMessage(chatId, text, opts);
        }
    } catch (error) {
        console.error("Error sending/editing sport selection:", error);
        sentryService.captureError(error, { component: 'ai_handler', operation: 'sendSportSelection' });
        // Fallback message if edit/send fails
        await bot.sendMessage(chatId, "Error displaying sports list. Please try /ai again.");
    }
}


async function sendLegSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = getSportTitle(state?.sportKey || ''); // Handle missing state
  const legOptions = [2, 3, 4, 5, 6, 7, 8]; // Allowed leg counts
  const buttons = legOptions.map(num => ({ text: `${num} Legs`, callback_data: `ai_legs_${num}` }));

  // Arrange buttons (e.g., 4 per row)
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 4) {
      keyboard.push(buttons.slice(i, i + 4));
  }
  // Add back button
  keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);

  const text = `🤖 <b>AI Parlay Builder</b>\n\n` +
               `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
               `<b>Step 2 of 5:</b> Select number of legs.`;
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendModeSelection(bot, chatId, messageId) {
    const state = await getUserState(chatId);
    const sportTitle = getSportTitle(state?.sportKey || '');
    const numLegs = state?.numLegs || '?';

    const text = `🤖 <b>AI Parlay Builder</b>\n\n` +
                 `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                 `<b>Legs:</b> ${escapeHTML(numLegs)}\n` +
                 `<b>Step 3 of 5:</b> Select analysis mode.\n\n` +
                 `🌐 <b>Web:</b> AI researches current odds/info online.\n` +
                 `📡 <b>Live:</b> Uses live API data + AI analysis (Fastest, needs API keys).\n` +
                 `💾 <b>Database:</b> Scans stored data for best mathematical value (+EV).`;

    const keyboard = [
        // Rows for each mode
        [{ text: '🌐 Web Research (AI Picks)', callback_data: 'ai_mode_web'}],
        [{ text: '📡 Live API Data (AI Picks)', callback_data: 'ai_mode_live'}],
        [{ text: '💾 Database Scan (+EV Focus)', callback_data: 'ai_mode_db'}],
        // Back button
        [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBetTypeSelection(bot, chatId, messageId) {
    const state = await getUserState(chatId);
    const sportTitle = getSportTitle(state?.sportKey || '');
    const numLegs = state?.numLegs || '?';
    const mode = state?.mode || '?';

    const text = `🤖 <b>AI Parlay Builder</b>\n\n` +
                 `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                 `<b>Legs:</b> ${escapeHTML(numLegs)}\n` +
                 `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n` +
                 `<b>Step 4 of 5:</b> Select target bet types.`;

    // Define bet type options
    const betTypes = [
        { text: '🎯 Moneyline', callback_data: 'ai_bettype_moneyline'},
        { text: '📊 Spreads', callback_data: 'ai_bettype_spreads'},
        { text: '📈 Totals (Over/Under)', callback_data: 'ai_bettype_totals'},
        // Player props might depend on sport/mode, add conditionally if needed
        // { text: '🔥 Player Props', callback_data: 'ai_bettype_props'},
        { text: '🧩 Any/Mixed', callback_data: 'ai_bettype_mixed'}
    ];

     // Arrange buttons (e.g., 2 per row)
     const keyboard = [];
     for (let i = 0; i < betTypes.length; i += 2) {
         keyboard.push(betTypes.slice(i, i + 2));
     }
     // Add back button
    keyboard.push([{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]);

    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendQuantitativeModeSelection(bot, chatId, messageId) {
     const state = await getUserState(chatId);
     const sportTitle = getSportTitle(state?.sportKey || '');
     const numLegs = state?.numLegs || '?';
     const mode = state?.mode || '?';
     const betType = state?.betType || '?';

    const text = `🤖 <b>AI Parlay Builder</b>\n\n` +
                 `<b>Sport:</b> ${escapeHTML(sportTitle)}\n` +
                 `<b>Legs:</b> ${escapeHTML(numLegs)}\n` +
                 `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n` +
                 `<b>Bets:</b> ${escapeHTML(betType)}\n` +
                 `<b>Step 5 of 5:</b> Select analysis approach.\n\n` +
                 `🧐 <b>Conservative:</b> Prioritizes safety, lower risk/reward (Recommended).\n` +
                 `🚀 <b>Aggressive:</b> Seeks higher potential EV, accepts more risk.`;

    const keyboard = [
      [{ text: '🧐 Conservative', callback_data: 'ai_quantitative_conservative' }],
      [{ text: '🚀 Aggressive', callback_data: 'ai_quantitative_aggressive' }],
      [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

// --- AI Execution & Result Display ---

async function executeAiRequest(bot, chatId, messageId = null) {
    let statusMessageId = messageId;
    const startTime = Date.now();

    // Send initial "Analyzing" message if no messageId provided
    if (!statusMessageId) {
        try {
            const sent = await bot.sendMessage(chatId, '🤖 <b>Analyzing... Please wait.</b>', { parse_mode: 'HTML' });
            statusMessageId = sent.message_id;
        } catch (sendError) {
             console.error("Error sending initial status message:", sendError);
             sentryService.captureError(sendError, { component: 'ai_handler', operation: 'executeAiRequest_InitialSend' });
             // If we can't even send the first message, abort
             return;
        }
    }

    const state = await getUserState(chatId);
    // Ensure user config is loaded into state if not already there
    const userConfig = state?.userConfig || await getAIConfig(chatId);
     // Update state with userConfig if it was just loaded
     if (!state?.userConfig) {
         await setUserState(chatId, { ...state, userConfig }, 1800);
     }


    // Validate essential state properties
    const { sportKey, numLegs, mode, betType, /* aiModel no longer needed */ quantitativeMode } = state || {};
    if (!sportKey || !numLegs || !mode || !betType || !quantitativeMode) {
        console.error(`❌ Incomplete state for AI request. State:`, state);
         await safeEditMessage(chatId, statusMessageId, '❌ Critical error: Parlay configuration incomplete. Please start over using /ai.');
        return;
    }

    const sportTitle = getSportEmoji(sportKey) + ' ' + getSportTitle(sportKey);
    const text = `🤖 <b>Generating ${escapeHTML(sportTitle)} Parlay...</b>\n\n` +
                 `<b>Legs:</b> ${escapeHTML(numLegs)}\n` +
                 `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n` +
                 `<b>Bets:</b> ${escapeHTML(betType)}\n` +
                 `<b>Approach:</b> ${escapeHTML(quantitativeMode)}\n\n` +
                 `<i>This may take 30-60 seconds...</i>`;

    // Update status message
    await safeEditMessage(chatId, statusMessageId, text, { parse_mode: 'HTML' });

    try {
        // Call aiService with necessary state and options
        const parlayResult = await aiService.generateParlay(
            sportKey,
            numLegs,
            mode,
            null, // aiModel is internal to aiService
            betType,
            { // Pass options object
                quantitativeMode,
                // *** USE THE LOCALLY DEFINED CONSTANT ***
                horizonHours: DEFAULT_HORIZON_HOURS_AI, // Use the constant defined in this file
                userConfig: userConfig, // Pass user config
                chatId: chatId // Pass chatId if needed downstream
            }
        );

         const duration = (Date.now() - startTime) / 1000;
         console.log(`[AI Request] Completed in ${duration.toFixed(1)}s for Chat ID: ${chatId}`);

        // Display the result using the updated function
        await sendParlayResult(bot, chatId, parlayResult, state, statusMessageId);

    } catch (error) {
         const duration = (Date.now() - startTime) / 1000;
         console.error(`❌ AI request execution error after ${duration.toFixed(1)}s (Chat ID: ${chatId}):`, error.message);
         sentryService.captureError(error, { component: 'ai_handler', operation: 'executeAiRequest_Catch', chatId, state });

         // Provide a more informative error message
         let errorMessage = `❌ <b>Parlay Generation Failed</b>\n\n`;
         errorMessage += `There was an error during the analysis process. \n\n`;
         errorMessage += `<b>Details:</b> <code>${escapeHTML(error.message)}</code>\n\n`;
          errorMessage += `<i>You can try again, select a different mode (e.g., Database Scan), or check API status via /tools.</i>`;

          const keyboard = [[{ text: '🔄 Try Again (Same Settings)', callback_data: `ai_quantitative_${quantitativeMode}` }],
                           [{ text: '« Change Settings', callback_data: 'ai_back_quantmode' }]]; // Back to last step

         await safeEditMessage(chatId, statusMessageId, errorMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }});
    }
}


// **UPDATED** function to display the detailed parlay result
async function sendParlayResult(bot, chatId, parlayResult, state, messageId) {
    const { sportKey } = state;
    const sportTitle = getSportTitle(sportKey);

    // --- Handle Rejections or Errors ---
    if (!parlayResult || parlayResult.error || parlayResult.summary?.verdict === 'REJECTED' || parlayResult.riskAssessment?.overallRisk === 'REJECTED') {
        const reason = parlayResult?.error || parlayResult?.summary?.primaryAction || parlayResult?.riskAssessment?.risks?.[0]?.message || 'Critical risk factors identified or an unexpected error occurred.';
        console.warn(`[Parlay Result] Parlay REJECTED for ${sportKey}. Reason: ${reason}`);

        let errorText = `❌ <b>Parlay Rejected</b>\n\n`;
        errorText += `<b>Sport:</b> ${escapeHTML(sportTitle)}\n`;
        errorText += `<b>Reason:</b> ${escapeHTML(String(reason).substring(0, 500))}\n\n`; // Limit reason length
         errorText += `<i>${escapeHTML(parlayResult?.recommendations?.primaryAction || 'No suitable parlay could be constructed. Try adjusting settings.')}</i>`;

         // Suggest trying again or changing settings
         const keyboard = [
            [{ text: '🔄 Try Again (Same Settings)', callback_data: `ai_quantitative_${state.quantitativeMode}` }], // Retry last step
            [{ text: '⚙️ Change Settings', callback_data: 'ai_back_sport' }] // Go back to sport selection
         ];
        await safeEditMessage(chatId, messageId, errorText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        return;
    }

    // --- Handle Cases with No Valid Legs (e.g., DB Scan finds nothing) ---
    if (!Array.isArray(parlayResult.legs) || parlayResult.legs.length === 0) {
        const reason = parlayResult.portfolio_construction?.overall_thesis || parlayResult.summary?.primaryAction || "No suitable legs found matching criteria.";
        console.log(`[Parlay Result] No valid legs found for ${sportKey}. Reason: ${reason}`);

        let noLegsText = `🤷 <b>No Parlay Generated</b>\n\n`;
        noLegsText += `<b>Sport:</b> ${escapeHTML(sportTitle)}\n`;
        noLegsText += `<b>Reason:</b> ${escapeHTML(String(reason).substring(0, 500))}\n\n`; // Limit reason length
         noLegsText += `<i>Consider broadening criteria (e.g., different bet types, mode) or trying another sport.</i>`;

        const keyboard = [[{ text: '⚙️ Change Settings', callback_data: 'ai_back_sport' }]];
        await safeEditMessage(chatId, messageId, noLegsText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        return;
    }


    // --- Format Successful Parlay ---
    const { legs, combined_parlay_metrics, riskAssessment, recommendations, summary, research_metadata } = parlayResult;

    // Build the response string piece by piece
    let response = `✅ <b>AI-Generated Parlay</b> (${summary?.verdict || 'Analysis Complete'})\n`;
    response += `<b>Sport:</b> ${getSportEmoji(sportKey)} ${escapeHTML(sportTitle)}\n`;
    response += `<b>Mode:</b> ${escapeHTML(research_metadata?.mode?.toUpperCase() || state.mode.toUpperCase())}\n`;
    // response += `<b>Strategy:</b> ${escapeHTML(research_metadata?.generationStrategy || 'Unknown')}\n\n`; // Maybe too internal


    // Display Legs
    response += `\n<b>Legs (${legs.length}):</b>\n`;
    legs.forEach((leg, index) => {
        const game = escapeHTML(leg.event || leg.game || 'Unknown Game');
        const pick = escapeHTML(leg.selection || leg.pick || 'Unknown Pick');
        const oddsValue = leg.odds?.american ?? leg.price;
        const oddsStr = (typeof oddsValue === 'number') ? (oddsValue > 0 ? `+${oddsValue}` : `${oddsValue}`) : 'N/A';
        const modelProb = (leg.model_probability !== undefined && leg.model_probability !== null) ? `${(leg.model_probability * 100).toFixed(1)}%` : 'N/A';
        const legEV = (leg.ev_per_100 !== undefined && leg.ev_per_100 !== null) ? `${leg.ev_per_100.toFixed(1)}%` : 'N/A';
        // Use validation marker only if validation was attempted (web/live modes)
        let validationMark = '';
         if (research_metadata?.generationStrategy?.includes('web') || research_metadata?.generationStrategy?.includes('live')) {
              validationMark = leg.real_game_validated === false ? '❓' : '✔️';
         }


        response += `${index + 1}) ${validationMark} ${game}\n`;
        response += `   <b>Pick:</b> ${pick} (<b>${oddsStr}</b>)\n`;
        response += `   <i>Est. Win%:</i> ${modelProb} | <i>Leg EV:</i> ${legEV}\n`;
         // Show critical injury gates
         if (Array.isArray(leg.injury_gates) && leg.injury_gates.length > 0) {
             const criticalGates = leg.injury_gates.filter(g => typeof g === 'string' && /\((Questionable|Doubtful|Out)\)/i.test(g));
             if (criticalGates.length > 0) {
                  // Use <b> for warning color if possible, or just bold
                  response += `   <b>⚠️ Injury:</b> ${escapeHTML(criticalGates.join(', ').substring(0, 100))}\n`;
             }
         }
        // response += `\n`; // Removed extra newline
    });

    // Display Combined Metrics
    response += `\n<b>Combined Odds:</b> ${escapeHTML(combined_parlay_metrics?.combined_american_odds || 'N/A')}\n`;
    const combinedProb = combined_parlay_metrics?.combined_probability_product;
    response += `<b>Est. Parlay Win%:</b> ${typeof combinedProb === 'number' ? (combinedProb * 100).toFixed(1) + '%' : 'N/A'}\n`;
    const overallEV = combined_parlay_metrics?.parlay_ev_per_100;
    response += `<b>Overall EV:</b> <b>${typeof overallEV === 'number' ? overallEV.toFixed(1) + '%' : 'N/A'}</b> ${typeof overallEV === 'number' ? (overallEV > 0 ? '📈' : '📉') : ''}\n`;
    response += `<b>Risk Level:</b> ${escapeHTML(riskAssessment?.overallRisk || 'UNKNOWN')}\n`;

    // Display Staking Recommendation
    const recommendedStake = combined_parlay_metrics?.kelly_stake?.bankroll_allocation_percent;
    if (typeof recommendedStake === 'number') {
         response += `<b>Recommended Stake:</b> ${recommendedStake.toFixed(1)}% of Bankroll\n`;
    }

    // Display Primary Action / Key Risks
    response += `\n<b>Action: ${escapeHTML(recommendations?.primaryAction || 'Review Carefully')}</b>\n`;
    if (Array.isArray(riskAssessment?.risks) && riskAssessment.risks.length > 0) {
        // Show only High/Critical risks for brevity, or top 1-2
        const importantRisks = riskAssessment.risks.filter(r => r.severity === 'HIGH' || r.severity === 'CRITICAL').slice(0, 2);
         if (importantRisks.length > 0) {
             response += `<i>Key Risks: ${escapeHTML(importantRisks.map(r => r.message || r.type).join('; '))}</i>\n`;
         } else if (riskAssessment.risks.length > 0) {
             // Show top medium risk if no high/critical
             response += `<i>Risk Note: ${escapeHTML(riskAssessment.risks[0].message || riskAssessment.risks[0].type)}</i>\n`;
         }
    }

     // Add validation/fallback warning note
     const validationRate = research_metadata?.validationRate;
     const isFallback = research_metadata?.fallback_used;
     if (isFallback) {
         response += `\n<i>⚠️ Generated in Fallback Mode. Data is estimated. Verify details & odds.</i>`;
     } else if (typeof validationRate === 'number' && validationRate < 0.8) {
         response += `\n<i>⚠️ Low schedule validation (${(validationRate * 100).toFixed(0)}%). Verify game details & odds.</i>`;
     }


    // Final Keyboard
    const finalKeyboard = [[{ text: '🔄 Build Another Parlay', callback_data: 'ai_back_sport' }]];
    // Optionally add button to save/share parlay if needed later

    try {
        await safeEditMessage(chatId, messageId, response, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } });
    } catch (editError) {
         console.error("Error editing final parlay result message:", editError);
         sentryService.captureError(editError, { component: 'ai_handler', operation: 'sendParlayResult_FinalEdit' });
         // Fallback: Send as new message if edit fails
         try {
             await bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } });
         } catch (sendError) {
             console.error("Fallback send message also failed:", sendError);
             // Cannot communicate failure to user easily here
         }
    }

} // End sendParlayResult
