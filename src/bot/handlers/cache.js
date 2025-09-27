// src/bot/handlers/cache.js

import cron from 'node-cron';
import { getGamesForSportCached } from '../../services/oddsCacheAdapters.js';
import redisService from '../../services/redisService.js';

// Real refreshCache that clears Redis "games" keys and re-caches odds for top sports
// Add sports or use logic to get your sports list as needed
async function refreshCache() {
  const sports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb']; // update with your relevant keys
  for (const sport of sports) {
    // This will trigger adapter to update cached data
    await getGamesForSportCached(sport, { forceRefresh: true });
  }
  // Optionally, clear extra Redis keys if you want a hard reset:
  // await redisService.flushAll(); // use with caution!
}

export function registerCacheHandler(bot) {
  // On-demand cache refresh command
  bot.onText(/^\/cache refresh$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await refreshCache();
      await bot.sendMessage(chatId, '✅ Cache refreshed.');
    } catch (e) {
      console.error('Cache refresh error:', e);
      await bot.sendMessage(chatId, '❌ Cache refresh failed.');
    }
  });

  // Auto-refresh scheduled every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await refreshCache();
      console.log('🗄️ Cache auto-refreshed.');
    } catch (e) {
      console.error('Auto cache refresh error:', e);
    }
  });
}
