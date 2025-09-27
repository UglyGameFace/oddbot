// src/bot/handlers/cache.js

import gamesService from '../../services/gamesService.js';
import oddsService from '../../services/oddsService.js';
import { sentryService } from '../../services/sentryService.js';

/**
 * Refreshes the cache for a predefined list of popular sports.
 * This is optimized to reduce API quota usage by not fetching every sport.
 */
async function refreshCache() {
  console.log('🔄 Running manual cache refresh for popular sports...');
  try {
    // Define a list of only the sports you care about
    const popularSportKeys = [
      'americanfootball_nfl',
      'americanfootball_ncaaf',
      'basketball_nba',
      'basketball_wnba',
      'baseball_mlb',
    ];

    // Trigger a cache update for each popular sport
    for (const sport of popularSportKeys) {
      // By calling getSportOdds, the oddsService will automatically fetch
      // live data and update the Redis cache according to its internal logic.
      await oddsService.getSportOdds(sport);
    }
    console.log('✅ Cache refresh complete for popular sports.');
  } catch (error) {
    console.error('Manual cache refresh error:', error);
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

  // Automatic scheduled refresh has been removed.
}
