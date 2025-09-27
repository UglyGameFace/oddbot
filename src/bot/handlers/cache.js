// src/bot/handlers/cache.js
import cron from 'node-cron';
import oddsService from '../../services/oddsService.js';

async function refreshCache() {
  const sports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb'];
  console.log('🔄 Running scheduled cache refresh...');
  for (const sport of sports) {
    await oddsService.getGamesForSportCached(sport);
  }
  console.log('✅ Cache refresh complete.');
}

export function registerCacheHandler(bot) {
  bot.onText(/^\/cache refresh$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId, 'Manual cache refresh initiated...');
      await refreshCache();
      await bot.sendMessage(chatId, '✅ Cache refreshed successfully.');
    } catch (e) {
      console.error('Manual cache refresh error:', e);
      await bot.sendMessage(chatId, '❌ Cache refresh failed.');
    }
  });

  // Auto-refresh scheduled every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await refreshCache();
    } catch (e) {
      console.error('Auto cache refresh error:', e);
    }
  });
}
