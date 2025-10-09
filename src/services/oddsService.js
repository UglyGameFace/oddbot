// src/services/oddsService.js - ABSOLUTE FINAL FIXED VERSION
import env from '../config/env.js';
import redisService from './redisService.js'; // FIX: Import the service instance
import { sentryService } from './sentryService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js'; 
import makeCache from './cacheService.js';
import { TheOddsProvider } from './providers/theOddsProvider.js';

// Cache configuration
const CACHE_TTL = {
  ODDS: 60,
  PROPS: 120,
  SPORTS: 300,
};

// Helper classes
class GameEnhancementService {
  static enhanceGameData(games, sportKey, source) {
    if (!Array.isArray(games)) return [];

    return games.map((game) => ({
      ...game,
      enhanced: true,
      enhancement_source: source,
      last_enhanced: new Date().toISOString(),
      has_odds: !!(game.bookmakers && game.bookmakers.length > 0),
    }));
  }

  static filterGamesByTime(games, hoursAhead, includeLive = false) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    return games.filter((game) => {
      if (!game.commence_time) return false;

      const gameTime = new Date(game.commence_time);
      const isUpcoming = gameTime > now && gameTime <= cutoff;
      const isLive = includeLive && game.status === 'live';

      return isUpcoming || isLive;
    });
  }
}

class DataQualityService {
  static assessDataQuality(games) {
    if (!Array.isArray(games) || games.length === 0) {
      return { score: 0, rating: 'poor', issues: ['no_data'] };
    }

    const totalGames = games.length;
    const gamesWithOdds = games.filter(
      (g) => g.bookmakers && g.bookmakers.length > 0
    ).length;
    const oddsRatio = gamesWithOdds / totalGames;

    let score = Math.round(oddsRatio * 100);
    let rating = 'excellent';

    if (score < 20) rating = 'poor';
    else if (score < 50) rating = 'fair';
    else if (score < 80) rating = 'good';

    return {
      score,
      rating,
      games_with_odds: gamesWithOdds,
      total_games: totalGames,
      odds_coverage: oddsRatio,
    };
  }
}

// Main Odds Service Class
class OddsService {
  constructor() {
    this.providers = [
      new TheOddsProvider(env.THE_ODDS_API_KEY),
    ].filter((provider) => {
      const hasKey = provider.apiKey && provider.apiKey.length > 0;
      if (!hasKey) {
        console.warn(
          `⚠️ Excluding ${provider.name} provider - no API key configured`
        );
      }
      return hasKey;
    });

    this.providers.sort((a, b) => a.priority - b.priority);
    this.cache = null;
  }

  async _getCache() {
    if (!this.cache) {
      // FIX: Use the imported redisService instance to get the client
      const redisClient = await redisService.getClient();
      this.cache = makeCache(redisClient);
    }
    return this.cache;
  }

  async getAvailableSports() {
    const cacheKey = 'available_sports_odds';

    try {
      const cache = await this._getCache();

      return await cache.getOrSetJSON(cacheKey, CACHE_TTL.SPORTS, async () => {
        console.log('🔄 Fetching sports list from providers...');

        const theOddsProvider = this.providers.find((p) => p.name === 'theodds');
        if (theOddsProvider) {
          try {
            const sports = await withTimeout(theOddsProvider.fetchAvailableSports(), 6000, 'OddsAPISportsFetch');
            console.log(`✅ Found ${sports.length} sports from The Odds API`);
            return sports;
          } catch (error) {
             if (!(error instanceof TimeoutError)) {
                console.error('❌ The Odds API sports fetch CRITICAL error:', error.message);
                throw error;
             }
             console.warn('❌ The Odds API sports fetch TIMEOUT, falling back.');
          }
        }

        console.log('🔄 Using comprehensive sports list fallback');
        const { getAllSports } = await import('./sportsService.js');
        return getAllSports();
      });
    } catch (error) {
      console.error('❌ Sports list fetch failed:', error);
      sentryService.captureError(error, {
        component: 'odds_service',
        operation: 'getAvailableSports',
      });
      
      // FIX: Ensure fallback is still triggered on non-timeout critical errors
      console.log('🔄 Critical error, using comprehensive sports list fallback');
      const { getAllSports } = await import('./sportsService.js');
      return getAllSports();
    }
  }

