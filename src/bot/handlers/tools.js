// src/bot/handlers/tools.js

import redisClient from '../../services/redisService.js';
import databaseService from '../../services/databaseService.js';
import env from '../../config/env.js';
import axios from 'axios';

// --- Main Command and Callback Router ---

export function registerTools(bot) {
  bot.onText(/^\/tools$/, async (msg) => {
    // In a production bot, you might add a check here to ensure msg.from.id is an admin
    await sendToolsMenu(bot, msg.chat.id);
  });
}

export function registerCommonCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('tools_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    await bot.answerCallbackQuery(cbq.id, { cache_time: 2 }); // Short cache time for status updates

    const parts = data.split('_');
    const action = parts[1];

    if (action === 'main') {
      return sendToolsMenu(bot, chatId, messageId);
    }
    if (action === 'cache') {
      return handleCacheClear(bot, chatId, messageId);
    }
    if (action === 'apistatus') {
      return handleApiStatus(bot, chatId, messageId);
    }
    if (action === 'dbstats') {
      return handleDbStats(bot, chatId, messageId);
    }
  });
}

// --- UI & Handler Functions ---

async function sendToolsMenu(bot, chatId, messageId = null) {
  const text = '🛠️ *Admin Tools*\n\nSelect a tool to use:';
  const keyboard = [
    [{ text: '🧹 Clear Redis Cache', callback_data: 'tools_cache' }],
    [{ text: '📡 Check API Status', callback_data: 'tools_apistatus' }],
    [{ text: '📊 Get Database Stats', callback_data: 'tools_dbstats' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function handleCacheClear(bot, chatId, messageId) {
  await bot.editMessageText('Clearing all known Redis keys (odds, props, state)...', {
    chat_id: chatId,
    message_id: messageId
  });
  
  try {
    const redis = await redisClient;
    // A safer way to clear is to scan and delete keys with known prefixes
    const prefixes = ['odds:', 'player_props:', 'games:', 'user:state:', 'parlay:slip:', 'user:config:', 'token:'];
    let clearedCount = 0;
    
    for (const prefix of prefixes) {
        let cursor = '0';
        do {
            const reply = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '100');
            cursor = reply[0];
            const keys = reply[1];
            if (keys.length) {
                const count = await redis.del(keys);
                clearedCount += count;
            }
        } while (cursor !== '0');
    }

    await bot.editMessageText(`✅ Successfully cleared ${clearedCount} keys from the Redis cache.`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('Cache clear error:', error);
    await bot.editMessageText('❌ Failed to clear cache.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}

async function handleApiStatus(bot, chatId, messageId) {
  await bot.editMessageText('Pinging external APIs...', { chat_id: chatId, message_id: messageId });

  const statuses = {};

  // Check Gemini (Google AI)
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GOOGLE_GEMINI_API_KEY}`;
    const geminiRes = await axios.get(geminiUrl, { timeout: 5000 });
    statuses['Google Gemini'] = geminiRes.status === 200 ? '✅ Online' : '❌ Error';
  } catch (e) {
    statuses['Google Gemini'] = '❌ Offline';
  }

  // Check Perplexity
  try {
    await axios.post('https://api.perplexity.ai/chat/completions', {}, {
        headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` },
        timeout: 5000
    });
    // Perplexity will return 400 for empty request, but that means it's online
    statuses['Perplexity AI'] = '✅ Online';
  } catch (e) {
    if (e.response && (e.response.status === 400 || e.response.status === 401)) {
        statuses['Perplexity AI'] = '✅ Online';
    } else {
        statuses['Perplexity AI'] = '❌ Offline';
    }
  }

  // Check The Odds API
  try {
    const oddsUrl = `https://api.the-odds-api.com/v4/sports?apiKey=${env.THE_ODDS_API_KEY}`;
    await axios.get(oddsUrl, { timeout: 5000 });
    statuses['The Odds API'] = '✅ Online';
  } catch (e) {
    statuses['The Odds API'] = '❌ Offline';
  }

  let statusText = '*📡 API Status Report*\n\n';
  for (const [api, status] of Object.entries(statuses)) {
    statusText += `• *${api}:* ${status}\n`;
  }
  
  await bot.editMessageText(statusText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
  });
}

async function handleDbStats(bot, chatId, messageId) {
    await bot.editMessageText('📊 Fetching database statistics...', { chat_id: chatId, message_id: messageId });
    try {
        const stats = await databaseService.getSportGameCounts();
        let statsText = '*📊 Database Game Counts*\n\n';
        if (stats && stats.length > 0) {
            stats.forEach(stat => {
                statsText += `• *${stat.sport_title}:* ${stat.game_count} games\n`;
            });
        } else {
            statsText += 'No games found in the database. The ingestion worker may need to run.';
        }
        await bot.editMessageText(statsText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    } catch (error) {
        console.error('DB stats error:', error);
        await bot.editMessageText('❌ Failed to fetch database stats.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    }
}
