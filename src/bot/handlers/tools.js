// src/bot/handlers/tools.js - ENHANCED DATABASE STATS HANDLING

import { getRedisClient } from '../../services/redisService.js';
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
        const redis = await getRedisClient();
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
        const redis = await getRedisClient();
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
    const redis = await getRedisClient();
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

  // Check Google Gemini
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GOOGLE_GEMINI_API_KEY}`;
    const geminiRes = await axios.get(geminiUrl, { timeout: 5000 });
    statuses['Google Gemini'] = geminiRes.status === 200 ? '✅ Online' : '❌ Error';
  } catch (e) {
    statuses['Google Gemini'] = `❌ Offline (${e.response?.status || 'Network Error'})`;
  }

  // Check Perplexity AI
  try {
    await axios.post('https://api.perplexity.ai/chat/completions', 
        { model: 'sonar-small-chat', messages: [{ role: 'user', content: 'test' }] }, 
        { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 5000 }
    );
    statuses['Perplexity AI'] = '✅ Online';
  } catch (e) {
    if (e.response && (e.response.status === 401 || e.response.status === 429)) {
        statuses['Perplexity AI'] = `❌ Auth/Limit (${e.response.status})`;
    } else {
        statuses['Perplexity AI'] = `❌ Offline (${e.response?.status || 'Network Error'})`;
    }
  }

  // ENHANCED: Better check for The Odds API with actual data validation
  try {
    const oddsUrl = `https://api.the-odds-api.com/v4/sports?apiKey=${env.THE_ODDS_API_KEY}`;
    const response = await axios.get(oddsUrl, { timeout: 5000 });
    
    // More thorough validation
    if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
        statuses['The Odds API'] = '✅ Online (Data Available)';
    } else if (response.status === 200) {
        statuses['The Odds API'] = '⚠️ Online (No Sports Data)';
    } else {
        statuses['The Odds API'] = `❌ Error (${response.status})`;
    }
  } catch (e) {
    if (e.response) {
      if (e.response.status === 401) {
        statuses['The Odds API'] = '❌ Invalid API Key (401)';
      } else if (e.response.status === 429) {
        statuses['The Odds API'] = '❌ Rate Limited (429)';
      } else {
        statuses['The Odds API'] = `❌ Error (${e.response.status})`;
      }
    } else {
      statuses['The Odds API'] = '❌ Offline (Network Error)';
    }
  }

  // NEW: Check Sportradar API
  try {
    // Use a simple endpoint that should work with any valid Sportradar key
    const sportradarUrl = `https://api.sportradar.com/nba/trial/v8/en/league/injuries.json?api_key=${env.SPORTRADAR_API_KEY}`;
    const sportradarRes = await axios.get(sportradarUrl, { timeout: 5000 });
    
    if (sportradarRes.status === 200) {
        statuses['Sportradar API'] = '✅ Online';
    } else {
        statuses['Sportradar API'] = `❌ Error (${sportradarRes.status})`;
    }
  } catch (e) {
    if (e.response) {
      if (e.response.status === 401 || e.response.status === 403) {
        statuses['Sportradar API'] = '❌ Invalid API Key (401/403)';
      } else if (e.response.status === 429) {
        statuses['Sportradar API'] = '❌ Rate Limited (429)';
      } else {
        statuses['Sportradar API'] = `❌ Error (${e.response.status})`;
      }
    } else {
      statuses['Sportradar API'] = '❌ Offline (Network Error)';
    }
  }

  // NEW: Check API-Sports (if configured)
  if (env.APISPORTS_API_KEY) {
    try {
      const apiSportsUrl = 'https://v1.basketball.api-sports.io/status';
      const apiSportsRes = await axios.get(apiSportsUrl, { 
        headers: { 'x-apisports-key': env.APISPORTS_API_KEY },
        timeout: 5000 
      });
      
      if (apiSportsRes.status === 200) {
        const data = apiSportsRes.data;
        if (data.response && data.response.requests && data.response.requests.current < data.response.requests.limit_day) {
          statuses['API-Sports'] = `✅ Online (${data.response.requests.current}/${data.response.requests.limit_day} used)`;
        } else {
          statuses['API-Sports'] = '⚠️ Online (Rate Limited)';
        }
      } else {
        statuses['API-Sports'] = `❌ Error (${apiSportsRes.status})`;
      }
    } catch (e) {
      if (e.response) {
        if (e.response.status === 401) {
          statuses['API-Sports'] = '❌ Invalid API Key (401)';
        } else if (e.response.status === 429) {
          statuses['API-Sports'] = '❌ Rate Limited (429)';
        } else {
          statuses['API-Sports'] = `❌ Error (${e.response.status})`;
        }
      } else {
        statuses['API-Sports'] = '❌ Offline (Network Error)';
      }
    }
  } else {
    statuses['API-Sports'] = '🔴 Not Configured';
  }

  // NEW: Check Supabase
  try {
    const stats = await databaseService.getDatabaseStats();
    if (stats && stats.status === 'healthy') {
      statuses['Supabase Database'] = `✅ Online (${stats.total_games || 0} games)`;
    } else {
      statuses['Supabase Database'] = '❌ Unhealthy';
    }
  } catch (e) {
    statuses['Supabase Database'] = `❌ Error: ${e.message}`;
  }

  // NEW: Check Redis
  try {
    const redis = await getRedisClient();
    if (redis) {
      const pingResult = await redis.ping();
      if (pingResult === 'PONG') {
        const dbsize = await redis.dbsize();
        statuses['Redis Cache'] = `✅ Online (${dbsize} keys)`;
      } else {
        statuses['Redis Cache'] = '❌ Ping Failed';
      }
    } else {
      statuses['Redis Cache'] = '❌ Not Connected';
    }
  } catch (e) {
    statuses['Redis Cache'] = `❌ Error: ${e.message}`;
  }

  let statusText = '*📡 COMPREHENSIVE API STATUS REPORT*\n\n';
  
  // Group services by category
  statusText += '*🤖 AI Services:*\n';
  ['Google Gemini', 'Perplexity AI'].forEach(api => {
    statusText += `• ${api}: ${statuses[api]}\n`;
  });
  
  statusText += '\n*📊 Odds Data Providers:*\n';
  ['The Odds API', 'Sportradar API', 'API-Sports'].forEach(api => {
    statusText += `• ${api}: ${statuses[api]}\n`;
  });
  
  statusText += '\n*💾 Infrastructure:*\n';
  ['Supabase Database', 'Redis Cache'].forEach(api => {
    statusText += `• ${api}: ${statuses[api]}\n`;
  });
  
  await bot.editMessageText(statusText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Back to Tools', callback_data: 'tools_main' }]] }
  });
}