  async getSportOdds(sportKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      includeLive = false,
      hoursAhead = 72,
      useCache = true,
    } = options;

    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}:${includeLive}:${hoursAhead}`;

    try {
      const cache = await this._getCache();

      if (!useCache) {
        console.log(`🔄 Bypassing cache for ${sportKey} odds...`);
        return await this._fetchSportOddsWithFallback(sportKey, options);
      }

      return await cache.getOrSetJSON(cacheKey, CACHE_TTL.ODDS, async () => {
        return await this._fetchSportOddsWithFallback(sportKey, options);
      });
    } catch (error) {
      console.error(`❌ Odds fetch failed for ${sportKey}:`, error.message);
      if (!(error instanceof TimeoutError)) {
          sentryService.captureError(error, {
            component: 'odds_service',
            operation: 'getSportOdds',
            sportKey,
            options,
          });
          throw error; // Re-throw critical errors
      }
      return []; // Return empty for timeouts
    }
  }

  async getPlayerPropsForGame(sportKey, gameId, options = {}) {
    console.log(`Player props not implemented for ${sportKey} game ${gameId}`);
    return [];
  }

  async getLiveGames(sportKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      hoursAhead = 24,
      maxGames = 50,
    } = options;

    try {
      const allGames = await this.getSportOdds(sportKey, {
        regions,
        markets,
        oddsFormat,
        includeLive: true,
        hoursAhead,
        useCache: false,
      });

      const liveGames = GameEnhancementService.filterGamesByTime(
        allGames,
        hoursAhead,
        true
      ).slice(0, maxGames);

      console.log(
        `🎯 Found ${liveGames.length} live/upcoming games for ${sportKey}`
      );
      return liveGames;
    } catch (error) {
      console.error(`❌ Live games fetch failed for ${sportKey}:`, error);
      throw error;
    }
  }

  async getDataFreshness(sportKey = null) {
    try {
      const now = new Date();
      let freshnessInfo = {
        overall: {
          last_checked: now.toISOString(),
          status: 'current',
        },
        providers: {},
      };

      for (const provider of this.providers) {
        try {
          const statusResult = await withTimeout(provider.getProviderStatus(), 3000, `ProviderStatus_${provider.name}`);
          freshnessInfo.providers[provider.name] = statusResult;
        } catch (error) {
          freshnessInfo.providers[provider.name] = {
            status: 'error',
            last_error: error.message,
          };
          freshnessInfo.overall.status = 'degraded';
        }
      }

      if (sportKey) {
        try {
          const testGames = await this.getSportOdds(sportKey, {
            useCache: false,
          });
          freshnessInfo.sport_specific = {
            sport_key: sportKey,
            games_available: testGames.length,
            data_quality: DataQualityService.assessDataQuality(testGames),
            last_successful_fetch: now.toISOString(),
          };
        } catch (error) {
          freshnessInfo.sport_specific = {
            sport_key: sportKey,
            error: error.message,
            last_attempt: now.toISOString(),
          };
          freshnessInfo.overall.status = 'degraded';
        }
      }

      return freshnessInfo;
    } catch (error) {
      console.error('❌ Data freshness check failed:', error);
      if (!(error instanceof TimeoutError)) {
          throw error;
      }
      return {
        overall: { status: 'unknown', last_checked: new Date().toISOString() },
        providers: {},
        error: error.message,
      };
    }
  }

  async _fetchSportOddsWithFallback(sportKey, options) {
    console.log(`🔄 Fetching odds for ${sportKey}...`);

    for (const provider of this.providers) {
      try {
        console.log(`🔧 Trying ${provider.name} for ${sportKey}...`);
        
        const games = await withTimeout(
            provider.fetchSportOdds(sportKey, options), 
            8000, 
            `FetchOdds_${provider.name}_${sportKey}`
        );

        if (games && games.length > 0) {
          console.log(
            `✅ ${provider.name} returned ${games.length} games for ${sportKey}`
          );
          return GameEnhancementService.enhanceGameData(
            games,
            sportKey,
            provider.name
          );
        }

        console.log(`⚠️ ${provider.name} returned no data for ${sportKey}`);
      } catch (error) {
        console.error(
          `❌ ${provider.name} failed for ${sportKey}:`,
          error.message
        );

        if (error?.response?.status === 429) {
          console.log(
            `🚫 ${provider.name} rate limited, stopping provider chain`
          );
          throw error;
        }
        
        if (!(error instanceof TimeoutError)) {
          sentryService.captureError(error, {
            component: 'odds_service_provider_failure',
            provider: provider.name,
            sportKey,
          });
        }
      }
    }

    console.log(`❌ All providers failed for ${sportKey}`);
    return [];
  }

  // FIX: Added getUsage method for health checks
  async getUsage() {
    const theOddsProvider = this.providers.find((p) => p.name === 'theodds');
    if (theOddsProvider && typeof theOddsProvider.fetchUsage === 'function') {
      try {
        return await withTimeout(theOddsProvider.fetchUsage(), 5000, 'TheOddsUsage');
      } catch (error) {
        console.error('❌ Failed to fetch usage stats from The Odds API:', error.message);
        return { error: error.message };
      }
    }
    console.warn('⚠️ No provider available to fetch usage stats.');
    return { requests_remaining: 'N/A' };
  }

  async getServiceStatus() {
    const status = {
      service: 'OddsService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: {
        enabled: true,
        ttls: CACHE_TTL,
      },
      providers: this.providers.map((p) => p.name),
      statistics: {},
    };

    try {
      const usage = await this.getUsage();
      status.statistics.usage = usage;
      
      const freshness = await this.getDataFreshness();
      status.freshness = freshness;

      const testGames = await this.getSportOdds('basketball_nba', {
        useCache: false,
      });
      status.statistics.test_games = testGames.length;
      status.statistics.data_quality =
        DataQualityService.assessDataQuality(testGames);
        
      if (usage.error || freshness.overall.status !== 'current' || testGames.length === 0) {
        status.status = 'degraded';
      }
      
    } catch (error) {
      status.status = 'degraded';
      status.error = error.message;
    }

    return status;
  }
}

export default new OddsService();
