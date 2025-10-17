// src/bot/handlers/tools.js - COMPLETELY FIXED VERSION
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
  const text = '🛠️ *Admin Tools*\n\nSelect a tool to use:';
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
    
    // FIXED: Handle undefined health report structure
    let healthText = '*❤️ SYSTEM HEALTH REPORT*\n\n';

    // Overall status - FIXED: Check if overall exists
    if (healthReport && healthReport.overall) {
      healthText += `*Overall:* ${healthReport.overall.healthy ? '✅ Healthy' : '❌ Unhealthy'}\n`;
      healthText += `*Timestamp:* ${new Date(healthReport.overall.timestamp).toLocaleString()}\n\n`;
    } else {
      healthText += `*Overall:* ⚠️ Health data unavailable\n\n`;
    }

    // Service status - FIXED: Check if services exist
    healthText += '*Services:*\n';
    if (healthReport && healthReport.services) {
      Object.entries(healthReport.services).forEach(([service, status]) => {
        const statusIcon = status && status.ok ? '✅' : '❌';
        healthText += `• ${statusIcon} ${service}: ${status && status.ok ? 'OK' : 'ERROR'}`;
        if (status && status.details) {
          healthText += ` (${status.details})`;
        }
        healthText += '\n';
      });
    } else {
      healthText += '• ⚠️ No service data available\n';
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
  await bot.editMessageText('💾 Getting Redis information...', { 
    chat_id: chatId, 
    message_id: messageId 
  });

  try {
    const redis = await getRedisClient();
    if (!redis) {
      throw new Error('Redis client not available');
    }

    const [dbsize, memory] = await Promise.all([
      redis.dbsize(),
      redis.info('memory').catch(() => 'used_memory_human:0\r\nmaxmemory_human:0')
    ]);

    // FIXED: Use simpler text formatting to avoid Telegram parse errors
    let redisText = '💾 *REDIS INFORMATION*\n\n';

    // Basic info
    redisText += `*Connected:* ${redis.status === 'ready' ? '✅ Yes' : '❌ No'}\n`;
    redisText += `*Keys:* ${dbsize}\n`;

    // Memory usage - FIXED: Better error handling
    let usedMemory = 'Unknown';
    let maxMemory = 'Unknown';
    try {
      usedMemory = memory.match(/used_memory_human:(\S+)/)?.[1] || 'Unknown';
      maxMemory = memory.match(/maxmemory_human:(\S+)/)?.[1] || 'Unknown';
    } catch (e) {
      console.log('Memory info parse error:', e.message);
    }
    redisText += `*Memory:* ${usedMemory} / ${maxMemory}\n`;

    // Key patterns - FIXED: Use much simpler scanning to avoid timeouts
    const keyPatterns = ['odds:', 'player_props:', 'games:', 'user:', 'parlay:', 'meta:'];
    let keyResults = [];
    
    for (const pattern of keyPatterns) {
      try {
        // Just get a small sample to check if pattern exists
        const result = await redis.scan('0', 'MATCH', `${pattern}*`, 'COUNT', '5');
        const hasKeys = result[1].length > 0;
        keyResults.push(`• ${pattern}: ${hasKeys ? 'Has keys' : 'No keys'}`);
      } catch (error) {
        keyResults.push(`• ${pattern}: Scan error`);
      }
    }

    redisText += '\n*Key Patterns:*\n' + keyResults.join('\n');

    // FIXED: Use HTML parse mode instead of Markdown to avoid formatting issues
    await bot.editMessageText(redisText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown', // Keep as Markdown but with simpler formatting
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('Redis info error:', error);
    await bot.editMessageText('❌ Failed to get Redis information', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}

async function handleOddsFreshness(bot, chatId, messageId) {
  await bot.editMessageText('📊 Checking odds data freshness...', { 
    chat_id: chatId, 
    message_id: messageId 
  });

  try {
    const redis = await getRedisClient();
    const [lastIngestISO, dateRange] = await Promise.all([
      redis.get('meta:last_successful_ingestion').catch(() => null),
      databaseService.getOddsDateRange().catch(() => null)
    ]);

    let freshnessText = '*📊 ODDS DATA FRESHNESS REPORT*\n\n';

    // Last ingestion time
    if (lastIngestISO) {
      const lastIngestDate = new Date(lastIngestISO);
      const now = new Date();
      const hoursAgo = Math.round((now - lastIngestDate) / (1000 * 60 * 60));
      
      freshnessText += `*Last Refresh:* ${lastIngestDate.toLocaleString()}\n`;
      freshnessText += `*Age:* ${hoursAgo} hours ago\n\n`;
    } else {
      freshnessText += `*Last Refresh:* ❌ No successful run recorded\n\n`;
    }

    // Date range
    if (dateRange && dateRange.min_date && dateRange.max_date) {
      const minDate = new Date(dateRange.min_date);
      const maxDate = new Date(dateRange.max_date);
      
      freshnessText += `*Game Date Range:*\n`;
      freshnessText += `From: ${minDate.toLocaleDateString()}\n`;
      freshnessText += `To:   ${maxDate.toLocaleDateString()}\n`;
    } else {
      freshnessText += `*Game Date Range:* ❌ No games in database\n`;
    }

    await bot.editMessageText(freshnessText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });

  } catch (error) {
    console.error('Odds freshness error:', error);
    await bot.editMessageText('❌ Failed to generate freshness report', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}

async function handleManualIngest(bot, chatId, messageId) {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      throw new Error('Redis not available');
    }

    await redis.publish('odds_ingestion_trigger', 'run');
    
    const responseText = `✅ Trigger sent to odds ingestion worker.\n\n` +
      `The worker will process on its next cycle (usually within 1-2 minutes).\n\n` +
      `Check the worker logs on Railway to monitor progress.`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('Manual ingest error:', error);
    await bot.editMessageText('❌ Failed to send trigger to worker', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
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
      'odds:', 'player_props:', 'games:', 
      'user:state:', 'parlay:slip:', 'user:config:', 
      'token:', 'quota:', 'meta:'
    ];

    let totalCleared = 0;

    for (const prefix of prefixes) {
      let cursor = '0';
      do {
        const scanResult = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '50');
        cursor = scanResult[0];
        const keys = scanResult[1];
        
        if (keys.length > 0) {
          const deleted = await redis.del(...keys);
          totalCleared += deleted;
        }
      } while (cursor !== '0');
    }

    let clearText = `✅ Cache cleared successfully!\n\n`;
    clearText += `*Total keys cleared:* ${totalCleared}\n\n`;

    if (totalCleared === 0) {
      clearText += `No keys matched the patterns (cache might already be empty)`;
    }

    await bot.editMessageText(clearText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('Cache clear error:', error);
    await bot.editMessageText('❌ Failed to clear cache', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}

async function handleApiStatus(bot, chatId, messageId) {
  await bot.editMessageText('📡 Checking external APIs...', { 
    chat_id: chatId, 
    message_id: messageId 
  });

  const statuses = {};
  const checkPromises = [];

  // Perplexity AI Check - THE ONLY AI SERVICE YOU USE
  if (env.PERPLEXITY_API_KEY) {
    checkPromises.push(
      axios.post('https://api.perplexity.ai/chat/completions', 
        { 
          model: 'sonar-small-chat', 
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 5
        }, 
        { 
          headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, 
          timeout: 10000 
        }
      )
        .then(() => { statuses['Perplexity AI'] = '✅ Online'; })
        .catch(error => {
          const status = error.response?.status;
          if (status === 401) {
            statuses['Perplexity AI'] = '❌ Invalid API Key';
          } else if (status === 429) {
            statuses['Perplexity AI'] = '⚠️ Rate Limited';
          } else {
            statuses['Perplexity AI'] = `❌ ${status || 'Network Error'}`;
          }
        })
    );
  } else {
    statuses['Perplexity AI'] = '🔴 Not Configured';
  }

  // The Odds API Check
  if (env.THE_ODDS_API_KEY) {
    checkPromises.push(
      axios.get(`https://api.the-odds-api.com/v4/sports?apiKey=${env.THE_ODDS_API_KEY}`, { 
        timeout: 10000 
      })
        .then(response => {
          if (response.status === 200 && Array.isArray(response.data)) {
            statuses['The Odds API'] = `✅ Online (${response.data.length} sports)`;
          } else {
            statuses['The Odds API'] = '⚠️ Unexpected Response';
          }
        })
        .catch(error => {
          const status = error.response?.status;
          if (status === 401) statuses['The Odds API'] = '❌ Invalid API Key';
          else if (status === 429) statuses['The Odds API'] = '⚠️ Rate Limited';
          else statuses['The Odds API'] = `❌ ${status || 'Network Error'}`;
        })
    );
  } else {
    statuses['The Odds API'] = '🔴 Not Configured';
  }

  // Wait for all API checks to complete
  await Promise.allSettled(checkPromises);

  // Add database and Redis status
  try {
    const health = await healthService.getHealth();
    statuses['Database'] = health?.services?.database?.ok ? '✅ Connected' : '❌ Disconnected';
  } catch (error) {
    statuses['Database'] = '❌ Check Failed';
  }

  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.ping();
      const dbsize = await redis.dbsize();
      statuses['Redis'] = `✅ Connected (${dbsize} keys)`;
    } else {
      statuses['Redis'] = '❌ Not Connected';
    }
  } catch (error) {
    statuses['Redis'] = '❌ Check Failed';
  }

  // Format the status report
  let statusText = '*📡 API STATUS REPORT*\n\n';
  
  statusText += '*🤖 AI Services:*\n';
  statusText += `• Perplexity AI: ${statuses['Perplexity AI']}\n`;
  
  statusText += '\n*📊 Data Providers:*\n';
  statusText += `• The Odds API: ${statuses['The Odds API']}\n`;
  
  statusText += '\n*💾 Infrastructure:*\n';
  statusText += `• Database: ${statuses['Database']}\n`;
  statusText += `• Redis: ${statuses['Redis']}\n`;

  await bot.editMessageText(statusText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
  });
}

async function handleDbStats(bot, chatId, messageId) {
  await bot.editMessageText('📈 Fetching database statistics...', { 
    chat_id: chatId, 
    message_id: messageId 
  });

  try {
    let statsText = '*📊 DATABASE STATISTICS*\n\n';

    // Database counts
    try {
      const gameCounts = await databaseService.getSportGameCounts();
      if (gameCounts && gameCounts.length > 0) {
        let totalGames = 0;
        statsText += '*Games by Sport:*\n';
        
        gameCounts.forEach(stat => {
          const title = stat.sport_title || stat.sport_key || 'Unknown';
          const count = stat.total_games || 0;
          totalGames += count;
          if (count > 0) {
            statsText += `• ${title}: ${count} games\n`;
          }
        });
        
        statsText += `\n*Total Games:* ${totalGames}\n\n`;
      } else {
        statsText += '*Games:* No data found\n\n';
      }
    } catch (dbError) {
      statsText += '*Games:* ❌ Error fetching\n\n';
    }

    // API Quotas - only show The Odds API since that's what you use
    statsText += '*📈 API QUOTA STATUS*\n';
    
    try {
      const quota = await rateLimitService.getProviderQuota('theodds');
      
      if (quota && (quota.remaining !== null || quota.used !== null)) {
        const remaining = quota.remaining ?? 'N/A';
        const used = quota.used ?? 'N/A';
        const limit = quota.limit ?? 'N/A';
        const critical = quota.critical ? ' ⚠️' : '';
        
        statsText += `• *The Odds API:* ${remaining}/${limit} remaining${critical}\n`;
      } else {
        statsText += `• *The Odds API:* No data (trigger ingestion)\n`;
      }
    } catch (quotaError) {
      statsText += `• *The Odds API:* ❌ Error\n`;
    }

    await bot.editMessageText(statsText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  } catch (error) {
    console.error('DB stats error:', error);
    await bot.editMessageText('❌ Failed to fetch database statistics', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
    });
  }
}
