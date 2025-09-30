// src/bot/handlers/ai.js

import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import databaseService from '../../services/databaseService.js'; // NEW
import { setUserState, getUserState } from '../state.js';
import { getSportEmoji, escapeMarkdownV2 } from '../../utils/enterpriseUtilities.js';

// ---- Safe edit helper ----
async function safeEditMessage(bot, text, options) {
  try {
    await bot.editMessageText(text, options);
  } catch (error) {
    if (error?.message?.includes('message is not modified')) {
      // benign
    } else {
      console.error('editMessageText error:', error?.message || error);
    }
  }
}

const propsToggleLabel = (on) => `${on ? '✅' : '☑️'} Include Player Props`;

const SPORT_TITLES = {
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  baseball_mlb: 'MLB',
  football_nfl: 'NFL',
  hockey_nhl: 'NHL',
  icehockey_nhl: 'NHL',
  football_ncaaf: 'NCAAF',
  americanfootball_ncaaf: 'NCAAF',
};
const PREFERRED_FIRST = ['football_ncaaf', 'americanfootball_ncaaf'];
const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];
const PAGE_SIZE = 10;

// NEW: last-resort static fallback sports
const DEFAULT_SPORTS = [
  { sport_key: 'americanfootball_nfl', sport_title: 'NFL' },
  { sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF' },
  { sport_key: 'basketball_nba', sport_title: 'NBA' },
  { sport_key: 'basketball_wnba', sport_title: 'WNBA' },
  { sport_key: 'baseball_mlb', sport_title: 'MLB' },
  { sport_key: 'icehockey_nhl', sport_title: 'NHL' },
];

function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  return [...(sports || [])].sort(
    (a, b) => rank(a?.sport_key || '') - rank(b?.sport_key || '')
  );
}
function pageOf(arr, page) { const start = page * PAGE_SIZE; return arr.slice(start, start + PAGE_SIZE); }
function formatLocalIfPresent(utc, tzLabel) {
  try {
    if (!utc) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tzLabel || 'America/New_York',
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(utc));
  } catch { return ''; }
}

export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    await setUserState(chatId, { page: 0 });
    sendSportSelection(bot, chatId);
  });
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

    let state = await getUserState(chatId) || {};
    const parts = data.split('_');
    const action = parts[1];

    if (action === 'page') {
      const page = parseInt(parts[2], 10) || 0;
      state.page = page;
      await setUserState(chatId, state);
      return sendSportSelection(bot, chatId, message.message_id, page);
    }

    if (action === 'sport') {
      state.sportKey = parts.slice(2).join('_');
      await setUserState(chatId, state);
      sendLegSelection(bot, chatId, message.message_id);
    } else if (action === 'legs') {
      state.numLegs = parseInt(parts[2], 10);
      await setUserState(chatId, state);
      sendModeSelection(bot, chatId, message.message_id);
    } else if (action === 'mode') {
      state.mode = parts[2];
      await setUserState(chatId, state);
      if (state.mode === 'db') {
        state.betType = 'mixed';
        await setUserState(chatId, state);
        executeAiRequest(bot, chatId, message.message_id);
      } else {
        sendBetTypeSelection(bot, chatId, message.message_id);
      }
    } else if (action === 'bettype') {
      state.betType = parts[2];
      await setUserState(chatId, state);
      if (state.mode === 'web') {
        sendAiModelSelection(bot, chatId, message.message_id);
      } else {
        executeAiRequest(bot, chatId, message.message_id);
      }
    } else if (action === 'model') {
      state.aiModel = parts[2];
      await setUserState(chatId, state);
      executeAiRequest(bot, chatId, message.message_id);
    } else if (action === 'toggle') {
      const what = parts[2];
      if (what === 'props') {
        state.includeProps = !state.includeProps;
        await setUserState(chatId, state);
        return sendBetTypeSelection(bot, chatId, message.message_id);
      }
    } else if (action === 'back') {
      const to = parts[2];
      if (to === 'sport') sendSportSelection(bot, chatId, message.message_id, state.page || 0);
      if (to === 'legs') sendLegSelection(bot, chatId, message.message_id);
      if (to === 'mode') sendModeSelection(bot, chatId, message.message_id);
      if (to === 'bettype') sendBetTypeSelection(bot, chatId, message.message_id);
    }
  });
}

async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
  // 1) Primary: gamesService
  let sportsRaw = [];
  try {
    sportsRaw = await gamesService.getAvailableSports();
  } catch {
    sportsRaw = [];
  }
  let sports = sortSports((sportsRaw || []).filter(s => s?.sport_key));

  // 2) Fallback: databaseService comprehensive list
  if (!sports.length) {
    try {
      const dbList = await databaseService.getDistinctSports();
      sports = sortSports((dbList || []).filter(s => s?.sport_key));
    } catch {
      // ignore
    }
  }

  // 3) Last resort: static defaults
  if (!sports.length) {
    sports = DEFAULT_SPORTS;
  }

  const totalPages = Math.max(1, Math.ceil(sports.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), totalPages - 1);

  const slice = pageOf(sports, page).map(s => {
    const title = s?.sport_title ?? SPORT_TITLES[s.sport_key] ?? s.sport_key;
    return { text: `${getSportEmoji(s.sport_key)} ${title}`, callback_data: `ai_sport_${s.sport_key}` };
  });

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
    if (nav.length) rows.push(nav);
  }

  const text = '🤖 *AI Parlay Builder*\n\n*Step 1:* Select a sport.';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };

  if (messageId) await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
  else await bot.sendMessage(chatId, text, opts);
}

