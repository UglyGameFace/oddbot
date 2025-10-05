// src/bot/handlers/chat.js - FINALIZED AND CORRECTED

import { getUserState, setUserState } from '../state.js';
import rateLimitService from '../../services/rateLimitService.js';
import env from '../../config/env.js';
import aiService from '../../services/aiService.js';
import axios from 'axios';

const MAX_TELEGRAM = 3800;

function chunk(text, size = MAX_TELEGRAM) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function toCompact(text, limit = 700) {
  if (!text || text.length <= limit) return { head: text, tail: null };
  return { head: text.slice(0, limit) + '…', tail: text.slice(limit) };
}

function trimContext(messages, maxChars = 6000) {
  const out = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const sz = (m.content || '').length + 20;
    if (total + sz > maxChars) break;
    out.unshift(m);
    total += sz;
  }
  return out;
}

async function completeChat(model, messages) {
  if (typeof aiService.genericChat === 'function') {
    return await aiService.genericChat(model, messages);
  }
  const resp = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: model === 'perplexity' ? 'sonar-pro' : 'sonar-small-chat',
      messages: [
        { role: 'system', content: 'Be concise. Return plain text without code fences.' },
        ...messages
      ],
    },
    { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 45000 }
  );
  return resp?.data?.choices?.[0]?.message?.content || 'No response.';
}

export function registerChat(bot) {
  bot.onText(/^\/chat(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    const rl = await rateLimitService.checkRateLimit(chatId, 'user', 'chat_open');
    if (!rl.allowed) return bot.sendMessage(chatId, 'Rate limit reached. Try again shortly.');

    const currentState = await getUserState(chatId);
    const newState = {
      ...currentState,
      chat: {
        model: 'perplexity',
        compact: true,
        history: [],
        lastMessageId: null,
        pendingChunks: [],
      },
    };
    await setUserState(chatId, newState, 1800);

    const starter = (match && match[1]) ? match[1].trim() : '';
    const text = starter
      ? '💬 Chat mode started.\nAsk: ' + starter
      : '💬 Chat mode started.\nSend a message to begin.';

    const keyboard = [
      [{ text: 'Toggle Compact', callback_data: 'chat_toggle_compact' }],
      [{ text: 'End Chat', callback_data: 'chat_end' }]
    ];

    const sent = await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    
    const finalState = await getUserState(chatId);
    if (finalState.chat) {
      finalState.chat.lastMessageId = sent.message_id;
      await setUserState(chatId, finalState, 1800);
    }

    if (starter) {
      await handleUserChat(bot, chatId, starter);
    }
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;
    const state = await getUserState(chatId);
    if (!state.chat) return;
    await handleUserChat(bot, chatId, msg.text);
  });
}

// FIX: Exporting a dedicated callback handler for centralization.
export function registerChatCallbacks(bot) {
    bot.on('callback_query', async (cbq) => {
        const { data, message } = cbq || {};
        if (!data || !message || !data.startsWith('chat_')) return;
        
        const chatId = message.chat.id;
        await bot.answerCallbackQuery(cbq.id);

        const state = await getUserState(chatId) || {};
        if (!state.chat) return;

        if (data === 'chat_toggle_compact') {
            state.chat.compact = !state.chat.compact;
            await setUserState(chatId, state, 1800);
            return bot.sendMessage(chatId, `Compact mode: ${state.chat.compact ? 'ON' : 'OFF'}`);
        }
        if (data === 'chat_end') {
            state.chat = null;
            await setUserState(chatId, state, 60);
            return bot.sendMessage(chatId, 'Chat ended.');
        }
        if (data.startsWith('chat_more_')) {
            const idx = Number(data.split('_').pop());
            const pending = state.chat?.pendingChunks?.[idx];
            if (!pending) return;
            const chunks = chunk(pending);
            for (const c of chunks) {
                await bot.sendMessage(chatId, c, { parse_mode: 'Markdown' });
            }
            return;
        }
    });
}

async function handleUserChat(bot, chatId, userText) {
  const rl = await rateLimitService.checkRateLimit(chatId, 'user', 'chat_msg');
  if (!rl.allowed) return bot.sendMessage(chatId, 'Rate limit reached. Try again shortly.');

  let state = await getUserState(chatId);
  if (!state.chat) return;

  state.chat.history.push({ role: 'user', content: userText });
  state.chat.history = trimContext(state.chat.history, 6000);
  await setUserState(chatId, state, 1800);

  try {
    const reply = await completeChat(state.chat.model, state.chat.history);
    const { head, tail } = toCompact(reply, state.chat.compact ? 700 : 1800);
    const chunks = chunk(head, MAX_TELEGRAM);

    let moreButton = null;
    if (tail) {
      if (!Array.isArray(state.chat.pendingChunks)) state.chat.pendingChunks = [];
      const idx = state.chat.pendingChunks.push(tail) - 1;
      moreButton = [{ text: 'More', callback_data: `chat_more_${idx}` }];
    }
    
    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const keyboard = [
        [{ text: 'Toggle Compact', callback_data: 'chat_toggle_compact' }, { text: 'End Chat', callback_data: 'chat_end' }]
      ];

      if (isLastChunk && moreButton) {
        keyboard.unshift(moreButton);
      }
      
      const options = {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      };

      await bot.sendMessage(chatId, chunks[i], isLastChunk ? options : { parse_mode: 'Markdown' });
    }

    let finalState = await getUserState(chatId);
    if(finalState.chat) {
        finalState.chat.history.push({ role: 'assistant', content: reply });
        finalState.chat.history = trimContext(finalState.chat.history, 6000);
        await setUserState(chatId, finalState, 1800);
    }
  } catch (e) {
    console.error('Chat handler error:', e?.message || e);
    await bot.sendMessage(chatId, 'An error occurred in chat. Please try again.');
  }
}
