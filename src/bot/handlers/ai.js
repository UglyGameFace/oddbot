// src/bot/handlers/ai.js

import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState } from '../state.js';
import { getSportEmoji } from '../../utils/enterpriseUtilities.js';

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
  const sportsRaw = await gamesService.getAvailableSports();
  const sports = sortSports((sportsRaw || []).filter(s => s?.sport_key));
  if (!sports?.length) return bot.sendMessage(chatId, 'No games in DB to analyze.');

  const totalPages = Math.max(1, Math.ceil(sports.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), totalPages - 1);

  const slice = pageOf(sports, page).map(s => {
    const title = s?.sport_title ?? SPORT_TITLES[s.sport_key] ?? s.sport_key;
    return { text: `${getSportEmoji(s.sport_key)} ${title}`, callback_data: `ai_sport_${s.sport_key}` };
  });

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));

  const nav = [];
  if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
  if (nav.length) rows.push(nav);

  const text = '🤖 *AI Parlay Builder*\n\n*Step 1:* Select a sport.';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
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
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendModeSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 3:* Select an analysis mode.';
  const keyboard = [
    [{ text: '🌐 Web Research Only', callback_data: 'ai_mode_web' }],
    [{ text: '📡 Live API Data (Best)', callback_data: 'ai_mode_live' }],
    [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db' }],
    [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 4:* What kind of parlay should I build?';
  const keyboard = [
    [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props' }],
    [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed' }],
    [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendAiModelSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 5:* Choose your Research AI.\n\n*Gemini is creative and great at finding narrative connections. Perplexity is fast, direct, and focuses on hard data.*';
  const keyboard = [
    [{ text: '🧠 Gemini (Creative)', callback_data: 'ai_model_gemini' }],
    [{ text: '⚡ Perplexity (Data-Focused)', callback_data: 'ai_model_perplexity' }],
    [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function executeAiRequest(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const { sportKey, numLegs, mode, betType, aiModel = 'gemini' } = state;

  if (!sportKey || !numLegs || !mode || !betType) {
    return bot.editMessageText('Incomplete selection. Please start over using /ai.', { chat_id: chatId, message_id: messageId });
  }

  let modeText = { web: 'Web Research', live: 'Live API Data', db: 'Database Only' }[mode];
  if (mode === 'web') modeText += ` via ${aiModel.charAt(0).toUpperCase() + aiModel.slice(1)}`;
  const betTypeText = betType === 'props' ? 'Player Props Only' : 'Mixed';

  await bot.editMessageText(
    `🤖 Accessing advanced analytics...\n\n*Sport:* ${sportKey}\n*Legs:* ${numLegs}\n*Mode:* ${modeText}\n*Type:* ${betTypeText}\n\nThis may take a moment.`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: null }
  );

  try {
    const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType);
    if (!parlay || !parlay.parlay_legs || !parlay.parlay_legs.length === 0) throw new Error('AI returned an empty or invalid parlay.');

    let response = `🧠 *AI-Generated ${numLegs}-Leg Parlay*\n*Mode: ${modeText}*\n*Type: ${betTypeText}*\n*Confidence: ${Math.round((parlay.confidence_score || 0) * 100)}%*\n\n`;
    parlay.parlay_legs.forEach((leg, index) => {
      response += `*Leg ${index + 1}:* ${leg.game}\n*Pick:* **${leg.pick} (${leg.market})**\n`;
      if (leg.sportsbook) response += `*Book:* ${leg.sportsbook}\n`;
      response += `*Justification:* ${leg.justification}\n\n`;
    });

    const finalKeyboard = [[{ text: 'Build Another AI Parlay', callback_data: 'ai_back_sport' }]];
    await bot.editMessageText(response, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: finalKeyboard } });
  } catch (error) {
    console.error('AI handler execution error:', error);
    await bot.editMessageText('❌ I encountered a critical error. Please try again later.', {
      chat_id: chatId, message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_back_sport' }]] }
    });
  } finally {
    await setUserState(chatId, {});
  }
}
