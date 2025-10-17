// src/bot/handlers/debugSettings.js - COMPREHENSIVE SETTINGS DEBUGGER
import { getAIConfig, setAIConfig, getBuilderConfig, setBuilderConfig } from '../state.js';
import { getRedisClient } from '../../services/redisService.js';

export function registerDebugSettings(bot) {
  bot.onText(/^\/debugsettings$/, async (msg) => {
    const chatId = msg.chat.id;
    await debugSettingsFlow(bot, chatId);
  });

  bot.onText(/^\/fixsettings$/, async (msg) => {
    const chatId = msg.chat.id;
    await resetAndFixSettings(bot, chatId);
  });

  bot.onText(/^\/testredis$/, async (msg) => {
    const chatId = msg.chat.id;
    await testRedisConnection(bot, chatId);
  });
}

async function debugSettingsFlow(bot, chatId) {
  let debugMessage = `🔧 <b>SETTINGS DEBUG REPORT</b>\n\n`;
  
  try {
    // Test 1: Basic Redis connection
    debugMessage += `<b>1. Redis Connection Test:</b>\n`;
    const redis = await getRedisClient();
    if (redis) {
      const ping = await redis.ping();
      debugMessage += `✅ Redis: ${ping}\n`;
      debugMessage += `📊 Status: ${redis.status}\n`;
    } else {
      debugMessage += `❌ Redis: NOT CONNECTED\n`;
    }

    // Test 2: Get AI Config
    debugMessage += `\n<b>2. AI Config Retrieval:</b>\n`;
    const aiConfig = await getAIConfig(chatId);
    debugMessage += `✅ AI Config: ${JSON.stringify(aiConfig, null, 2)}\n`;

    // Test 3: Get Builder Config  
    debugMessage += `\n<b>3. Builder Config Retrieval:</b>\n`;
    const builderConfig = await getBuilderConfig(chatId);
    debugMessage += `✅ Builder Config: ${JSON.stringify(builderConfig, null, 2)}\n`;

    // Test 4: Check Redis keys directly
    debugMessage += `\n<b>4. Direct Redis Key Check:</b>\n`;
    if (redis) {
      const aiKey = `user:config:${chatId}:ai`;
      const builderKey = `user:config:${chatId}:builder`;
      
      const rawAI = await redis.get(aiKey);
      const rawBuilder = await redis.get(builderKey);
      
      debugMessage += `AI Key (${aiKey}): ${rawAI ? 'EXISTS' : 'MISSING'}\n`;
      debugMessage += `Builder Key (${builderKey}): ${rawBuilder ? 'EXISTS' : 'MISSING'}\n`;
      
      if (rawAI) debugMessage += `AI Raw: ${rawAI}\n`;
      if (rawBuilder) debugMessage += `Builder Raw: ${rawBuilder}\n`;
    }

    // Test 5: Test setting a value
    debugMessage += `\n<b>5. Config Set/Get Test:</b>\n`;
    const testConfig = { ...aiConfig, test_timestamp: Date.now() };
    await setAIConfig(chatId, testConfig);
    const verifyConfig = await getAIConfig(chatId);
    
    if (verifyConfig.test_timestamp === testConfig.test_timestamp) {
      debugMessage += `✅ Set/Get Test: PASSED\n`;
    } else {
      debugMessage += `❌ Set/Get Test: FAILED\n`;
      debugMessage += `Expected: ${testConfig.test_timestamp}\n`;
      debugMessage += `Got: ${verifyConfig.test_timestamp}\n`;
    }

  } catch (error) {
    debugMessage += `\n❌ ERROR: ${error.message}\n`;
    debugMessage += `Stack: ${error.stack}\n`;
  }

  await bot.sendMessage(chatId, debugMessage, { parse_mode: 'HTML' });
}

async function resetAndFixSettings(bot, chatId) {
  try {
    // Reset to defaults
    const defaultAIConfig = {
      mode: 'web',
      betType: 'mixed', 
      horizonHours: 72,
      proQuantMode: false,
      bookmakers: ['draftkings', 'fanduel']
    };

    const defaultBuilderConfig = {
      avoidSameGame: true
    };

    await setAIConfig(chatId, defaultAIConfig);
    await setBuilderConfig(chatId, defaultBuilderConfig);

    const verifyAI = await getAIConfig(chatId);
    const verifyBuilder = await getBuilderConfig(chatId);

    const message = `🔄 <b>Settings Reset Complete</b>\n\n` +
      `AI Config: ${JSON.stringify(verifyAI, null, 2)}\n\n` +
      `Builder Config: ${JSON.stringify(verifyBuilder, null, 2)}\n\n` +
      `Now try changing settings again.`;

    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Reset failed: ${error.message}`, { parse_mode: 'HTML' });
  }
}

async function testRedisConnection(bot, chatId) {
  try {
    const redis = await getRedisClient();
    let message = `<b>🔍 Redis Connection Test</b>\n\n`;
    
    if (!redis) {
      message += `❌ Redis client is null\n`;
      message += `📡 REDIS_URL: ${process.env.REDIS_URL ? 'SET' : 'NOT SET'}\n`;
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      return;
    }

    message += `📊 Status: ${redis.status}\n`;
    message += `🔗 Connected: ${redis.status === 'ready' ? '✅' : '❌'}\n`;

    // Test ping
    const start = Date.now();
    const pingResult = await redis.ping();
    const latency = Date.now() - start;
    
    message += `🏓 Ping: ${pingResult} (${latency}ms)\n`;

    // Test set/get
    const testKey = `test:${chatId}:${Date.now()}`;
    const testValue = `test_value_${Date.now()}`;
    
    await redis.set(testKey, testValue, 'EX', 60);
    const retrieved = await redis.get(testKey);
    
    message += `💾 Set/Get Test: ${retrieved === testValue ? '✅' : '❌'}\n`;
    message += `📝 Written: ${testValue}\n`;
    message += `📖 Read: ${retrieved}\n`;

    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Redis test failed: ${error.message}`, { parse_mode: 'HTML' });
  }
}

export function registerDebugCallbacks(bot) {
  // No callbacks needed for debug
}
