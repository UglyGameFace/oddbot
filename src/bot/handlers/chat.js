// src/bot/handlers/chat.js - FINALIZED AND CORRECTED WITH FACT-CHECKING

import { getUserState, setUserState } from '../state.js';
import rateLimitService from '../../services/rateLimitService.js';
import env from '../../config/env.js';
import aiService from '../../services/aiService.js';
import axios from 'axios';

const MAX_TELEGRAM = 3800;

// Enhanced validation for chat responses
class ChatResponseValidator {
  static validateBettingAdvice(text) {
    const warnings = [];
    
    // Check for player-team mismatches
    const playerTeamMismatches = [
      { player: 'aaron rodgers', teams: ['new york jets'] },
      { player: 'ja\'marr chase', teams: ['cincinnati bengals'] },
      { player: 'd.k. metcalf', teams: ['seattle seahawks'] },
      { player: 'patrick mahomes', teams: ['kansas city chiefs'] }
    ];
    
    playerTeamMismatches.forEach(({ player, teams }) => {
      if (text.toLowerCase().includes(player)) {
        const hasCorrectTeam = teams.some(team => text.toLowerCase().includes(team));
        if (!hasCorrectTeam) {
          warnings.push(`Player ${player} mentioned without correct team context`);
        }
      }
    });

    // Check for implausible betting lines
    const implausiblePatterns = [
      /under\s+[0-4]\.?[0-9]?\s+points/i,
      /over\s+[6-9][0-9]\.?[0-9]?\s+points/i,
      /total\s+points?\s+under\s+[0-9]\.?[0-9]?/i
    ];
    
    implausiblePatterns.forEach(pattern => {
      if (pattern.test(text)) {
        warnings.push('Implausible betting line detected');
      }
    });

    // Check for contradictions
    if ((text.includes('under') && text.includes('over')) || 
        (text.includes('favorite') && text.includes('underdog'))) {
      const underIndex = text.toLowerCase().indexOf('under');
      const overIndex = text.toLowerCase().indexOf('over');
      if (Math.abs(underIndex - overIndex) < 200) { // If they appear close together
        warnings.push('Contradictory betting advice detected');
      }
    }

    return warnings;
  }

  static factCheckResponse(text) {
    const warnings = this.validateBettingAdvice(text);
    
    if (warnings.length > 0) {
      console.warn('Chat response validation warnings:', warnings);
      return {
        valid: false,
        warnings,
        correctedText: text + `\n\n⚠️ *Fact-Checking Note:* This response contains potential inaccuracies. Please verify with official sources.`
      };
    }
    
    return { valid: true, warnings: [] };
  }
}

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
  
  // Add fact-checking instructions to system message
  const enhancedMessages = [
    { 
      role: 'system', 
      content: 'Be concise. Return plain text without code fences. IMPORTANT: When discussing sports betting, always verify player-team alignments and use realistic betting lines. Never suggest implausible scenarios like Aaron Rodgers playing for teams other than the Jets.' 
    },
    ...messages
  ];
  
  const resp = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: model === 'perplexity' ? 'sonar-pro' : 'sonar-small-chat',
      messages: enhancedMessages,
    },
    { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 45000 }
  );
  
  let responseText = resp?.data?.choices?.[0]?.message?.content || 'No response.';
  
  // Apply fact-checking to response
  const factCheck = ChatResponseValidator.factCheckResponse(responseText);
  if (!factCheck.valid) {
    responseText = factCheck.correctedText;
  }
  
  return responseText;
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
    
    // Add fact-checking disclaimer for betting-related queries
    let finalReply = reply;
    const bettingKeywords = ['bet', 'odds', 'parlay', 'moneyline', 'spread', 'total', 'over', 'under'];
    const isBettingQuery = bettingKeywords.some(keyword => 
      userText.toLowerCase().includes(keyword)
    );
    
    if (isBettingQuery) {
      const factCheck = ChatResponseValidator.validateBettingAdvice(reply);
      if (factCheck.length > 0) {
        finalReply += `\n\n⚠️ *Automated Fact-Checking:* Some information may require verification.`;
      }
    }

    const { head, tail } = toCompact(finalReply, state.chat.compact ? 700 : 1800);
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
      
      // Add fact-check info button for betting queries
      if (isLastChunk && isBettingQuery) {
        keyboard.push([{ text: '🔍 Fact-Check Info', callback_data: 'chat_fact_check_info' }]);
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
    
    let errorMessage = 'An error occurred in chat. Please try again.';
    if (e.message.includes('API key') || e.message.includes('authentication')) {
      errorMessage = 'AI service is currently unavailable. Please try again later.';
    } else if (e.message.includes('timeout')) {
      errorMessage = 'The AI response took too long. Please try a simpler question.';
    }
    
    await bot.sendMessage(chatId, errorMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Try Again', callback_data: 'chat_retry' }],
          [{ text: 'End Chat', callback_data: 'chat_end' }]
        ]
      }
    });
  }
}

// Add retry functionality
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
        if (data === 'chat_fact_check_info') {
            return bot.sendMessage(chatId, 
                `🔍 *Fact-Checking Information*\n\n` +
                `This chat includes automatic fact-checking for:\n\n` +
                `• Player-team alignment verification\n` +
                `• Realistic betting line validation\n` +
                `• Contradiction detection\n` +
                `• Common error prevention\n\n` +
                `If you notice any inaccuracies, please verify with official sources.`,
                { parse_mode: 'Markdown' }
            );
        }
        if (data === 'chat_retry') {
            await bot.deleteMessage(chatId, message.message_id);
            const lastMessage = state.chat.history[state.chat.history.length - 2];
            if (lastMessage && lastMessage.role === 'user') {
                await handleUserChat(bot, chatId, lastMessage.content);
            }
            return;
        }
    });
}
