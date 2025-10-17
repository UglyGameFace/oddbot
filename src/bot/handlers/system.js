// src/bot/handlers/system.js - FIXED HEALTH CHECK STRUCTURE
import pidusage from 'pidusage';
import healthService from '../../services/healthService.js';
import { getRedisClient } from '../../services/redisService.js';

const formatUptime = (seconds) => {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor(seconds % (3600 * 24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
};

export function registerSystem(bot) {
  bot.onText(/^\/start$/, (msg) => {
    const chatId = msg.chat.id;
    const text = `
Welcome to the *Institutional AI Parlay Bot*! 🚀

I'm here to help you build smarter parlays using advanced AI and data analysis.

Here are the main commands to get you started:
• \`/ai\` - Launches the interactive AI Parlay Builder.
• \`/custom\` - Manually build your own parlay slip.
• \`/player\` - Search for props for a specific player.
• \`/settings\` - Configure your personal preferences.

For a full list of commands, please use \`/help\`.
    `;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/^\/help$/, (msg) => {
    const chatId = msg.chat.id;
    const text = `
*📖 Bot Command Guide*

*Core Features*
• \`/ai\` - The main event. Launches a step-by-step interactive menu to build a parlay using different AI models and analysis modes.
• \`/custom\` - Manually browse upcoming games and build your own parlay from scratch.
• \`/player\` - Asks for a player's name and searches for all their available props across all sports.
• \`/settings\` - The control panel. Configure default behaviors for the AI and the Custom Builder.

*System Commands*
• \`/status\` - Shows a real-time report of the bot's operational status, memory usage, and service health.
• \`/ping\` - Checks the bot's responsiveness and API latency.
• \`/help\` - Displays this help message.
• \`/start\` - Shows the welcome message.

*Debug Commands*
• \`/debugsettings\` - Comprehensive settings debug report
• \`/fixsettings\` - Reset settings to defaults
• \`/testredis\` - Test Redis connection
    `;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });
  
  bot.onText(/^\/ping$/, async (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    const sentMsg = await bot.sendMessage(chatId, 'Pinging...');
    const endTime = Date.now();
    const latency = endTime - startTime;
    bot.editMessageText(`Pong! 🏓\nLatency: ${latency}ms`, {
      chat_id: chatId,
      message_id: sentMsg.message_id,
    });
  });

  bot.onText(/^\/status$/, async (msg) => {
    const chatId = msg.chat.id;
    const waitingMsg = await bot.sendMessage(chatId, '📊 Generating system status report...');
    
    try {
      const [stats, health, redis] = await Promise.all([
        pidusage(process.pid),
        healthService.getHealth(),
        getRedisClient()
      ]);
      
      const memoryUsage = (stats.memory / 1024 / 1024).toFixed(2);
      const cpuUsage = stats.cpu.toFixed(2);
      const uptime = formatUptime(process.uptime());

      // Test Redis connection
      let redisStatus = '❌ Disconnected';
      let redisKeys = 0;
      if (redis) {
        try {
          await redis.ping();
          redisKeys = await redis.dbsize();
          redisStatus = `✅ Connected (${redisKeys} keys)`;
        } catch (error) {
          redisStatus = '❌ Ping Failed';
        }
      }

      // FIXED: Proper health check structure with fallbacks
      const databaseStatus = health?.services?.database?.ok ? '✅ Connected' : '❌ Disconnected';
      const oddsStatus = health?.services?.odds?.ok ? '✅ Connected' : '❌ Disconnected';
      const gamesStatus = health?.services?.games?.ok ? '✅ Connected' : '❌ Disconnected';
      const overallHealth = health?.overall?.healthy ? '✅ Healthy' : '❌ Degraded';

      const statusText = `
*🤖 Bot Status Report*

*Process*
• *Uptime:* ${uptime}
• *CPU Usage:* ${cpuUsage}%
• *Memory Usage:* ${memoryUsage} MB
• *Node.js Version:* ${process.version}

*Services*
• *Database:* ${databaseStatus}
• *Redis Cache:* ${redisStatus}
• *Odds Service:* ${oddsStatus}
• *Games Service:* ${gamesStatus}
• *Overall Health:* ${overallHealth}

*Environment*
• *Mode:* ${process.env.NODE_ENV || 'development'}
• *Platform:* ${process.platform}
• *Arch:* ${process.arch}
      `;

      await bot.editMessageText(statusText, {
        chat_id: chatId,
        message_id: waitingMsg.message_id,
        parse_mode: 'Markdown',
      });
    } catch (error) {
      console.error("Failed to generate status report:", error);
      await bot.editMessageText('❌ Failed to generate status report. Please check the logs.', {
        chat_id: chatId,
        message_id: waitingMsg.message_id,
      });
    }
  });
}

export function registerSystemCallbacks(bot) {
  // No callbacks needed for system commands
}
