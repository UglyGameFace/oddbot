// src/bot/handlers/cache.js

import cron from 'node-cron';
import gamesService from '../../services/gamesService.js';
import oddsService from '../../services/oddsService.js';
import { sentryService } from '../../services/sentryService.js';

/**
 * Refreshes the cache for a predefined list of popular sports.
 * This is optimized to reduce API quota usage by not fetching every sport.
 */
async function refreshCache() {
  console.log('🔄 Running scheduled cache refresh for popular sports...');
  try {
    // Define a list of only the sports you care about to save API quota
    const popularSportKeys = [
      'americanfootball_nfl',
      'basketball_nba',
      'baseball_mlb',
      'icehockey_nhl'
    ];

    // Trigger a cache update for each popular sport
    for (const sport of popularSportKeys) {
      // By calling getSportOdds, the oddsService will automatically fetch
      // live data and update the Redis cache according to its internal logic.
      await oddsService.getSportOdds(sport);
    }
    console.log('✅ Cache refresh complete for popular sports.');
  } catch (error) {
    console.error('Auto cache refresh error:', error);
    sentryService.captureError(error, { component: 'cache_handler' });
  }
}

export function registerCacheHandler(bot) {
  // --- On-demand cache refresh command ---
  bot.onText(/^\/cache$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId, '⏳ Initiating manual cache refresh for popular sports...');
      await refreshCache();
      await bot.sendMessage(chatId, '✅ Cache refresh complete.');
    } catch (e) {
      console.error('Manual cache refresh error:', e);
      sentryService.captureError(e, { component: 'cache_handler_manual' });
      await bot.sendMessage(chatId, '❌ Cache refresh failed. Please check the logs.');
    }
  });

  // --- Auto-refresh scheduled every hour ---
  // Changed from 15 minutes to 1 hour to reduce API usage.
  cron.schedule('0 * * * *', () => {
    refreshCache();
  });
}
