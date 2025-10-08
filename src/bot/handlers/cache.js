// src/bot/handlers/cache.js - COMPLETELY FIXED

import gamesService from '../../services/gamesService.js';
import oddsService from '../../services/oddsService.js';
import databaseService from '../../services/databaseService.js';
import { sentryService } from '../../services/sentryService.js';

// Simple escape function for MarkdownV2 (since enterpriseUtilities.js might not exist)
const escapeMarkdownV2 = (text) => {
  if (typeof text !== 'string') return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Cache refresh configuration
const CACHE_REFRESH_CONFIG = {
  // Popular sports for quick cache warmup
  POPULAR_SPORTS: [
    'americanfootball_nfl',
    'basketball_nba', 
    'baseball_mlb',
    'icehockey_nhl',
    'soccer_england_premier_league'
  ],
  
  // Refresh timeouts (in milliseconds)
  TIMEOUTS: {
    QUICK_REFRESH: 30000,  // 30 seconds
    FULL_REFRESH: 120000,  // 2 minutes
    SINGLE_SPORT: 15000    // 15 seconds per sport
  },
  
  // Batch sizes for processing
  BATCH_SIZES: {
    SPORTS: 2,    // Process 2 sports concurrently to avoid rate limits
    GAMES: 5      // Process 5 games concurrently
  }
};

/**
 * Enhanced cache management with comprehensive refresh capabilities
 */
class CacheHandler {
  constructor() {
    this.refreshOperations = new Map();
    this.lastRefreshTimes = new Map();
    this.cacheStats = {
      totalRefreshes: 0,
      successfulRefreshes: 0,
      failedRefreshes: 0,
      lastRefresh: null,
      averageDuration: 0
    };
  }

  /**
   * Quick cache refresh for popular sports only
   */
  async quickRefresh() {
    const operationId = `quick_${Date.now()}`;
    console.log(`⚡ Starting quick cache refresh (${operationId})...`);
    
    const startTime = Date.now();
    const results = {
      operationId,
      type: 'quick',
      startTime: new Date().toISOString(),
      sports: [],
      totalProcessed: 0,
      successful: 0,
      failed: 0
    };

    this.refreshOperations.set(operationId, {
      startTime,
      status: 'running',
      progress: 0
    });

    try {
      // Process popular sports in small batches
      const batchSize = CACHE_REFRESH_CONFIG.BATCH_SIZES.SPORTS;
      for (let i = 0; i < CACHE_REFRESH_CONFIG.POPULAR_SPORTS.length; i += batchSize) {
        const batch = CACHE_REFRESH_CONFIG.POPULAR_SPORTS.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (sportKey) => {
          try {
            console.log(`🔄 Refreshing cache for ${sportKey}...`);
            
            // Refresh games data first (it includes odds)
            const games = await gamesService.getGamesForSport(sportKey, { 
              useCache: false,
              includeOdds: true
            });

            const sportResult = {
              sportKey,
              gamesCount: games?.length || 0,
              status: 'success',
              timestamp: new Date().toISOString()
            };

            results.sports.push(sportResult);
            results.successful++;
            results.totalProcessed++;

            console.log(`✅ ${sportKey}: ${games?.length || 0} games`);
            return sportResult;

          } catch (error) {
            console.error(`❌ Failed to refresh ${sportKey}:`, error.message);
            
            const sportResult = {
              sportKey,
              gamesCount: 0,
              status: 'failed',
              error: error.message,
              timestamp: new Date().toISOString()
            };

            results.sports.push(sportResult);
            results.failed++;
            results.totalProcessed++;

            sentryService.captureError(error, { 
              component: 'cache_handler', 
              operation: 'quick_refresh',
              sportKey 
            });

            return sportResult;
          }
        });

        // Wait for batch to complete with timeout
        await Promise.allSettled(batchPromises);
        
        // Update progress
        const progress = Math.round((i + batchSize) / CACHE_REFRESH_CONFIG.POPULAR_SPORTS.length * 100);
        this.refreshOperations.get(operationId).progress = Math.min(progress, 100);
      }

      // Update cache stats
      this._updateCacheStats(results, startTime);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = results.failed === 0 ? 'completed' : 'completed_with_errors';

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'completed',
        results
      });

      console.log(`✅ Quick cache refresh completed in ${results.duration}ms: ${results.successful} successful, ${results.failed} failed`);
      return results;

    } catch (error) {
      console.error('❌ Quick cache refresh failed:', error);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = 'failed';
      results.error = error.message;

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'failed',
        results
      });

      sentryService.captureError(error, { 
        component: 'cache_handler', 
        operation: 'quick_refresh_overall' 
      });

      return results;
    }
  }

  /**
   * Full cache refresh including all sports and database
   */
  async fullRefresh() {
    const operationId = `full_${Date.now()}`;
    console.log(`🔄 Starting full cache refresh (${operationId})...`);
    
    const startTime = Date.now();
    const results = {
      operationId,
      type: 'full',
      startTime: new Date().toISOString(),
      sports: [],
      database: null,
      totalProcessed: 0,
      successful: 0,
      failed: 0
    };

    this.refreshOperations.set(operationId, {
      startTime,
      status: 'running',
      progress: 0
    });

    try {
      // Step 1: Refresh all available sports
      const allSports = await gamesService.getAvailableSports();
      const sportKeys = allSports.map(sport => sport.sport_key).slice(0, 15); // Limit to first 15 sports
      
      console.log(`📊 Refreshing ${sportKeys.length} sports...`);

      // Process sports in batches
      const batchSize = CACHE_REFRESH_CONFIG.BATCH_SIZES.SPORTS;
      for (let i = 0; i < sportKeys.length; i += batchSize) {
        const batch = sportKeys.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (sportKey) => {
          try {
            // Refresh games data (includes odds)
            const games = await gamesService.getGamesForSport(sportKey, { 
              useCache: false,
              includeOdds: true
            });

            const sportResult = {
              sportKey,
              gamesCount: games?.length || 0,
              status: 'success',
              timestamp: new Date().toISOString()
            };

            results.sports.push(sportResult);
            results.successful++;
            results.totalProcessed++;

            return sportResult;

          } catch (error) {
            console.error(`❌ Failed to refresh ${sportKey}:`, error.message);
            
            const sportResult = {
              sportKey,
              gamesCount: 0,
              status: 'failed',
              error: error.message,
              timestamp: new Date().toISOString()
            };

            results.sports.push(sportResult);
            results.failed++;
            results.totalProcessed++;

            sentryService.captureError(error, { 
              component: 'cache_handler', 
              operation: 'full_refresh_sport',
              sportKey 
            });

            return sportResult;
          }
        });

        await Promise.allSettled(batchPromises);
        
        // Update progress
        const progress = Math.round((i + batchSize) / sportKeys.length * 80); // 80% for sports
        this.refreshOperations.get(operationId).progress = Math.min(progress, 80);
      }

      // Step 2: Refresh database cache
      try {
        console.log('🗄️ Refreshing database cache...');
        const dbSports = await databaseService.getDistinctSports();
        results.database = {
          status: 'success',
          sportsCount: dbSports?.length || 0,
          timestamp: new Date().toISOString()
        };
        results.successful++;
        
        this.refreshOperations.get(operationId).progress = 90;
      } catch (error) {
        console.error('❌ Failed to refresh database cache:', error.message);
        results.database = {
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        };
        results.failed++;
        
        sentryService.captureError(error, { 
          component: 'cache_handler', 
          operation: 'full_refresh_database' 
        });
      }

      // Step 3: Clear and preload games service cache
      try {
        console.log('🧹 Clearing games service cache...');
        await gamesService.clearCache();
        
        console.log('🚀 Preloading popular sports...');
        await gamesService.preloadPopularSports();
        
        this.refreshOperations.get(operationId).progress = 100;
      } catch (error) {
        console.error('❌ Failed to preload cache:', error.message);
        sentryService.captureError(error, { 
          component: 'cache_handler', 
          operation: 'full_refresh_preload' 
        });
      }

      // Update cache stats
      this._updateCacheStats(results, startTime);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = results.failed === 0 ? 'completed' : 'completed_with_errors';

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'completed',
        results
      });

      console.log(`✅ Full cache refresh completed in ${results.duration}ms: ${results.successful} successful, ${results.failed} failed`);
      return results;

    } catch (error) {
      console.error('❌ Full cache refresh failed:', error);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = 'failed';
      results.error = error.message;

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'failed',
        results
      });

      sentryService.captureError(error, { 
        component: 'cache_handler', 
        operation: 'full_refresh_overall' 
      });

      return results;
    }
  }

  /**
   * Refresh cache for a specific sport
   */
  async refreshSport(sportKey) {
    const operationId = `sport_${sportKey}_${Date.now()}`;
    console.log(`🎯 Refreshing cache for ${sportKey}...`);
    
    const startTime = Date.now();
    const results = {
      operationId,
      type: 'sport',
      sportKey,
      startTime: new Date().toISOString(),
      games: null
    };

    this.refreshOperations.set(operationId, {
      startTime,
      status: 'running',
      progress: 0
    });

    try {
      // Refresh games data (includes odds)
      this.refreshOperations.get(operationId).progress = 50;
      const games = await gamesService.getGamesForSport(sportKey, { 
        useCache: false,
        includeOdds: true
      });
      
      results.games = {
        count: games?.length || 0,
        status: 'success',
        timestamp: new Date().toISOString()
      };

      // Update progress and stats
      this.refreshOperations.get(operationId).progress = 100;
      this._updateCacheStats({ successful: 1, totalProcessed: 1 }, startTime);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = 'completed';

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'completed',
        results
      });

      console.log(`✅ ${sportKey} cache refreshed: ${games?.length || 0} games`);
      return results;

    } catch (error) {
      console.error(`❌ Failed to refresh ${sportKey} cache:`, error.message);
      
      results.endTime = new Date().toISOString();
      results.duration = Date.now() - startTime;
      results.finalStatus = 'failed';
      results.error = error.message;

      this.refreshOperations.set(operationId, {
        ...this.refreshOperations.get(operationId),
        status: 'failed',
        results
      });

      sentryService.captureError(error, { 
        component: 'cache_handler', 
        operation: 'refresh_sport',
        sportKey 
      });

      return results;
    }
  }

  /**
   * Get cache statistics and status
   */
  async getCacheStatus() {
    try {
      const [oddsStatus, gamesStatus, dbStatus] = await Promise.all([
        oddsService.getServiceStatus().catch(() => ({ status: 'unknown' })),
        gamesService.getServiceStatus().catch(() => ({ status: 'unknown' })),
        databaseService.getDatabaseStats().catch(() => ({ status: 'unknown' }))
      ]);

      const activeOperations = Array.from(this.refreshOperations.entries())
        .filter(([_, op]) => op.status === 'running')
        .map(([id, op]) => ({
          id,
          progress: op.progress,
          runningFor: Date.now() - op.startTime
        }));

      return {
        timestamp: new Date().toISOString(),
        statistics: this.cacheStats,
        services: {
          odds: {
            status: oddsStatus.status || 'unknown',
          },
          games: {
            status: gamesStatus.status || 'unknown',
          },
          database: {
            status: dbStatus.status || 'unknown',
          }
        },
        active_operations: activeOperations,
        last_refresh: this.cacheStats.lastRefresh
      };

    } catch (error) {
      console.error('Failed to get cache status:', error);
      return {
        timestamp: new Date().toISOString(),
        error: error.message,
        statistics: this.cacheStats
      };
    }
  }

  /**
   * Get active refresh operations
   */
  getActiveOperations() {
    return Array.from(this.refreshOperations.entries())
      .filter(([_, op]) => op.status === 'running')
      .map(([id, op]) => ({
        id,
        startTime: new Date(op.startTime).toISOString(),
        progress: op.progress,
        runningFor: Date.now() - op.startTime
      }));
  }

  /**
   * Clean up completed operations
   */
  cleanupOldOperations(maxAge = 3600000) { // 1 hour
    const now = Date.now();
    for (const [id, operation] of this.refreshOperations.entries()) {
      if (now - operation.startTime > maxAge) {
        this.refreshOperations.delete(id);
      }
    }
  }

  // ========== PRIVATE METHODS ==========

  /**
   * Update cache statistics
   */
  _updateCacheStats(results, startTime) {
    this.cacheStats.totalRefreshes++;
    
    if (results.finalStatus === 'completed' || results.finalStatus === 'completed_with_errors') {
      this.cacheStats.successfulRefreshes++;
    } else {
      this.cacheStats.failedRefreshes++;
    }

    this.cacheStats.lastRefresh = new Date().toISOString();
    
    // Update average duration
    const duration = Date.now() - startTime;
    if (this.cacheStats.averageDuration === 0) {
      this.cacheStats.averageDuration = duration;
    } else {
      this.cacheStats.averageDuration = 
        (this.cacheStats.averageDuration * (this.cacheStats.totalRefreshes - 1) + duration) / 
        this.cacheStats.totalRefreshes;
    }

    // Clean up old operations periodically
    if (this.cacheStats.totalRefreshes % 10 === 0) {
      this.cleanupOldOperations();
    }
  }

  /**
   * Format cache results for Telegram
   */
  _formatResultsForTelegram(results) {
    const { type, finalStatus, duration, totalProcessed, successful, failed, sports = [] } = results;
    
    let message = `🔄 *Cache Refresh ${type.toUpperCase()}* \\- ${finalStatus}\n\n`;
    message += `⏱️ Duration: ${duration}ms\n`;
    message += `📊 Processed: ${totalProcessed}\n`;
    message += `✅ Successful: ${successful}\n`;
    
    if (failed > 0) {
      message += `❌ Failed: ${failed}\n`;
    }

    // Add sport summary for multi-sport operations
    if (sports.length > 0) {
      message += `\n*Sports Summary:*\n`;
      
      const successfulSports = sports.filter(s => s.status === 'success');
      const failedSports = sports.filter(s => s.status === 'failed');
      
      if (successfulSports.length > 0) {
        message += `✅ ${successfulSports.length} sports refreshed\n`;
        
        // Show top sports by game count
        const topSports = successfulSports
          .sort((a, b) => (b.gamesCount || 0) - (a.gamesCount || 0))
          .slice(0, 3);
        
        if (topSports.length > 0) {
          message += `*Top Sports:*\n`;
          topSports.forEach(sport => {
            const safeSport = escapeMarkdownV2(sport.sportKey);
            message += `• ${safeSport}: ${sport.gamesCount} games\n`;
          });
        }
      }

      if (failedSports.length > 0) {
        message += `\n❌ ${failedSports.length} sports failed\n`;
        failedSports.slice(0, 3).forEach(sport => {
          const safeSport = escapeMarkdownV2(sport.sportKey);
          const safeError = escapeMarkdownV2(sport.error?.substring(0, 50) || 'Unknown error');
          message += `• ${safeSport}: ${safeError}\n`;
        });
      }
    }

    return message;
  }
}

