// src/bot/handlers/ai.js

import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState } from '../state.js';
import { getSportEmoji } from '../../utils/enterpriseUtilities.js';

// --- Main command to start the AI flow ---
export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    // Reset any previous state and start the flow
    await setUserState(chatId, {}); 
    sendSportSelection(bot, chatId);
  });
}

// --- Callback handler for all button presses in the AI flow ---
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

    const state = await getUserState(chatId) || {};
    const parts = data.split('_');
    const action = parts[1];

    if (action === 'sport') {
      state.sportKey = parts.slice(2).join('_');
      await setUserState(chatId, state);
      sendLegSelection(bot, chatId, message.message_id);
    }

    if (action === 'legs') {
      state.numLegs = parseInt(parts[2], 10);
      await setUserState(chatId, state);
      sendModeSelection(bot, chatId, message.message_id);
    }

    if (action === 'mode') {
      state.mode = parts[2];
      await setUserState(chatId, state);
      // This is the final step, execute the request
      executeAiRequest(bot, chatId, message.message_id, state);
    }

    if (action === 'back') {
        const to = parts[2];
        if (to === 'sport') sendSportSelection(bot, chatId, message.message_id);
    }
  });
}

// --- UI Functions ---

async function sendSportSelection(bot, chatId, messageId = null) {
  const sports = await gamesService.getAvailableSports();
  if (!sports?.length) {
    return bot.sendMessage(chatId, 'No upcoming games found in the database. The data ingestion worker may need to run.');
  }

  const buttons = sports.map(sport => ({
    text: `${getSportEmoji(sport.sport_key)} ${sport.sport_title}`,
    callback_data: `ai_sport_${sport.sport_key}`
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
  }
  
  const text = "🤖 *AI Parlay Builder*\n\n*Step 1:* Select a sport.";
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function sendLegSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = (state.sportKey || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const legOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10]; 
  const buttons = legOptions.map(num => ({
    text: `${num} Legs`,
    callback_data: `ai_legs_${num}`
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
      keyboard.push(buttons.slice(i, i + 3));
  }
  keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);

  const text = `🤖 *AI Parlay Builder*\n\n*Step 2:* How many legs for your ${sportTitle} parlay?`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendModeSelection(bot, chatId, messageId) {
    const text = `🤖 *AI Parlay Builder*\n\n*Step 3:* Select an analysis mode.`;
    const keyboard = [
        [{ text: '🌐 Web Research Only', callback_data: 'ai_mode_web' }],
        [{ text: '📡 Live API Data (Best)', callback_data: 'ai_mode_live' }],
        [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db' }],
        [{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}


// --- Execution Function ---

async function executeAiRequest(bot, chatId, messageId, state) {
    const { sportKey, numLegs, mode } = state;
    const modeText = {
        web: 'Web Research',
        live: 'Live API Data',
        db: 'Database Only'
    }[mode];

    await bot.editMessageText(`🤖 Accessing advanced analytics...\n\n*Sport:* ${sportKey}\n*Legs:* ${numLegs}\n*Mode:* ${modeText}\n\nThis may take a moment.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: null // Remove buttons
    });

    try {
      const parlay = await aiService.generateParlay(sportKey, numLegs, mode);
      if (!parlay || !parlay.parlay_legs || parlay.parlay_legs.length === 0) {
        throw new Error('AI returned an empty or invalid parlay.');
      }

      let response = `🧠 *AI-Generated ${numLegs}-Leg Parlay*\n`;
      response += `*Mode: ${modeText}*\n`;
      response += `*Confidence: ${Math.round((parlay.confidence_score || 0) * 100)}%*\n\n`;

      parlay.parlay_legs.forEach((leg, index) => {
        response += `*Leg ${index + 1}:* ${leg.game}\n`;
        response += `*Pick:* **${leg.pick} (${leg.market})**\n`;
        if (leg.sportsbook) response += `*Book:* ${leg.sportsbook}\n`;
        response += `*Justification:* ${leg.justification}\n\n`;
      });

      // Add a final button to restart the flow
      const finalKeyboard = [[{ text: 'Build Another AI Parlay', callback_data: 'ai_back_sport' }]];
      await bot.editMessageText(response, { 
          chat_id: chatId, 
          message_id: messageId, 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: finalKeyboard }
      });

    } catch (error) {
      console.error('AI handler execution error:', error);
      await bot.editMessageText('❌ I encountered a critical error while consulting the AI. The reasoning engine may be offline. Please try again later.', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_back_sport' }]] }
      });
    } finally {
        // Clear state after execution
        await setUserState(chatId, {});
    }
}
