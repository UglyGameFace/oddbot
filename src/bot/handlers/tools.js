// src/bot/handlers/tools.js - COMPLETELY FIXED & ACCURATE VERSION

import { getRedisClient } from '../../services/redisService.js';
import databaseService from '../../services/databaseService.js';
import rateLimitService from '../../services/rateLimitService.js';
import healthService from '../../services/healthService.js';
import env from '../../config/env.js';
import axios from 'axios';

export function registerTools(bot) {
  bot.onText(/^\/tools$/, async (msg) => {
    await sendToolsMenu(bot, msg.chat.id);
  });
}

export function registerToolsCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('tools_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
      await bot.answerCallbackQuery(cbq.id, { cache_time: 2 });

      const parts = data.split('_');
      const action = parts[1];

      switch (action) {
        case 'main':
          return await sendToolsMenu(bot, chatId, messageId);
        case 'cache':
          return await handleCacheClear(bot, chatId, messageId);
        case 'apistatus':
          return await handleApiStatus(bot, chatId, messageId);
        case 'dbstats':
          return await handleDbStats(bot, chatId, messageId);
        case 'ingest':
          return await handleManualIngest(bot, chatId, messageId);
        case 'freshness':
          return await handleOddsFreshness(bot, chatId, messageId);
        case 'health':
          return await handleHealthCheck(bot, chatId, messageId);
        case 'redis':
          return await handleRedisInfo(bot, chatId, messageId);
        default:
          await bot.editMessageText('❌ Unknown tool action', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
          });
      }
    } catch (error) {
      console.error('Tools callback error:', error);
      await bot.editMessageText('❌ Tool action failed', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
      });
    }
  });
}

async function sendToolsMenu(bot, chatId, messageId = null) {
  const text = `🛠️ *Admin Tools*

Select a tool to use:`;
  const keyboard = [
    [{ text: '🔄 Trigger Odds Ingestion', callback_data: 'tools_ingest' }],
    [{ text: '📊 Odds Freshness', callback_data: 'tools_freshness' }],
    [{ text: '🧹 Clear Redis Cache', callback_data: 'tools_cache' }],
    [{ text: '📡 Check API Status', callback_data: 'tools_apistatus' }],
    [{ text: '📈 Database & Quota Stats', callback_data: 'tools_dbstats' }],
    [{ text: '❤️ System Health', callback_data: 'tools_health' }],
    [{ text: '💾 Redis Info', callback_data: 'tools_redis' }]
  ];

  const opts = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  };

  try {
    if (messageId) {
      await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
    } else {
      await bot.sendMessage(chatId, text, opts);
    }
  } catch (error) {
    console.error('Send tools menu error:', error);
  }
}

