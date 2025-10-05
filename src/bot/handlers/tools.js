// src/bot/handlers/tools.js

import redisClient from '../../services/redisService.js';
import databaseService from '../../services/databaseService.js';
import rateLimitService from '../../services/rateLimitService.js';
import env from '../../config/env.js';
import axios from 'axios';

// --- Main Command and Callback Router ---

export function registerTools(bot) {
  bot.onText(/^\/tools$/, async (msg) => {
    await sendToolsMenu(bot, msg.chat.id);
  });
}

// FIX: This function was incorrectly named. Renaming to registerToolsCallbacks
// guarantees that the import in callbackManager.js will work correctly.
export function registerToolsCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('tools_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    await bot.answerCallbackQuery(cbq.id, { cache_time: 2 });

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
    if (action === 'ingest') {
      return handleManualIngest(bot, chatId, messageId);
    }
    if (action === 'freshness') {
        return handleOddsFreshness(bot, chatId, messageId);
    }
  });
}

// --- UI & Handler Functions ---

async function sendToolsMenu(bot, chatId, messageId = null) {
  const text = '🛠️ *Admin Tools*\n\nSelect a tool to use:';
  const keyboard = [
    [{ text: '🔄 Trigger Odds Ingestion', callback_data: 'tools_ingest' }],
    [{ text: '📊 Odds Freshness', callback_data: 'tools_freshness' }],
    [{ text: '🧹 Clear Redis Cache', callback_data: 'tools_cache' }],
    [{ text: '📡 Check API Status', callback_data: 'tools_apistatus' }],
    [{ text: '📈 Get Database & Quota Stats', callback_data: 'tools_dbstats' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function handleOddsFreshness(bot, chatId, messageId) {
    await bot.editMessageText('📊 Checking odds data freshness...', { chat_id: chatId, message_id: messageId });
    try {
        const redis = await redisClient;
        const lastIngestISO = await redis.get('meta:last_successful_ingestion');
        const dateRange = await databaseService.getOddsDateRange();

        let freshnessText = '*📊 Odds Data Freshness Report*\n\n';

        if (lastIngestISO) {
            const lastIngestDate = new Date(lastIngestISO);
            freshnessText += `*Last Successful Refresh:*\n${lastIngestDate.toLocaleString('en-US', { timeZone: 'America/New_York' })}\n\n`;
        } else {
            freshnessText += `*Last Successful Refresh:*\n_No successful run has been recorded yet._\n\n`;
        }

        if (dateRange && dateRange.min_date && dateRange.max_date) {
            const minDate = new Date(dateRange.min_date);
            const maxDate = new Date(dateRange.max_date);
            freshnessText += `*Game Dates in Database:*\nFrom: ${minDate.toLocaleDateString()}\nTo:     ${maxDate.toLocaleDateString()}`;
        } else {
            freshnessText += `*Game Dates in Database:*\n_No games found in the database._`;
        }

        await bot.editMessageText(freshnessText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });

    } catch (error) {
        console.error('Odds freshness error:', error);
        await bot.editMessageText('❌ Failed to generate freshness report.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    }
}

async function handleManualIngest(bot, chatId, messageId) {
    try {
        const redis = await redisClient;
        const channel = 'odds_ingestion_trigger';
        const message = 'run';
        await redis.publish(channel, message);
        const responseText = `✅ Trigger sent to odds ingestion worker. It will process on its next cycle. Check the worker logs on Railway to monitor progress.`;
        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    } catch (error) {
        console.error('Failed to publish manual ingest trigger:', error);
        await bot.editMessageText('❌ Failed to send trigger to the worker. Please check the logs.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    }
}

async function handleCacheClear(bot, chatId, messageId) {
  await bot.editMessageText('Clearing all known Redis keys (odds, props, state)...', {
    chat_id: chatId,
    message_id: messageId
  });
  
  try {
    const redis = await redisClient;
    const prefixes = ['odds:', 'player_props:', 'games:', 'user:state:', 'parlay:slip:', 'user:config:', 'token:', 'quota:', 'meta:'];
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

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GOOGLE_GEMINI_API_KEY}`;
    const geminiRes = await axios.get(geminiUrl, { timeout: 5000 });
    statuses['Google Gemini'] = geminiRes.status === 200 ? '✅ Online' : '❌ Error';
  } catch (e) {
    statuses['Google Gemini'] = '❌ Offline';
  }

  try {
    await axios.post('https://api.perplexity.ai/chat/completions', {}, {
        headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` },
        timeout: 5000
    });
    statuses['Perplexity AI'] = '✅ Online';
  } catch (e) {
    if (e.response && (e.response.status === 400 || e.response.status === 401)) {
        statuses['Perplexity AI'] = '✅ Online';
    } else {
        statuses['Perplexity AI'] = '❌ Offline';
    }
  }

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
    await bot.editMessageText('📊 Fetching database and API quota statistics...', { chat_id: chatId, message_id: messageId });
    try {
        const stats = await databaseService.getSportGameCounts();
        let statsText = '📊 *Database Game Counts*\n\n';
        if (stats && stats.length > 0) {
            stats.forEach(stat => {
                const title = stat.sport_title || 'Unknown/Other';
                statsText += `• *${title}:* ${stat.game_count} games\n`;
            });
        } else {
            statsText += 'No games found in the database. The ingestion worker may need to run.\n';
        }

        statsText += '\n📈 *API Quota Status (Live)*\n_Data reflects the last API call made by a worker._\n\n';
        const providers = ['theodds', 'sportradar', 'apisports'];
        for (const provider of providers) {
            const quota = await rateLimitService.getProviderQuota(provider);
            const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
            statsText += `*${providerName}*:\n`;
            if (quota) {
                const remaining = quota.remaining ?? 'N/A';
                const used = quota.used ?? 'N/A';
                const limit = quota.limit ?? 'N/A';
                const lastUpdated = quota.at ? new Date(quota.at).toLocaleTimeString() : 'Never';
                statsText += `  - Remaining: ${remaining}\n`;
                statsText += `  - Used: ${used}\n`;
                statsText += `  - Limit/Window: ${limit}\n`;
                statsText += `  - Last Updated: ${lastUpdated}\n`;
            } else {
                statsText += '  - _No data yet. Trigger odds ingestion to populate._\n';
            }
        }

        await bot.editMessageText(statsText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    } catch (error) {
        console.error('DB/Quota stats error:', error);
        await bot.editMessageText('❌ Failed to fetch database or quota stats.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
        });
    }
}
