===FILE:oddbot-main.zip/src/bot/handlers/ai.js===
// src/bot/handlers/ai.js - COMPLETE FILE with Fixes & Logging

import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState, getAIConfig } from '../state.js';
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../bot.js';
import { sentryService } from '../../services/sentryService.js';

// HTML escaping function
const escapeHTML = (text) => { /* ... implementation ... */
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

const PAGE_SIZE = 10;
let sportsCache = null;
let sportsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000;
const DEFAULT_HORIZON_HOURS_AI = 72;

// Helper function for pagination
function pageOf(arr, page) { /* ... implementation ... */
  if (!Array.isArray(arr)) return [];
  const start = page * PAGE_SIZE;
  return arr.slice(start, start + PAGE_SIZE);
}

// Fetches and caches the available sports list
async function getCachedSports() { /* ... implementation ... */
  const now = Date.now();
  if (sportsCache && now - (sportsCacheTime || 0) < CACHE_DURATION) return sportsCache;
  try {
    const sports = await gamesService.getAvailableSports();
    if (!Array.isArray(sports) || sports.length === 0) return sportsCache || [];
    sportsCache = sports; sportsCacheTime = now;
    console.log(`[Cache] Sports cache refreshed: ${sportsCache.length} sports.`);
    return sportsCache;
  } catch (error) { console.error('❌ Failed to refresh sports cache:', error); sentryService.captureError(error, { op: 'getCachedSports' }); return sportsCache || []; }
}

// Registers the main /ai command
export function registerAI(bot) { /* ... implementation ... */
  bot.onText(/^\/ai(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[/ai Command] From: ${chatId}`);
    try {
      await setUserState(chatId, { page: 0 }, 1800, false); // Overwrite state, keep only page
      await sendSportSelection(bot, chatId);
    } catch (error) { console.error('❌ /ai handler error:', error); sentryService.captureError(error, { op: '/ai_command' }); await bot.sendMessage(chatId, '❌ Failed to start. Try again.'); }
  });
  bot.onText(/^\/ai_quick(?:\s|$)/, async (msg) => { /* ... implementation ... */
     const chatId = msg.chat.id; console.log(`[/ai_quick Command] From: ${chatId}`);
     try {
       const userConfig = await getAIConfig(chatId); const defaultSport = 'basketball_nba';
       await setUserState(chatId, { sportKey: defaultSport, numLegs: 3, mode: userConfig.mode || 'web', betType: userConfig.betType || 'mixed', quantitativeMode: userConfig.quantitativeMode || 'conservative', userConfig: userConfig }, 1800, false); // Overwrite state
       await executeAiRequest(bot, chatId);
     } catch (error) { console.error('❌ /ai_quick error:', error); sentryService.captureError(error, { op: '/ai_quick_command' }); await bot.sendMessage(chatId, '❌ Quick AI failed.'); }
  });
}

// Registers all callbacks starting with 'ai_'
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || typeof data !== 'string' || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try { await bot.answerCallbackQuery(cbq.id, { cache_time: 2 }); }
    catch (error) { if (!error.message?.includes("query is too old")) console.error("Error answering callback:", error); }

    // *** Fetch state ONCE at the beginning ***
    let state = await getUserState(chatId) || {};
    const currentStateTTL = 1800; // 30 minutes

    const parts = data.split('_');
    const action = parts[1];
    // *** ADDED LOGGING ***
    console.log(`[AI Callback] Action: ${action}, Data: ${data}, Chat ID: ${chatId}. Initial state keys: ${Object.keys(state)}`);

    try {
      let stateModified = false; // Flag to track if state was changed

      switch (action) {
        case 'page':
          const requestedPage = parseInt(parts[2], 10);
          if (!isNaN(requestedPage)) {
              state.page = requestedPage;
              stateModified = true; // Mark state as modified
              await sendSportSelection(bot, chatId, messageId, state.page);
          } else { console.warn(`[AI Callback] Invalid page: ${data}`); }
          break; // Break here, save happens later if modified

        case 'sport':
          state.sportKey = parts.slice(2).join('_');
          if (!state.sportKey || state.sportKey.length < 3) {
                console.warn(`[AI Callback] Invalid sport key: ${state.sportKey}`);
                await safeEditMessage(chatId, messageId, '❌ Invalid sport. Try again.');
                await sendSportSelection(bot, chatId, messageId, state.page || 0);
                // Don't save invalid state, just break
          } else {
             state.page = 0; // Reset page
             stateModified = true;
             await sendLegSelection(bot, chatId, messageId);
          }
          break; // Break here, save happens later if modified

        case 'legs':
           const numLegs = parseInt(parts[2], 10);
           if (!isNaN(numLegs) && numLegs >= 2 && numLegs <= 8) {
                state.numLegs = numLegs;
                stateModified = true;
                await sendModeSelection(bot, chatId, messageId);
           } else { console.warn(`[AI Callback] Invalid legs: ${data}`); }
          break; // Break here, save happens later if modified

        case 'mode':
           const mode = parts[2];
           if (['web', 'live', 'db'].includes(mode)) {
                state.mode = mode;
                if (!state.userConfig) state.userConfig = await getAIConfig(chatId); // Load config if needed
                stateModified = true;
                await sendBetTypeSelection(bot, chatId, messageId);
           } else { console.warn(`[AI Callback] Invalid mode: ${data}`); }
          break; // Break here, save happens later if modified

        case 'bettype':
           const betType = parts[2];
           if (['moneyline', 'spreads', 'totals', 'props', 'mixed'].includes(betType)) {
                state.betType = betType;
                stateModified = true;
                await sendQuantitativeModeSelection(bot, chatId, messageId);
            } else { console.warn(`[AI Callback] Invalid bet type: ${data}`); }
          break; // Break here, save happens later if modified

         case 'quantitative':
             const quantMode = parts[2];
             if (['conservative', 'aggressive'].includes(quantMode)) {
                 // *** ADDED LOGGING ***
                 console.log(`[AI Callback] QUANT step. State *before* update:`, state);
                 state.quantitativeMode = quantMode;
                 if (!state.userConfig) {
                     console.log(`[AI Callback] Loading userConfig in QUANT step...`);
                     state.userConfig = await getAIConfig(chatId);
                 }
                 stateModified = true; // Mark state modified

                 // *** Save happens AFTER switch block if modified ***
                 // *** EXECUTE REQUEST DIRECTLY ***
                 await executeAiRequest(bot, chatId, messageId); // State saved below if needed
             } else {
                 console.warn(`[AI Callback] Invalid quant mode: ${data}`);
             }
             break; // Break here, save happens later if modified

        case 'back':
          const targetStep = parts[2];
          console.log(`[AI Callback] Navigating back to: ${targetStep}`);
          // No state modification needed for back navigation
          if (targetStep === 'sport') await sendSportSelection(bot, chatId, messageId, state.page || 0);
          else if (targetStep === 'legs') await sendLegSelection(bot, chatId, messageId);
          else if (targetStep === 'mode') await sendModeSelection(bot, chatId, messageId);
          else if (targetStep === 'bettype') await sendBetTypeSelection(bot, chatId, messageId);
          else if (targetStep === 'quantmode') await sendQuantitativeModeSelection(bot, chatId, messageId);
          else console.warn(`[AI Callback] Unknown back target: ${targetStep}`);
          // Break here, no state save needed
          break;

        case 'noop':
             console.log(`[AI Callback] No-op action.`);
             // Break here, no state save needed
             break;

        default:
             console.warn(`[AI Callback] Unknown action: ${action} in data: ${data}`);
             // Break here, no state save needed
             break;
      }

      // *** Save state ONCE after potentially modifying it, if needed ***
      if (stateModified) {
          console.log(`[AI Callback] State modified. Saving state before exiting handler:`, state); // LOG BEFORE SAVE
          const saveResult = await setUserState(chatId, state, currentStateTTL); // Use merge=true (default)
          console.log(`[AI Callback] setUserState result: ${saveResult}.`); // LOG SAVE RESULT

          // *** Optional: Re-read state immediately after save for verification ***
          if (!saveResult) {
              console.error(`[AI Callback] CRITICAL: Failed to save state for chat ${chatId}!`);
              // Attempt to notify user maybe?
          } else {
              const stateCheck = await getUserState(chatId);
              console.log(`[AI Callback] State fetched *immediately after* save:`, stateCheck);
          }
      }

    } catch (error) {
        console.error(`❌ AI callback processing error (Action: ${action}):`, error);
        sentryService.captureError(error, { component: 'ai_handler', operation: `callback_${action}`, chatId, data });
        try {
             await safeEditMessage(chatId, messageId, `❌ Error processing request (${action}). Try again or /ai.`, { parse_mode: 'HTML' });
        } catch { /* Ignore follow-up error */ }
    }
  });
} // End registerAICallbacks

// --- Menu Sending Functions ---
// (sendSportSelection, sendLegSelection, sendModeSelection, sendBetTypeSelection, sendQuantitativeModeSelection remain the same)
async function sendSportSelection(bot, chatId, messageId = null, page = 0) { /* ... implementation ... */
    const sports = await getCachedSports();
    if (!sports || sports.length === 0) { /* handle no sports */ return; }
    const sortedSports = sortSports(sports); const totalPages = Math.ceil(sortedSports.length / PAGE_SIZE); page = Math.max(0, Math.min(page, totalPages - 1));
    const sportsOnPage = pageOf(sortedSports, page); const sportButtons = sportsOnPage.map(s => ({ text: `${getSportEmoji(s.sport_key)} ${escapeHTML(s.sport_title)}`, callback_data: `ai_sport_${s.sport_key}` }));
    const rows = []; for (let i = 0; i < sportButtons.length; i += 2) rows.push(sportButtons.slice(i, i + 2));
    if (totalPages > 1) { const navRow = []; if (page > 0) navRow.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` }); navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'ai_noop' }); if (page < totalPages - 1) navRow.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` }); rows.push(navRow); }
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 1/5:</b> Select sport.`; const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    try { if (messageId) await safeEditMessage(chatId, messageId, text, opts); else await bot.sendMessage(chatId, text, opts); } catch (error) { console.error("Error sendSportSelection:", error); await bot.sendMessage(chatId, "Error displaying sports."); }
}
async function sendLegSelection(bot, chatId, messageId) { /* ... implementation ... */
  const state = await getUserState(chatId); const sportTitle = getSportTitle(state?.sportKey || ''); const legOptions = [2, 3, 4, 5, 6, 7, 8]; const buttons = legOptions.map(num => ({ text: `${num} Legs`, callback_data: `ai_legs_${num}` }));
  const keyboard = []; for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4)); keyboard.push([{ text: '« Back', callback_data: 'ai_back_sport' }]);
  const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Step 2/5:</b> Select legs.`; const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }; await safeEditMessage(chatId, messageId, text, opts);
}
async function sendModeSelection(bot, chatId, messageId) { /* ... implementation ... */
    const state = await getUserState(chatId); const sportTitle = getSportTitle(state?.sportKey || ''); const numLegs = state?.numLegs || '?';
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Legs:</b> ${escapeHTML(numLegs)}\n<b>Step 3/5:</b> Select mode.\n\n🌐 <b>Web:</b> AI researches online.\n📡 <b>Live:</b> Uses live API data + AI.\n💾 <b>DB:</b> Scans data for +EV.`;
    const keyboard = [ [{ text: '🌐 Web', callback_data: 'ai_mode_web'}], [{ text: '📡 Live', callback_data: 'ai_mode_live'}], [{ text: '💾 Database', callback_data: 'ai_mode_db'}], [{ text: '« Back', callback_data: 'ai_back_legs' }] ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }; await safeEditMessage(chatId, messageId, text, opts);
}
async function sendBetTypeSelection(bot, chatId, messageId) { /* ... implementation ... */
    const state = await getUserState(chatId); const sportTitle = getSportTitle(state?.sportKey || ''); const numLegs = state?.numLegs || '?'; const mode = state?.mode || '?';
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Legs:</b> ${escapeHTML(numLegs)}\n<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n<b>Step 4/5:</b> Select bet types.`;
    const betTypes = [ { text: '🎯 Moneyline', callback_data: 'ai_bettype_moneyline'}, { text: '📊 Spreads', callback_data: 'ai_bettype_spreads'}, { text: '📈 Totals', callback_data: 'ai_bettype_totals'}, { text: '🧩 Any/Mixed', callback_data: 'ai_bettype_mixed'} ];
    const keyboard = []; for (let i = 0; i < betTypes.length; i += 2) keyboard.push(betTypes.slice(i, i + 2)); keyboard.push([{ text: '« Back', callback_data: 'ai_back_mode' }]);
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }; await safeEditMessage(chatId, messageId, text, opts);
}
async function sendQuantitativeModeSelection(bot, chatId, messageId) { /* ... implementation ... */
     const state = await getUserState(chatId); const sportTitle = getSportTitle(state?.sportKey || ''); const numLegs = state?.numLegs || '?'; const mode = state?.mode || '?'; const betType = state?.betType || '?';
    const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Legs:</b> ${escapeHTML(numLegs)}\n<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n<b>Bets:</b> ${escapeHTML(betType)}\n<b>Step 5/5:</b> Select approach.\n\n🧐 <b>Conservative:</b> Safer, lower risk/reward.\n🚀 <b>Aggressive:</b> Higher EV focus, more risk.`;
    const keyboard = [ [{ text: '🧐 Conservative', callback_data: 'ai_quantitative_conservative' }], [{ text: '🚀 Aggressive', callback_data: 'ai_quantitative_aggressive' }], [{ text: '« Back', callback_data: 'ai_back_bettype' }] ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }; await safeEditMessage(chatId, messageId, text, opts);
}