async function handleHealthCheck(bot, chatId, messageId) {
  await bot.editMessageText('❤️ Running comprehensive health check...', {
    chat_id: chatId,
    message_id: messageId
  });

  try {
    const healthReport = await healthService.getHealth();
    let healthText = `❤️ *SYSTEM HEALTH REPORT*\n\n`;

    // FIX: Add fallback logic for overall health status.
    if (healthReport?.ok !== undefined) {
      healthText += `*Overall:* ${healthReport.ok ? '✅ Healthy' : '❌ Unhealthy'}\n`;
      healthText += `_Timestamp: ${new Date(healthReport.timestamp).toLocaleString()}_\n\n`;
    } else if (healthReport?.services) {
      const allOk = Object.values(healthReport.services).every(s => s?.ok);
      healthText += `*Overall:* ${allOk ? '✅ Healthy' : '❌ Unhealthy'} _(inferred)_\n`;
      healthText += `_Timestamp: ${new Date().toLocaleString()}_\n\n`;
    } else {
      healthText += `*Overall:* ⚠️ Health data unavailable\n\n`;
    }

    healthText += '*Services:*\n';
    if (healthReport?.services) {
      Object.entries(healthReport.services).forEach(([service, status]) => {
        const statusIcon = status?.ok ? '✅' : '❌';
        const statusText = status?.ok ? 'OK' : 'ERROR';
        healthText += `${statusIcon} ${service}: ${statusText}`;
        if (status?.error) {
          healthText += ` (details available in logs)`;
        }
        healthText += '\n';
      });
    } else {
      healthText += '⚠️ No service data available\n';
    }

    await bot.editMessageText(healthText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('Health check error:', error);
    await bot.editMessageText('❌ Failed to get health report', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}

async function handleRedisInfo(bot, chatId, messageId) {
  await bot.editMessageText('💾 Getting accurate Redis information...', {
    chat_id: chatId,
    message_id: messageId
  });

  // FIX: Use correct ioredis SCAN syntax
  async function sampleAndCount(redis, pattern, limitMs = 2000) {
    let cursor = '0';
    let count = 0;
    const samples = [];
    const deadline = Date.now() + limitMs;
  
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${pattern}*`, 'COUNT', 500);
      cursor = nextCursor;

      if (keys.length > 0) {
        count += keys.length;
        if (samples.length < 3) {
            samples.push(...keys.slice(0, 3 - samples.length).map(k => k.replace(pattern, '')));
        }
      }
      
      if (Date.now() > deadline) break;
    } while (cursor !== '0');
  
    return { count, samples };
  }

  try {
    const redis = await getRedisClient();
    if (!redis) {
      throw new Error('Redis client not available');
    }

    // FIX: Use dbsize() for ioredis
    const [dbsize, fullInfo, memoryInfo] = await Promise.all([
      redis.dbsize(),
      redis.info(),
      redis.info('memory')
    ]);

    let redisText = `💾 *REDIS INFORMATION*\n\n`;

    redisText += `*Connected:* ${redis.status === 'ready' ? '✅ Yes' : '❌ No'}\n`;
    redisText += `*Total Keys:* \`${dbsize}\`\n`;

    const usedMemory = memoryInfo.match(/used_memory_human:(\S+)/)?.[1] || 'Unknown';
    const maxMemory = memoryInfo.match(/maxmemory_human:(\S+)/)?.[1] || '0B';
    const memoryStatus = maxMemory === '0B' ? 'No limit' : maxMemory;
    redisText += `*Memory Usage:* ${usedMemory} / ${memoryStatus}\n`;

    const version = fullInfo.match(/redis_version:(\S+)/)?.[1] || 'Unknown';
    const uptimeSeconds = fullInfo.match(/uptime_in_seconds:(\d+)/)?.[1] || '0';
    const uptimeDays = Math.floor(parseInt(uptimeSeconds, 10) / 86400);
    redisText += `*Version:* ${version}\n`;
    redisText += `*Uptime:* ${uptimeDays} days\n`;

    redisText += '\n*Key Patterns:*\n';
    const keyPatterns = ['v1:production:odds:', 'v1:production:player_props:', 'v1:production:games:', 'v1:production:user:state:', 'v1:production:parlay:slip:', 'v1:production:meta:'];
    for (const pattern of keyPatterns) {
      try {
        // Use the base pattern for display, but scan with the full prefix from state.js
        const displayPattern = pattern.replace('v1:production:', '');
        const { count, samples } = await sampleAndCount(redis, pattern);
        const sampleText = samples.length ? ` (sample: _${samples.join(', ')}_)` : '';
        redisText += `- \`${displayPattern}\`: ${count} keys${sampleText}\n`;
      } catch (e) {
        console.error(`Redis scan error for ${pattern}:`, e.message);
        const displayPattern = pattern.replace('v1:production:', '');
        redisText += `- \`${displayPattern}\`: Error checking\n`;
      }
    }

    let healthLabel = '❌ Error';
    try {
      const pong = await redis.ping();
      if (pong === 'PONG') healthLabel = '✅ Working';
      const k = `healthcheck:${Date.now()}`;
      await redis.set(k, '1', 'EX', 5);
      await redis.get(k);
      await redis.del(k);
    } catch (_) {
      // ignore failures
    }
    redisText += `\n*Health Check:* ${healthLabel}\n`;

    await bot.editMessageText(redisText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  } catch (error) {
    console.error('Redis info error:', error);
    await bot.editMessageText('❌ Failed to get Redis information', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  }
}

async function handleOddsFreshness(bot, chatId, messageId) {
  await bot.editMessageText('📊 Checking odds data freshness...', {
    chat_id: chatId,
    message_id: messageId
  });

  try {
    const redis = await getRedisClient();
    const [lastIngestISO, dateRange, gameCounts] = await Promise.all([
      redis.get('meta:last_successful_ingestion').catch(() => null),
      databaseService.getOddsDateRange().catch(() => null),
      databaseService.getSportGameCounts().catch(() => [])
    ]);

    let freshnessText = `📊 *ODDS DATA FRESHNESS REPORT*\n\n`;

    if (lastIngestISO) {
      const lastIngestDate = new Date(lastIngestISO);
      const now = new Date();
      const hoursAgo = Math.round((now - lastIngestDate) / (1000 * 60 * 60));
      freshnessText += `*Last Refresh:* ${lastIngestDate.toLocaleString()}\n`;
      freshnessText += `*Age:* ~${hoursAgo} hours ago\n\n`;
    } else {
      freshnessText += `*Last Refresh:* ❌ No successful run recorded\n\n`;
    }

    if (dateRange && dateRange.min_date && dateRange.max_date) {
      const minDate = new Date(dateRange.min_date);
      const maxDate = new Date(dateRange.max_date);
      freshnessText += `*Game Date Range:*\n`;
      freshnessText += `From: ${minDate.toLocaleDateString()}\n`;
      freshnessText += `To:   ${maxDate.toLocaleDateString()}\n\n`;
    } else {
      freshnessText += `*Game Date Range:* ❌ No games in database\n\n`;
    }

    if (gameCounts && gameCounts.length > 0) {
      let totalGames = 0;
      freshnessText += '*Games by Sport:*\n';
      gameCounts.forEach(stat => {
        const title = stat.sport_title || stat.sport_key || 'Unknown';
        const count = stat.total_games || 0;
        totalGames += count;
        if (count > 0) {
          freshnessText += `- ${title}: ${count} games\n`;
        }
      });
      freshnessText += `\n*Total Games:* \`${totalGames}\`\n`;
    } else {
      freshnessText += `*Games:* ❌ No game data found\n`;
    }

    await bot.editMessageText(freshnessText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  } catch (error) {
    console.error('Odds freshness error:', error);
    await bot.editMessageText('❌ Failed to generate freshness report', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  }
}

async function handleManualIngest(bot, chatId, messageId) {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      throw new Error('Redis not available');
    }

    await redis.publish('odds_ingestion_trigger', 'run');

    const responseText =
      `✅ *Trigger sent to odds ingestion worker.*\n\n` +
      `The worker will process on its next cycle (usually within 1-2 minutes).\n\n` +
      `You can monitor its progress in the worker logs on your hosting platform.`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  } catch (error) {
    console.error('Manual ingest error:', error);
    await bot.editMessageText('❌ Failed to send trigger to worker', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  }
}

async function handleCacheClear(bot, chatId, messageId) {
  await bot.editMessageText('🧹 Clearing Redis cache...', {
    chat_id: chatId,
    message_id: messageId
  });

  try {
    const redis = await getRedisClient();
    if (!redis) {
      throw new Error('Redis not available');
    }

    const prefixes = [
      'v1:production:odds:', 'v1:production:player_props:', 'v1:production:games:',
      'v1:production:user:state:', 'v1:production:parlay:slip:', 'v1:production:user:config:',
      'v1:production:token:', 'v1:production:quota:', 'v1:production:meta:'
    ];

    let totalCleared = 0;
    
    const pipeline = redis.pipeline();
    for (const prefix of prefixes) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 250);
        cursor = nextCursor;
        if (keys.length > 0) {
          pipeline.del(...keys);
          totalCleared += keys.length;
        }
      } while (cursor !== '0');
    }
    await pipeline.exec();


    let clearText = `✅ *Cache cleared successfully!*\n\n`;
    clearText += `*Total keys cleared:* \`${totalCleared}\`\n`;

    if (totalCleared === 0) {
      clearText += `\n_No keys matched the patterns (cache might have already been empty)._`;
    }

    await bot.editMessageText(clearText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  } catch (error) {
    console.error('Cache clear error:', error);
    await bot.editMessageText('❌ Failed to clear cache', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  }
}

async function handleApiStatus(bot, chatId, messageId) {
  await bot.editMessageText('📡 Checking external APIs with REAL tests...', {
    chat_id: chatId,
    message_id: messageId
  });

  const statuses = {};
  const checkPromises = [];

  if (env.PERPLEXITY_API_KEY) {
    checkPromises.push(
      axios.post(
        'https://api.perplexity.ai/chat/completions',
        {
          model: 'sonar-small-online',
          messages: [{ role: 'user', content: 'TEST' }],
          max_tokens: 10,
          temperature: 0.1
        },
        {
          headers: {
            Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      )
      .then((response) => {
        const ok = response?.data?.choices?.length > 0;
        statuses['Perplexity AI'] = ok ? '✅ Online & Working' : '⚠️ Online (No Response Data)';
      })
      .catch(error => {
        console.error('Perplexity AI REAL check error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
        const status = error.response?.status;
        if (status === 401) {
          statuses['Perplexity AI'] = '❌ Invalid API Key (401)';
        } else if (status === 429) {
          statuses['Perplexity AI'] = '⚠️ Rate Limited (429)';
        } else if (status === 400) {
          statuses['Perplexity AI'] = '❌ Bad Request (400)';
        } else if (error.code === 'ECONNABORTED') {
          statuses['Perplexity AI'] = '❌ Timeout';
        } else {
          statuses['Perplexity AI'] = `❌ ${status || 'Connection Error'}`;
        }
      })
    );
  } else {
    statuses['Perplexity AI'] = '🔴 Not Configured';
  }

  if (env.THE_ODDS_API_KEY) {
    checkPromises.push(
      axios.get(`https://api.the-odds-api.com/v4/sports?apiKey=${env.THE_ODDS_API_KEY}`, {
        timeout: 10000
      })
      .then(response => {
        if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
          const sportsCount = response.data.length;
          statuses['The Odds API'] = `✅ Online (${sportsCount} sports)`;
        } else if (response.status === 200) {
          statuses['The Odds API'] = '⚠️ Online (No Sports Data)';
        } else {
          statuses['The Odds API'] = `❌ Unexpected Response (${response.status})`;
        }
      })
      .catch(error => {
        console.error('The Odds API check error:', error.response?.status || error.message);
        const status = error.response?.status;
        if (status === 401) statuses['The Odds API'] = '❌ Invalid API Key (401)';
        else if (status === 429) statuses['The Odds API'] = '⚠️ Rate Limited (429)';
        else if (error.code === 'ECONNABORTED') statuses['The Odds API'] = '❌ Timeout';
        else statuses['The Odds API'] = `❌ ${status || 'Connection Error'}`;
      })
    );
  } else {
    statuses['The Odds API'] = '🔴 Not Configured';
  }

  await Promise.allSettled(checkPromises);

  try {
    const testResult = await databaseService.getSportGameCounts().catch(() => null);
    statuses['Database'] = Array.isArray(testResult) ? '✅ Connected & Working' : '⚠️ Connected (Query Failed)';
  } catch (error) {
    console.error('Database check error:', error.message);
    statuses['Database'] = '❌ Connection Failed';
  }

  try {
    const redis = await getRedisClient();
    if (redis?.status === 'ready') {
      const pong = await redis.ping();
      const size = await redis.dbsize();
      statuses['Redis'] = pong === 'PONG' ? `✅ Connected & Working (${size} keys)` : '❌ Ping Failed';
    } else {
      statuses['Redis'] = `❌ Not Connected (status: ${redis?.status || 'unknown'})`;
    }
  } catch (error) {
    console.error('Redis check error:', error.message);
    statuses['Redis'] = '❌ Connection Failed';
  }

  let statusText = `📡 *API STATUS REPORT (REAL TESTS)*\n\n`;
  statusText += `*🤖 AI Services:*\n`;
  statusText += `Perplexity AI: ${statuses['Perplexity AI']}\n\n`;
  statusText += `*📊 Data Providers:*\n`;
  statusText += `The Odds API: ${statuses['The Odds API']}\n\n`;
  statusText += `*💾 Infrastructure:*\n`;
  statusText += `Database: ${statuses['Database']}\n`;
  statusText += `Redis: ${statuses['Redis']}\n`;

  await bot.editMessageText(statusText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
  );
}

async function handleDbStats(bot, chatId, messageId) {
  await bot.editMessageText('📈 Fetching accurate database statistics...', {
    chat_id: chatId,
    message_id: messageId
  });

  try {
    let statsText = `📊 *DATABASE STATISTICS*\n\n`;

    try {
      const gameCounts = await databaseService.getSportGameCounts();
      if (gameCounts?.length > 0) {
        let totalGames = 0;
        let activeSports = 0;
        statsText += '*Games by Sport:*\n';
        gameCounts.forEach(stat => {
          const title = stat.sport_title || stat.sport_key || 'Unknown';
          const count = stat.total_games || 0;
          totalGames += count;
          if (count > 0) {
            activeSports++;
            statsText += `- ${title}: ${count} games\n`;
          }
        });
        statsText += `\n*Total Games:* \`${totalGames}\`\n`;
        statsText += `*Active Sports:* ${activeSports}\n\n`;
      } else {
        statsText += '*Games:* ❌ No data found in database\n\n';
      }
    } catch (dbError) {
      console.error('Database stats error:', dbError);
      statsText += '*Games:* ❌ Error fetching data\n\n';
    }

    statsText += `📈 *API QUOTA STATUS*\n\n`;

    try {
      const quota = await rateLimitService.getProviderQuota('theodds');
      if (quota) {
        const { remaining = 'N/A', used = 'N/A', limit = 'N/A', at, critical } = quota;
        const lastUpdated = at ? new Date(at).toLocaleString() : 'Never';
        const criticalText = critical ? ' *⚠️ CRITICAL*' : '';
        statsText += `*The Odds API:*\n`;
        statsText += `- Remaining: \`${remaining}\`${criticalText}\n`;
        statsText += `- Used: \`${used}\`\n`;
        statsText += `- Limit: \`${limit}\`\n`;
        statsText += `- _Last Updated: ${lastUpdated}_\n`;
        if (critical) {
          statsText += `\n*WARNING:* API quota is critically low!\n`;
        }
      } else {
        statsText += `*The Odds API:* No quota data available.\n_(Trigger odds ingestion to populate data)_\n`;
      }
    } catch (quotaError) {
      console.error('Quota check error:', quotaError);
      statsText += `*The Odds API:* ❌ Error fetching quota\n`;
    }

    await bot.editMessageText(statsText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  } catch (error) {
    console.error('DB stats error:', error);
    await bot.editMessageText('❌ Failed to fetch database statistics', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] } }
    );
  }
}