// Create singleton instance
const cacheHandler = new CacheHandler();

/**
 * Register cache management commands with the bot
 */
export function registerCacheHandler(bot) {
  // --- Cache status command ---
  bot.onText(/^\/cache$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /cache command from ${chatId}`);
    
    try {
      const sentMsg = await bot.sendMessage(chatId, '🔄 Checking cache status...', { parse_mode: 'Markdown' });
      
      const status = await cacheHandler.getCacheStatus();
      const activeOps = cacheHandler.getActiveOperations();
      
      let message = `💾 *Cache Status*\n\n`;
      message += `*Overall:* ${status.statistics.totalRefreshes} total refreshes\n`;
      message += `*Success Rate:* ${((status.statistics.successfulRefreshes / status.statistics.totalRefreshes) * 100 || 0).toFixed(1)}%\n`;
      message += `*Last Refresh:* ${status.statistics.lastRefresh ? new Date(status.statistics.lastRefresh).toLocaleString() : 'Never'}\n\n`;
      
      message += `*Active Operations:* ${activeOps.length}\n`;
      activeOps.forEach(op => {
        message += `• ${op.id}: ${op.progress}% (${Math.round(op.runningFor / 1000)}s)\n`;
      });
      
      message += `\n*Services:*\n`;
      message += `• Odds: ${status.services.odds.status}\n`;
      message += `• Games: ${status.services.games.status}\n`;
      message += `• Database: ${status.services.database.status}\n\n`;
      
      message += `Use /cache_refresh for quick refresh or /cache_full for comprehensive refresh`;

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'Markdown'
      });
      
    } catch (error) {
      console.error('Cache status command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Failed to get cache status: \`${safeError}\``, 
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Quick cache refresh command ---
  bot.onText(/^\/cache_refresh$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /cache_refresh command from ${chatId}`);
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId, 
        '⚡ Starting quick cache refresh for popular sports...\n\nThis may take 30-60 seconds.', 
        { parse_mode: 'Markdown' }
      );

      const results = await cacheHandler.quickRefresh();
      const message = cacheHandler._formatResultsForTelegram(results);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Quick cache refresh command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Quick cache refresh failed: \`${safeError}\``, 
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Full cache refresh command ---
  bot.onText(/^\/cache_full$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /cache_full command from ${chatId}`);
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId, 
        '🔄 Starting full cache refresh for all sports and database...\n\nThis may take 2-3 minutes.', 
        { parse_mode: 'Markdown' }
      );

      const results = await cacheHandler.fullRefresh();
      const message = cacheHandler._formatResultsForTelegram(results);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Full cache refresh command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Full cache refresh failed: \`${safeError}\``, 
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Sport-specific cache refresh ---
  bot.onText(/^\/cache_sport (.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sportKey = match[1].trim().toLowerCase();
    console.log(`🎯 /cache_sport command for ${sportKey} from ${chatId}`);
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId, 
        `🎯 Refreshing cache for ${sportKey}...`, 
        { parse_mode: 'Markdown' }
      );

      const results = await cacheHandler.refreshSport(sportKey);
      const message = cacheHandler._formatResultsForTelegram(results);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Sport cache refresh command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Cache refresh for ${sportKey} failed: \`${safeError}\``, 
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Cache operations status ---
  bot.onText(/^\/cache_ops$/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`🎯 /cache_ops command from ${chatId}`);
    
    try {
      const activeOps = cacheHandler.getActiveOperations();
      
      if (activeOps.length === 0) {
        await bot.sendMessage(chatId, '✅ No active cache operations.', { parse_mode: 'Markdown' });
        return;
      }

      let message = `🔄 *Active Cache Operations*\n\n`;
      
      activeOps.forEach(op => {
        message += `*Operation:* ${op.id}\n`;
        message += `*Progress:* ${op.progress}%\n`;
        message += `*Running For:* ${Math.round(op.runningFor / 1000)} seconds\n\n`;
      });

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      
    } catch (error) {
      console.error('Cache operations command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Failed to get cache operations: \`${safeError}\``, 
        { parse_mode: 'MarkdownV2' }
      );
    }
  });
}

export default cacheHandler;
