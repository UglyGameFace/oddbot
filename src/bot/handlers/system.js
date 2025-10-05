// src/bot/handlers/system.js - COMPLETELY FIXED
import pidusage from 'pidusage';
import healthService from '../../services/healthService.js';

const formatUptime = (seconds) => {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor(seconds % (3600 * 24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
};

export function registerSystem(bot) {
  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /start command from ${chatId}`);
    
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
    
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ Error sending start message:', error);
    }
  });

  bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /help command from ${chatId}`);
    
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
    
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ Error sending help message:', error);
    }
  });
  
  bot.onText(/^\/ping$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /ping command from ${chatId}`);
    
    try {
      const startTime = Date.now();
      const sentMsg = await bot.sendMessage(chatId, 'Pinging...');
      const endTime = Date.now();
      const latency = endTime - startTime;
      
      await bot.editMessageText(`Pong! 🏓\nLatency: ${latency}ms`, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
      });
    } catch (error) {
      console.error('❌ Error in ping command:', error);
      bot.sendMessage(chatId, '❌ Ping failed. Please try again.');
    }
  });

  bot.onText(/^\/status$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /status command from ${chatId}`);
    
    try {
      const waitingMsg = await bot.sendMessage(chatId, '📊 Generating system status report...');
      
      const [stats, health] = await Promise.all([
        pidusage(process.pid).catch(() => ({ memory: 0, cpu: 0 })),
        healthService.getHealth().catch(() => ({ ok: false, database: { ok: false }, redis: { ok: false } }))
      ]);
      
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
• *Database:* ${health?.database?.ok ? '✅ Connected' : '❌ Disconnected'}
• *Redis Cache:* ${health?.redis?.ok ? '✅ Connected' : '❌ Disconnected'}
• *Overall Health:* ${health?.ok ? '✅ Healthy' : '❌ Degraded'}
      `;

      await bot.editMessageText(statusText, {
        chat_id: chatId,
        message_id: waitingMsg.message_id,
        parse_mode: 'Markdown',
      });
    } catch (error) {
      console.error("❌ Failed to generate status report:", error);
      bot.sendMessage(chatId, '❌ Failed to generate status report. Please check the logs.');
    }
  });
}

export function registerSystemCallbacks(bot) {
  // System callbacks can be added here if needed
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('sys_')) return;
    
    // Handle system callbacks here if needed
  });
}