// --- AI Execution & Result Display ---

async function executeAiRequest(bot, chatId, messageId = null) {
    let statusMessageId = messageId;
    const startTime = Date.now();

    if (!statusMessageId) { /* ... send initial 'Analyzing...' message ... */
        try { const sent = await bot.sendMessage(chatId, '🤖 <b>Analyzing...</b>', { parse_mode: 'HTML' }); statusMessageId = sent.message_id; }
        catch (sendError) { console.error("Error initial status send:", sendError); sentryService.captureError(sendError, { op: 'execute_InitialSend' }); return; }
    }

    // *** ADDED LOGGING ***
    const state = await getUserState(chatId);
    console.log(`[AI Execute] State fetched inside executeAiRequest:`, state); // LOG STATE AT EXECUTION

    const userConfig = state?.userConfig || await getAIConfig(chatId);
     if (!state?.userConfig) { // Save userConfig if just loaded
         await setUserState(chatId, { ...state, userConfig }, 1800);
     }

    const { sportKey, numLegs, mode, betType, quantitativeMode } = state || {};
    // *** MORE ROBUST CHECK ***
    if (!sportKey || !numLegs || !mode || !betType || !quantitativeMode) {
        console.error(`❌ Incomplete state for AI request. State:`, state);
         await safeEditMessage(chatId, statusMessageId, '❌ Critical error: Parlay configuration lost or incomplete. Please start over using /ai.');
        return;
    }

    // ... (Update status message) ...
    const sportTitle = getSportEmoji(sportKey) + ' ' + getSportTitle(sportKey);
    const statusText = `🤖 <b>Generating ${escapeHTML(sportTitle)} Parlay...</b>\n\n` + `<b>Legs:</b> ${escapeHTML(numLegs)}\n<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n<b>Bets:</b> ${escapeHTML(betType)}\n<b>Approach:</b> ${escapeHTML(quantitativeMode)}\n\n<i>This may take 30-60 seconds...</i>`;
    await safeEditMessage(chatId, statusMessageId, statusText, { parse_mode: 'HTML' });

    try {
        const parlayResult = await aiService.generateParlay(
            sportKey, numLegs, mode, null, betType,
            { quantitativeMode, horizonHours: DEFAULT_HORIZON_HOURS_AI, userConfig: userConfig, chatId: chatId }
        );

         const duration = (Date.now() - startTime) / 1000;
         console.log(`[AI Request] Completed in ${duration.toFixed(1)}s for Chat ID: ${chatId}`);
        await sendParlayResult(bot, chatId, parlayResult, state, statusMessageId);

    } catch (error) {
         const duration = (Date.now() - startTime) / 1000;
         console.error(`❌ AI request execution error after ${duration.toFixed(1)}s (Chat ID: ${chatId}):`, error.message);
         sentryService.captureError(error, { component: 'ai_handler', operation: 'executeAiRequest_Catch', chatId, state: {sportKey, numLegs, mode, betType} }); // Log relevant state only

         let errorMessage = `❌ <b>Parlay Generation Failed</b>\n\n`;
         errorMessage += `Error during analysis.\n\n`;
         errorMessage += `<b>Details:</b> <code>${escapeHTML(String(error.message).substring(0, 200))}</code>\n\n`; // Limit error message length
         errorMessage += `<i>Try again, select a different mode, or check /tools.</i>`;
         const keyboard = [[{ text: '🔄 Try Again', callback_data: `ai_quantitative_${quantitativeMode}` }], [{ text: '« Change Settings', callback_data: 'ai_back_quantmode' }]];
         await safeEditMessage(chatId, statusMessageId, errorMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }});
    }
}