async function sendLegSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = (state.sportKey || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const legOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const buttons = legOptions.map(num => ({ text: `${num} Legs`, callback_data: `ai_legs_${num}` }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));
  keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);
  const text = `🤖 *AI Parlay Builder*\n\n*Step 2:* How many legs for your ${sportTitle} parlay?`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendModeSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 3:* Select an analysis mode.';
  const keyboard = [
    [{ text: '🌐 Web Research (Recommended)', callback_data: 'ai_mode_web' }],
    [{ text: '📡 Live API Data (Requires Quota)', callback_data: 'ai_mode_live' }],
    [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db' }],
    [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId) || {};
  const text = '🤖 *AI Parlay Builder*\n\n*Step 4:* What kind of parlay should I build?';
  const keyboard = [
    [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props' }],
    [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed' }],
    [{ text: propsToggleLabel(!!state.includeProps), callback_data: 'ai_toggle_props' }],
    [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendAiModelSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 5:* Choose your Research AI.\n\n*Gemini is creative and great at finding narrative connections. Perplexity is fast, direct, and focuses on hard data.*';
  const keyboard = [
    [{ text: '🧠 Gemini (Creative)', callback_data: 'ai_model_gemini' }],
    [{ text: '⚡ Perplexity (Data-Focused)', callback_data: 'ai_model_perplexity' }],
    [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function executeAiRequest(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const { sportKey, numLegs, mode, betType, aiModel = 'gemini', includeProps = false } = state || {};

  if (!sportKey || !numLegs || !mode || !betType) {
    return safeEditMessage(bot, 'Incomplete selection. Please start over using /ai.', { chat_id: chatId, message_id: messageId });
  }

  let modeText = { web: 'Web Research', live: 'Live API Data', db: 'Database Only' }[mode];
  if (mode === 'web') modeText += ` via ${aiModel.charAt(0).toUpperCase() + aiModel.slice(1)}`;
  const betTypeText = betType === 'props' ? 'Player Props Only' : 'Mixed';

  const safeSportKey = escapeMarkdownV2(sportKey);
  const safeModeText = escapeMarkdownV2(modeText);
  const safeBetTypeText = escapeMarkdownV2(betTypeText);
  const safeIncludeProps = escapeMarkdownV2(includeProps ? 'On' : 'Off');

  await safeEditMessage(
    bot,
    `🤖 Accessing advanced analytics\\.\\.\\.\\n\\n*Sport:* ${safeSportKey}\\n*Legs:* ${numLegs}\\n*Mode:* ${safeModeText}\\n*Type:* ${safeBetTypeText}\\n*Props:* ${safeIncludeProps}\\n\\nThis may take a moment\\.`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', reply_markup: null }
  );

  try {
    const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, { includeProps });
    if (!parlay || !parlay.parlay_legs || parlay.parlay_legs.length === 0) {
      throw new Error('AI returned an empty or invalid parlay. This can happen if no games are found for the selected sport.');
    }

    const legs = parlay.parlay_legs;
    const tzLabel = 'America/New_York';
    const headerLine = legs.every(l => l.game_date_local || l.game_date_utc)
      ? `Timezone: ${escapeMarkdownV2(tzLabel)}`
      : null;

    let response = `🧠 *AI\\-Generated ${numLegs}\\-Leg Parlay*\\n*Mode: ${safeModeText}*\\n*Type: ${safeBetTypeText}*\\n*Confidence: ${Math.round((parlay.confidence_score || 0) * 100)}%*`;
    if (headerLine) response += `\n_${headerLine}_`;
    response += `\n\n`;

    legs.forEach((leg, index) => {
      const when = leg.game_date_local
        ? leg.game_date_local
        : (leg.game_date_utc ? formatLocalIfPresent(leg.game_date_utc, tzLabel) : '');
      const safeGame = escapeMarkdownV2(leg.game + (when ? ` — ${when}` : ''));
      const safePick = escapeMarkdownV2(leg.pick);
      const safeMarket = escapeMarkdownV2(leg.market);
      const safeBook = leg.sportsbook ? escapeMarkdownV2(leg.sportsbook) : '';
      const safeJustification = escapeMarkdownV2(leg.justification || '');

      response += `*Leg ${index + 1}:* ${safeGame}\n*Pick:* *${safePick}* \\(${safeMarket}\\)\n`;
      if (leg.sportsbook) response += `*Book:* ${safeBook}\n`;
      if (safeJustification) response += `*Justification:* ${safeJustification}\n`;
      response += `\n`;
    });

    const finalKeyboard = [[{ text: 'Build Another AI Parlay', callback_data: 'ai_back_sport' }]];
    await safeEditMessage(bot, response, {
      chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: finalKeyboard }
    });

  } catch (error) {
    console.error('AI handler execution error:', error);
    const safeError = escapeMarkdownV2(error.message || 'Unknown error');
    await safeEditMessage(bot, `❌ I encountered a critical error: \`${safeError}\`\\.\\nPlease try again later, or select the Web Research mode which does not depend on live API data\\.`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_back_sport' }]] }
    });
  } finally {
    await setUserState(chatId, {});
  }
}
