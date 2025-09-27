// src/bot/handlers/system.js
export function registerSystem(bot) {
  // Keep all existing commands and handlers exactly as-is
  bot.setMyCommands([
    { command: '/start', description: 'Welcome & Menu' },
    { command: '/parlay', description: '✨ AI Analyst Parlay' },
    { command: '/custom', description: '✍️ Manual Parlay Builder' },
    { command: '/player', description: '🤵 Parlay by Player' },
    { command: '/quant', description: '⚡️ Quick Quant Picks' },
    { command: '/settings', description: 'Builder & AI Settings' },
    { command: '/calc', description: 'Odds calculator' },
    { command: '/kelly', description: 'Kelly stake: /kelly <p> <odds>' },
    { command: '/stake', description: 'Set slip stake: /stake <amount>' },
    { command: '/exclusions', description: 'List team exclusions' },
    { command: '/exclude_team', description: 'Exclude team: /exclude_team <name>' },
    { command: '/clear_exclusions', description: 'Clear team exclusions' },
  ]);

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
      chatId,
      `Welcome — build parlays via AI, quant, player props, manual legs, inline mode, and bankroll tools.\nTry /parlay, /custom, /player, /quant, /calc, /kelly, and /settings.`,
    );
  });

  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
      chatId,
      `Help\n• /parlay — AI: legs/strategy/props/sports + build on fresh odds\n• /custom — manual builder with per‑leg control\n• /player — search a player and add props\n• /quant — heaviest ML favorite today\n• /calc <odds...> — combine odds & probability\n• /kelly <p> <odds> — stake fraction by Kelly\n• /stake <amount> — set current slip stake\n• /settings — filters, SGP avoid, odds range, hours`,
    );
  });

  // NEW: Minimal callback ack so taps complete; does not change routing or add UI
  bot.on('callback_query', async (q) => {
    try {
      await bot.answerCallbackQuery(q.id, { cache_time: 0 }); // silent ack to stop spinner [Telegram Bot API]
      // Do not modify existing flows; your current handlers that inspect q.data keep working
      // If custom routing is needed, it should remain in your existing modules
    } catch (e) {
      // Keep quiet in chat; errors are handled by global/Sentry in the app
      console.error('callback ack failed:', e?.message || e);
    }
  });
}