// FIXED: Enhanced database stats with better error handling
async function handleDbStats(bot, chatId, messageId) {
    await bot.editMessageText('📊 Fetching database and API quota statistics...', { 
        chat_id: chatId, 
        message_id: messageId 
    });
    
    try {
        let statsText = '';
        
        // Database Game Counts - with error handling
        try {
            const stats = await databaseService.getSportGameCounts();
            statsText = '📊 *Database Game Counts*\n\n';
            
            if (stats && stats.length > 0) {
                let hasValidData = false;
                
                stats.forEach(stat => {
                    const title = stat.sport_title || stat.sport_key || 'Unknown/Other';
                    // FIX: Handle undefined game_count properly
                    const count = stat.game_count !== undefined && stat.game_count !== null 
                        ? stat.game_count 
                        : 0;
                    
                    if (count > 0) hasValidData = true;
                    
                    statsText += `• *${title}:* ${count} games\n`;
                });
                
                if (!hasValidData) {
                    statsText += '_No games with valid counts found in database._\n';
                }
            } else {
                statsText += 'No sports data found in the database.\n';
            }
        } catch (dbError) {
            console.error('Database stats error:', dbError);
            statsText = '📊 *Database Game Counts*\n\n';
            statsText += '❌ Failed to fetch database stats.\n';
            statsText += `_Error: ${dbError.message}_\n\n`;
        }

        // API Quota Status - with enhanced error handling
        statsText += '\n📈 *API Quota Status (Live)*\n';
        statsText += '_Data reflects the last API call made by a worker._\n\n';
        
        const providers = ['theodds', 'sportradar', 'apisports'];
        let hasQuotaData = false;
        
        for (const provider of providers) {
            try {
                const quota = await rateLimitService.getProviderQuota(provider);
                const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
                statsText += `*${providerName}*:\n`;
                
                if (quota && (quota.remaining !== null || quota.used !== null)) {
                    hasQuotaData = true;
                    const remaining = quota.remaining ?? 'N/A';
                    const used = quota.used ?? 'N/A';
                    const limit = quota.limit ?? 'N/A';
                    const lastUpdated = quota.at ? new Date(quota.at).toLocaleTimeString() : 'Never';
                    const critical = quota.critical ? ' ⚠️' : '';
                    
                    statsText += `  - Remaining: ${remaining}${critical}\n`;
                    statsText += `  - Used: ${used}\n`;
                    statsText += `  - Limit/Window: ${limit}\n`;
                    statsText += `  - Last Updated: ${lastUpdated}\n`;
                } else {
                    statsText += '  - _No quota data recorded yet._\n';
                    // Provide guidance based on provider
                    if (provider === 'theodds' && !env.THE_ODDS_API_KEY) {
                        statsText += '  - _THE_ODDS_API_KEY not configured_\n';
                    } else if (provider === 'sportradar' && !env.SPORTRADAR_API_KEY) {
                        statsText += '  - _SPORTRADAR_API_KEY not configured_\n';
                    } else if (provider === 'apisports' && !env.APISPORTS_API_KEY) {
                        statsText += '  - _APISPORTS_API_KEY not configured_\n';
                    } else {
                        statsText += '  - _Trigger odds ingestion to populate._\n';
                    }
                }
                statsText += '\n';
            } catch (quotaError) {
                console.error(`Quota check error for ${provider}:`, quotaError);
                statsText += `*${provider}*:\n`;
                statsText += '  - ❌ Error fetching quota data\n';
                statsText += `  - _${quotaError.message}_\n\n`;
            }
        }

        // Add troubleshooting guidance if no data
        if (!hasQuotaData) {
            statsText += '\n🔧 *Troubleshooting:*\n';
            statsText += '• Use "Trigger Odds Ingestion" to populate data\n';
            statsText += '• Check API keys are configured correctly\n';
            statsText += '• Verify worker logs for any errors\n';
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