// **UPDATED** function to display the detailed parlay result
async function sendParlayResult(bot, chatId, parlayResult, state, messageId) {
    // ... (This function remains exactly the same as the complete version provided in the previous turn) ...
    // ... It handles rejections, no legs, and formats the successful parlay with EV, risk, stake, etc. ...
    const sportKey = state?.sportKey || 'Unknown'; // Safely access state
    const sportTitle = getSportTitle(sportKey);

    // --- Handle Rejections or Errors ---
    if (!parlayResult || parlayResult.error || parlayResult.summary?.verdict === 'REJECTED' || parlayResult.riskAssessment?.overallRisk === 'REJECTED') {
        const reason = parlayResult?.error || parlayResult?.summary?.primaryAction || parlayResult?.riskAssessment?.risks?.[0]?.message || 'Critical risk/error.';
        console.warn(`[Parlay Result] REJECTED ${sportKey}. Reason: ${reason}`);
        let errorText = `❌ <b>Parlay Rejected</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Reason:</b> ${escapeHTML(String(reason).substring(0, 500))}\n\n` +
                        `<i>${escapeHTML(parlayResult?.recommendations?.primaryAction || 'No suitable parlay. Adjust settings.')}</i>`;
        const keyboard = [ [{ text: '🔄 Try Again', callback_data: `ai_quantitative_${state?.quantitativeMode || 'conservative'}` }], [{ text: '⚙️ Change Settings', callback_data: 'ai_back_sport' }] ];
        await safeEditMessage(chatId, messageId, errorText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        return;
    }

    // --- Handle No Valid Legs ---
    if (!Array.isArray(parlayResult.legs) || parlayResult.legs.length === 0) {
        const reason = parlayResult.portfolio_construction?.overall_thesis || parlayResult.summary?.primaryAction || "No suitable legs found.";
        console.log(`[Parlay Result] No legs found ${sportKey}. Reason: ${reason}`);
        let noLegsText = `🤷 <b>No Parlay Generated</b>\n\n<b>Sport:</b> ${escapeHTML(sportTitle)}\n<b>Reason:</b> ${escapeHTML(String(reason).substring(0, 500))}\n\n` +
                         `<i>Consider broadening criteria or trying another sport.</i>`;
        const keyboard = [[{ text: '⚙️ Change Settings', callback_data: 'ai_back_sport' }]];
        await safeEditMessage(chatId, messageId, noLegsText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        return;
    }

    // --- Format Successful Parlay ---
    const { legs, combined_parlay_metrics, riskAssessment, recommendations, summary, research_metadata } = parlayResult;
    let response = `✅ <b>AI Parlay</b> (${summary?.verdict || 'Complete'})\n<b>Sport:</b> ${getSportEmoji(sportKey)} ${escapeHTML(sportTitle)}\n<b>Mode:</b> ${escapeHTML(research_metadata?.mode?.toUpperCase() || 'N/A')}\n`;
    response += `\n<b>Legs (${legs.length}):</b>\n`;
    legs.forEach((leg, index) => { /* ... Formatting logic for each leg ... */
        const game = escapeHTML(leg.event || 'Unknown'); const pick = escapeHTML(leg.selection || 'Unknown'); const oddsValue = leg.odds?.american ?? leg.price; const oddsStr = (typeof oddsValue === 'number') ? (oddsValue > 0 ? `+${oddsValue}` : `${oddsValue}`) : 'N/A';
        const modelProb = (leg.model_probability !== null) ? `${(leg.model_probability * 100).toFixed(1)}%` : 'N/A'; const legEV = (leg.ev_per_100 !== null) ? `${leg.ev_per_100.toFixed(1)}%` : 'N/A';
        let validationMark = ''; if (research_metadata?.generationStrategy?.includes('web')) validationMark = leg.real_game_validated === false ? '❓' : '✔️';
        response += `${index + 1}) ${validationMark} ${game}\n   <b>Pick:</b> ${pick} (<b>${oddsStr}</b>)\n   <i>Est. Win%:</i> ${modelProb} | <i>Leg EV:</i> ${legEV}\n`;
        if (Array.isArray(leg.injury_gates) && leg.injury_gates.length > 0) { const crit = leg.injury_gates.filter(g => typeof g === 'string' && /\((Q|D|O)\)/i.test(g)); if (crit.length > 0) response += `   <b>⚠️ Injury:</b> ${escapeHTML(crit.join(', ').substring(0,100))}\n`; }
    });
    response += `\n<b>Combined Odds:</b> ${escapeHTML(combined_parlay_metrics?.combined_american_odds || 'N/A')}\n`;
    const combinedProb = combined_parlay_metrics?.combined_probability_product; response += `<b>Est. Parlay Win%:</b> ${typeof combinedProb === 'number' ? (combinedProb * 100).toFixed(1) + '%' : 'N/A'}\n`;
    const overallEV = combined_parlay_metrics?.parlay_ev_per_100; response += `<b>Overall EV:</b> <b>${typeof overallEV === 'number' ? overallEV.toFixed(1) + '%' : 'N/A'}</b> ${typeof overallEV === 'number'?(overallEV > 0 ? '📈':'📉'):''}\n`;
    response += `<b>Risk Level:</b> ${escapeHTML(riskAssessment?.overallRisk || 'UNK')}\n`;
    const recommendedStake = combined_parlay_metrics?.kelly_stake?.bankroll_allocation_percent; if (typeof recommendedStake === 'number') response += `<b>Rec. Stake:</b> ${recommendedStake.toFixed(1)}% BK\n`;
    response += `\n<b>Action: ${escapeHTML(recommendations?.primaryAction || 'Review')}</b>\n`;
    if (Array.isArray(riskAssessment?.risks) && riskAssessment.risks.length > 0) { const imp = riskAssessment.risks.filter(r => r.severity === 'HIGH' || r.severity === 'CRITICAL').slice(0, 2); if (imp.length > 0) response += `<i>Key Risks: ${escapeHTML(imp.map(r => r.message || r.type).join('; '))}</i>\n`; else response += `<i>Risk Note: ${escapeHTML(riskAssessment.risks[0].message || riskAssessment.risks[0].type)}</i>\n`; }
    const validationRate = research_metadata?.validationRate; const isFallback = research_metadata?.fallback_used;
    if (isFallback) response += `\n<i>⚠️ Fallback Mode. Data estimated. Verify odds.</i>`; else if (typeof validationRate === 'number' && validationRate < 0.8) response += `\n<i>⚠️ Low validation (${(validationRate * 100).toFixed(0)}%). Verify odds.</i>`;
    const finalKeyboard = [[{ text: '🔄 Build Another', callback_data: 'ai_back_sport' }]];
    try { await safeEditMessage(chatId, messageId, response, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } }); }
    catch (editError) { console.error("Error final edit:", editError); try { await bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } }); } catch {} }
}
