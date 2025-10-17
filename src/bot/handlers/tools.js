// src/bot/handlers/tools.js - COMPLETELY REWRITTEN & FIXED VERSION
import { getRedisClient } from '../../services/redisService.js';
import databaseService from '../../services/databaseService.js';
import rateLimitService from '../../services/rateLimitService.js';
import healthService from '../../services/healthService.js';
import env from '../../config/env.js';
import axios from 'axios';

// --- Main Command and Callback Router ---

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

      // Handle different tool actions
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

// --- UI & Handler Functions ---

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

// --- NEW: Comprehensive Health Check ---
async function handleHealthCheck(bot, chatId, messageId) {
  await bot.editMessageText('❤️ Running comprehensive health check...', { 
    chat_id: chatId, 
    message_id: messageId 
  });

  try {
    const healthReport = await healthService.getHealth();
    let healthText = '*❤️ SYSTEM HEALTH REPORT*\n\n';

    // Overall status
    healthText += `*Overall:* ${healthReport.overall.healthy ? '✅ Healthy' : '❌ Unhealthy'}\n`;
    healthText += `*Timestamp:* ${new Date(healthReport.overall.timestamp).toLocaleString()}\n\n`;

    // Service status
    healthText += '*Services:*\n';
    Object.entries(healthReport.services).forEach(([service, status]) => {
      const statusIcon = status.ok ? '✅' : '❌';
      healthText += `• ${statusIcon} ${service}: ${status.ok ? 'OK' : 'ERROR'}`;
      if (status.details) {
        healthText += ` (${status.details})`;
      }
      healthText += '\n';
    });

    healthText += '\n*Recommendations:*\n';
    if (!healthReport.overall.healthy) {
      const failedServices = Object.entries(healthReport.services)
        .filter(([_, status]) => !status.ok)
        .map(([service]) => service);
      healthText += `• Check these services: ${failedServices.join(', ')}\n`;
    } else {
      healthText += '• All systems operational\n';
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

// --- NEW: Redis Information ---
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

    const [info, dbsize, memory, clients] = await Promise.all([
      redis.info(),
      redis.dbsize(),
      redis.info('memory'),
      redis.info('clients')
    ]);

    let redisText = '*💾 REDIS INFORMATION*\n\n';

    // Basic info
    redisText += `*Connected:* ${redis.status === 'ready' ? '✅ Yes' : '❌ No'}\n`;
    redisText += `*Keys:* ${dbsize}\n`;

    // Memory usage
    const usedMemory = memory.match(/used_memory_human:(\S+)/)?.[1] || 'Unknown';
    const maxMemory = memory.match(/maxmemory_human:(\S+)/)?.[1] || 'Unknown';
    redisText += `*Memory:* ${usedMemory} / ${maxMemory}\n`;

    // Clients
    const connectedClients = clients.match(/connected_clients:(\d+)/)?.[1] || 'Unknown';
    redisText += `*Clients:* ${connectedClients}\n`;

    // Server info
    const redisVersion = info.match(/redis_version:(\S+)/)?.[1] || 'Unknown';
    const uptime = info.match(/uptime_in_seconds:(\d+)/)?.[1] || 'Unknown';
    redisText += `*Version:* ${redisVersion}\n`;
    redisText += `*Uptime:* ${Math.round(parseInt(uptime) / 3600)} hours\n`;

    // Key patterns
    const keyPatterns = ['odds:', 'player_props:', 'games:', 'user:', 'parlay:', 'token:', 'quota:', 'meta:'];
    let keyCounts = {};
    
    for (const pattern of keyPatterns) {
      let count = 0;
      let cursor = '0';
      do {
        const scanResult = await redis.scan(cursor, 'MATCH', `${pattern}*`, 'COUNT', '100');
        cursor = scanResult[0];
        count += scanResult[1].length;
      } while (cursor !== '0');
      keyCounts[pattern] = count;
    }

    redisText += '\n*Key Distribution:*\n';
    Object.entries(keyCounts).forEach(([pattern, count]) => {
      if (count > 0) {
        redisText += `• ${pattern}: ${count} keys\n`;
      }
    });

    await bot.editMessageText(redisText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
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
    const [lastIngestISO, dateRange, gameCounts] = await Promise.all([
      redis.get('meta:last_successful_ingestion'),
      databaseService.getOddsDateRange(),
      databaseService.getSportGameCounts()
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
      const today = new Date();
      const daysUntilMax = Math.round((maxDate - today) / (1000 * 60 * 60 * 24));
      
      freshnessText += `*Game Date Range:*\n`;
      freshnessText += `From: ${minDate.toLocaleDateString()}\n`;
      freshnessText += `To:   ${maxDate.toLocaleDateString()}\n`;
      freshnessText += `Future games: ${daysUntilMax > 0 ? `${daysUntilMax} days` : 'None'}\n\n`;
    } else {
      freshnessText += `*Game Date Range:* ❌ No games in database\n\n`;
    }

    // Game counts by sport
    if (gameCounts && gameCounts.length > 0) {
      freshnessText += `*Games by Sport:*\n`;
      gameCounts.forEach(stat => {
        const title = stat.sport_title || stat.sport_key || 'Unknown';
        const count = stat.total_games || 0;
        if (count > 0) {
          freshnessText += `• ${title}: ${count} games\n`;
        }
      });
    } else {
      freshnessText += `*Games by Sport:* ❌ No game data\n`;
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
    const clearedByType = {};

    for (const prefix of prefixes) {
      let cursor = '0';
      let prefixCount = 0;
      
      do {
        const scanResult = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '100');
        cursor = scanResult[0];
        const keys = scanResult[1];
        
        if (keys.length > 0) {
          const deleted = await redis.del(...keys);
          prefixCount += deleted;
          totalCleared += deleted;
        }
      } while (cursor !== '0');
      
      clearedByType[prefix] = prefixCount;
    }

    let clearText = `✅ Cache cleared successfully!\n\n`;
    clearText += `*Total keys cleared:* ${totalCleared}\n\n`;
    clearText += `*Breakdown:*\n`;
    
    Object.entries(clearedByType).forEach(([prefix, count]) => {
      if (count > 0) {
        clearText += `• ${prefix}: ${count} keys\n`;
      }
    });

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

  // Google Gemini Check
  if (env.GOOGLE_GEMINI_API_KEY) {
    checkPromises.push(
      axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GOOGLE_GEMINI_API_KEY}`, { 
        timeout: 10000 
      })
        .then(() => { statuses['Google Gemini'] = '✅ Online'; })
        .catch(error => {
          statuses['Google Gemini'] = `❌ ${error.response?.status || 'Network Error'}`;
        })
    );
  } else {
    statuses['Google Gemini'] = '🔴 Not Configured';
  }

  // Perplexity AI Check
  if (env.PERPLEXITY_API_KEY) {
    checkPromises.push(
      axios.post('https://api.perplexity.ai/chat/completions', 
        { 
          model: 'sonar-small-chat', 
          messages: [{ role: 'user', content: 'test' }] 
        }, 
        { 
          headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, 
          timeout: 10000 
        }
      )
        .then(() => { statuses['Perplexity AI'] = '✅ Online'; })
        .catch(error => {
          const status = error.response?.status;
          if (status === 401 || status === 429) {
            statuses['Perplexity AI'] = `⚠️ ${status === 401 ? 'Auth Error' : 'Rate Limited'}`;
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
    statuses['Database'] = health?.services?.database?.ok ? '✅ Online' : '❌ Unhealthy';
  } catch (error) {
    statuses['Database'] = '❌ Check Failed';
  }

  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.ping();
      const dbsize = await redis.dbsize();
      statuses['Redis'] = `✅ Online (${dbsize} keys)`;
    } else {
      statuses['Redis'] = '❌ Not Connected';
    }
  } catch (error) {
    statuses['Redis'] = '❌ Check Failed';
  }

  // Format the status report
  let statusText = '*📡 API STATUS REPORT*\n\n';
  
  statusText += '*🤖 AI Services:*\n';
  ['Google Gemini', 'Perplexity AI'].forEach(api => {
    statusText += `• ${api}: ${statuses[api]}\n`;
  });
  
  statusText += '\n*📊 Data Providers:*\n';
  ['The Odds API'].forEach(api => {
    statusText += `• ${api}: ${statuses[api]}\n`;
  });
  
  statusText += '\n*💾 Infrastructure:*\n';
  ['Database', 'Redis'].forEach(service => {
    statusText += `• ${service}: ${statuses[service]}\n`;
  });

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

    // API Quotas
    statsText += '*📈 API QUOTA STATUS*\n';
    
    const providers = [
      { key: 'theodds', name: 'The Odds API', envKey: 'THE_ODDS_API_KEY' },
      { key: 'sportradar', name: 'Sportradar', envKey: 'SPORTRADAR_API_KEY' },
      { key: 'apisports', name: 'API-Sports', envKey: 'APISPORTS_API_KEY' }
    ];

    let hasQuotaData = false;

    for (const provider of providers) {
      try {
        // Check if API key is configured
        if (!env[provider.envKey]) {
          statsText += `• *${provider.name}:* 🔴 Not Configured\n`;
          continue;
        }

        const quota = await rateLimitService.getProviderQuota(provider.key);
        
        if (quota && (quota.remaining !== null || quota.used !== null)) {
          hasQuotaData = true;
          const remaining = quota.remaining ?? 'N/A';
          const used = quota.used ?? 'N/A';
          const limit = quota.limit ?? 'N/A';
          const critical = quota.critical ? ' ⚠️' : '';
          
          statsText += `• *${provider.name}:* ${remaining}/${limit} remaining${critical}\n`;
        } else {
          statsText += `• *${provider.name}:* No data (trigger ingestion)\n`;
        }
      } catch (quotaError) {
        statsText += `• *${provider.name}:* ❌ Error\n`;
      }
    }

    if (!hasQuotaData) {
      statsText += '\n*💡 Tip:* Use "Trigger Odds Ingestion" to populate quota data';
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
