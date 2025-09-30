// src/bot/handlers/chat.js

import { getUserState, setUserState } from '../state.js';
import rateLimitService from '../../services/rateLimitService.js';
import env from '../../config/env.js';
import aiService from '../../services/aiService.js';
import axios from 'axios';

// Telegram hard cap ~4096, keep margin for markup/buttons
const MAX_TELEGRAM = 3800;

// Split long text for Telegram safely (no nested lists, keeps MarkdownV2)
function chunk(text, size = MAX_TELEGRAM) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

// Compact, default-on concision; user can expand with "More"
function toCompact(text, limit = 700) {
  if (!text || text.length <= limit) return { head: text, tail: null };
  return { head: text.slice(0, limit) + '…', tail: text.slice(limit) };
}

// Minimal context buffer by characters (token-light)
function trimContext(messages, maxChars = 6000) {
  const out = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const sz = (m.content || '').length + 20;
    if (total + sz > maxChars) break;
    out.push(m);
    total += sz;
  }
  return out.reverse();
}

// Generic chat completion using aiService if available; Perplexity fallback
async function completeChat(model, messages) {
  if (typeof aiService.genericChat === 'function') {
    return await aiService.genericChat(model, messages);
  }
  // Perplexity fallback (concise answers, no markdown fences)
  const resp = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: model === 'perplexity' ? 'sonar-pro' : 'sonar-small-chat',
      messages: [
        { role: 'system', content: 'Be concise by default, expand only on request. Return plain text without code fences.' },
        ...messages
      ],
    },
    { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 45000 }
  );
  return resp?.data?.choices?.[0]?.message?.content || 'No response.';
}

export function registerChat(bot) {
  // Entry command
  bot.onText(/^\/chat(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    const rl = await rateLimitService.checkRateLimit(chatId, 'user', 'chat_open');
    if (!rl.allowed) return bot.sendMessage(chatId, 'Rate limit reached. Try again shortly.');

    const state = await getUserState(chatId);
    state.chat = {
      model: 'perplexity',       // default; could be 'gemini' if preferred
      compact: true,             // default concise
      history: [],               // [{role, content}]
      lastMessageId: null,
    };
    await setUserState(chatId, state, 1800);

    const starter = (match && match[1]) ? match[1].trim() : '';
    const text = starter
      ? '💬 Chat mode started.\nSend messages anytime. Compact replies are on by default.\n\nAsk: ' + starter
      : '💬 Chat mode started.\nSend a message to begin.\nCompact replies are on by default.';

    const keyboard = [
      [{ text: 'Toggle Compact', callback_data: 'chat_toggle_compact' }],
      [{ text: 'End Chat', callback_data: 'chat_end' }]
    ];

    const sent = await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    const s2 = await getUserState(chatId);
    s2.chat.lastMessageId = sent.message_id;
    await setUserState(chatId, s2, 1800);

    if (starter) {
      await handleUserChat(bot, chatId, starter);
    }
  });

  // Inline controls
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
        await bot.sendMessage(chatId, c, { parse_mode: 'MarkdownV2' });
      }
      return;
    }
  });

  // Route normal messages to chat if chat is active
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;
    const state = await getUserState(chatId);
    if (!state.chat) return; // not in chat mode
    await handleUserChat(bot, chatId, msg.text);
  });
}

async function handleUserChat(bot, chatId, userText) {
  const rl = await rateLimitService.checkRateLimit(chatId, 'user', 'chat_msg');
  if (!rl.allowed) return bot.sendMessage(chatId, 'Rate limit reached. Try again shortly.');

  const state = await getUserState(chatId);
  const cfg = state.chat || { model: 'perplexity', compact: true, history: [] };

  cfg.history.push({ role: 'user', content: userText });
  cfg.history = trimContext(cfg.history, 6000);
  await setUserState(chatId, { ...state, chat: cfg }, 1800);

  try {
    const reply = await completeChat(cfg.model, [{ role: 'system', content: 'Be concise and factual. Cite stats and dates, but keep answers short by default.' }, ...cfg.history]);

    const { head, tail } = toCompact(reply, cfg.compact ? 700 : 1800);
    const chunks = chunk(head, MAX_TELEGRAM);

    // Track any overflow for “More”
    const s2 = await getUserState(chatId);
    s2.chat.pendingChunks = s2.chat.pendingChunks || [];
    let moreButton = null;
    if (tail) {
      const idx = s2.chat.pendingChunks.push(tail) - 1;
      moreButton = [{ text: 'More', callback_data: `chat_more_${idx}` }];
    }
    await setUserState(chatId, s2, 1800);

    // Send main content
    for (let i = 0; i < chunks.length; i++) {
      const extra = (i === chunks.length - 1 && moreButton) ? { reply_markup: { inline_keyboard: [moreButton, [{ text: 'Toggle Compact', callback_data: 'chat_toggle_compact' }, { text: 'End Chat', callback_data: 'chat_end' }]] } } : {};
      await bot.sendMessage(chatId, chunks[i], { parse_mode: 'MarkdownV2', ...extra });
    }

    // Save assistant reply into context
    const st3 = await getUserState(chatId);
    st3.chat.history.push({ role: 'assistant', content: reply });
    st3.chat.history = trimContext(st3.chat.history, 6000);
    await setUserState(chatId, st3, 1800);

  } catch (e) {
    console.error('Chat error:', e?.message || e);
    await bot.sendMessage(chatId, 'Chat failed. Please try again shortly.');
  }
}
