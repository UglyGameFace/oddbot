// src/bot/handlers/cache.js

import cron from 'node-cron';
import gamesService from '../../services/gamesService.js';
import oddsService from '../../services/oddsService.js';
import { sentryService } from '../../services/sentryService.js';

/**
 * Refreshes the cache for all sports available in the database.
 * This function now uses the modern, two-step approach:
 * 1. Get the list of all sports from our database (fast and cheap).
 * 2. For each sport, call the live odds service to fetch and cache the latest data.
 */
async function refreshCache() {
  console.log('🔄 Running scheduled cache refresh...');
  try {
    const availableSports = await gamesService.getAvailableSports();
    if (!availableSports || availableSports.length === 0) {
      console.log('No sports found in the database to refresh.');
      return;
    }

    const sportKeys = availableSports.map(s => s.sport_key);

    // Trigger a cache update for each sport
    for (const sport of sportKeys) {
      // By calling getSportOdds, the oddsService will automatically fetch
      // live data and update the Redis cache according to its internal logic.
      await oddsService.getSportOdds(sport);
    }
    console.log('✅ Cache refresh complete for all available sports.');
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
      await bot.sendMessage(chatId, '⏳ Initiating manual cache refresh for all sports...');
      await refreshCache();
      await bot.sendMessage(chatId, '✅ Cache refresh complete.');
    } catch (e) {
      console.error('Manual cache refresh error:', e);
      sentryService.captureError(e, { component: 'cache_handler_manual' });
      await bot.sendMessage(chatId, '❌ Cache refresh failed. Please check the logs.');
    }
  });

  // --- Auto-refresh scheduled every 15 minutes ---
  // Note: A 15-minute interval is safer for API rate limits than 5 minutes.
  cron.schedule('*/15 * * * *', () => {
    refreshCache();
  });
}
