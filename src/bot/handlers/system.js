// src/bot/handlers/system.js

import pidusage from 'pidusage';
import healthService from '../../services/healthService.js';

// Helper function to format uptime from seconds into a readable string
const formatUptime = (seconds) => {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor(seconds % (3600 * 24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
};

export function registerSystem(bot) {
  // --- /start command ---
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

  // --- /help command ---
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
    `;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });
  
  // --- /ping command ---
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

  // --- /status command ---
  bot.onText(/^\/status$/, async (msg) => {
    const chatId = msg.chat.id;
    const waitingMsg = await bot.sendMessage(chatId, '📊 Generating system status report...');
    
    try {
      const stats = await pidusage(process.pid);
      const health = await healthService.getHealth();
      
      const memoryUsage = (stats.memory / 1024 / 1024).toFixed(2); // in MB
      const cpuUsage = stats.cpu.toFixed(2);
      const uptime = formatUptime(process.uptime());

      const statusText = `
*🤖 Bot Status Report*

*Process*
• *Uptime:* ${uptime}
• *CPU Usage:* ${cpuUsage}%
• *Memory Usage:* ${memoryUsage} MB
• *Node.js Version:* ${process.version}

*Services*
• *Database:* ${health.database.ok ? '✅ Connected' : '❌ Disconnected'}
• *Redis Cache:* ${health.redis.ok ? '✅ Connected' : '❌ Disconnected'}
• *Overall Health:* ${health.ok ? '✅ Healthy' : '❌ Degraded'}
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
  // This handler does not currently use callbacks, but the function is here for future expansion and consistency.
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('sys_')) return;
    // Future callback logic for system commands can go here.
  });
}
