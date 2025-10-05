// src/services/oddsService.js - COMPLETE FIXED VERSION
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import { rateLimitService } from './rateLimitService.js';
import { withTimeout, retryWithBackoff } from '../utils/asyncUtils.js';

// Cache configuration
const CACHE_TTL = {
  ODDS: 60,
  PROPS: 120,
  SPORTS: 300
};

const REQUEST_TIMEOUT = 10000;

// Simple cache implementation to avoid missing cacheService dependency
class SimpleCache {
  constructor(redis) {
    this.redis = redis;
  }

  async getOrSetJSON(key, ttl, fetchFn, options = {}) {
    try {
      // Try to get from cache first
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }

      // Fetch fresh data
      const data = await fetchFn();
      
      // Cache the result
      if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
        await this.redis.setex(key, ttl, JSON.stringify(data));
      }
      
      return data;
    } catch (error) {
      console.error(`Cache operation failed for ${key}:`, error.message);
      // Fallback to direct fetch
      return await fetchFn();
    }
  }
}

// Base provider class to handle common functionality
class BaseOddsProvider {
  constructor(name, apiKey, priority = 100) {
    this.name = name;
    this.apiKey = apiKey;
    this.priority = priority;
  }

  async fetchAvailableSports() {
    // Default implementation - should be overridden by specific providers
    return [];
  }

  async fetchSportOdds(sportKey, options = {}) {
    // Default implementation - should be overridden by specific providers
    return [];
  }

  async getProviderStatus() {
    return {
      status: 'unknown',
      name: this.name,
      has_api_key: !!this.apiKey
    };
  }
}

// The Odds API Provider
class TheOddsProvider extends BaseOddsProvider {
  constructor(apiKey) {
    super('theodds', apiKey, 10);
    this.baseUrl = 'https://api.the-odds-api.com/v4';
  }

  async fetchAvailableSports() {
    if (!this.apiKey) return [];
    
    try {
      const response = await withTimeout(
        fetch(`${this.baseUrl}/sports?apiKey=${this.apiKey}`),
        REQUEST_TIMEOUT,
        'TheOddsAPI-sports'
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const sports = await response.json();
      return sports.map(sport => ({
        sport_key: sport.key,
        sport_title: sport.title,
        active: sport.active,
        has_outrights: sport.has_outrights,
        source: 'theodds'
      }));
    } catch (error) {
      console.error('TheOddsAPI sports fetch failed:', error.message);
      return [];
    }
  }

  async fetchSportOdds(sportKey, options = {}) {
    if (!this.apiKey) return [];
    
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      includeLive = false
    } = options;

    try {
      const url = `${this.baseUrl}/sports/${sportKey}/odds?apiKey=${this.apiKey}&regions=${regions}&markets=${markets}&oddsFormat=${oddsFormat}`;
      
      const response = await withTimeout(
        fetch(url),
        REQUEST_TIMEOUT,
        `TheOddsAPI-odds-${sportKey}`
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const oddsData = await response.json();
      return this.normalizeOddsData(oddsData);
    } catch (error) {
      console.error(`TheOddsAPI odds fetch failed for ${sportKey}:`, error.message);
      throw error;
    }
  }

  normalizeOddsData(oddsData) {
    return oddsData.map(event => ({
      event_id: event.id,
      sport_key: event.sport_key,
      sport_title: event.sport_title,
      commence_time: event.commence_time,
      home_team: event.home_team,
      away_team: event.away_team,
      bookmakers: event.bookmakers || [],
      last_updated: new Date().toISOString(),
      source: 'theodds'
    }));
  }

  async getProviderStatus() {
    try {
      // Test with a simple sports request
      const sports = await this.fetchAvailableSports();
      return {
        status: 'active',
        name: this.name,
        sports_available: sports.length,
        last_success: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'inactive',
        name: this.name,
        last_error: error.message,
        last_attempt: new Date().toISOString()
      };
    }
  }
}

// SportRadar Provider
class SportRadarProvider extends BaseOddsProvider {
  constructor(apiKey) {
    super('sportradar', apiKey, 20);
    this.baseUrl = 'https://api.sportradar.com';
  }

  async fetchAvailableSports() {
    // SportRadar typically requires different endpoints for different sports
    // Return a subset of major sports for now
    const majorSports = [
      { key: 'americanfootball_nfl', title: 'NFL' },
      { key: 'basketball_nba', title: 'NBA' },
      { key: 'baseball_mlb', title: 'MLB' },
      { key: 'icehockey_nhl', title: 'NHL' }
    ];
    
    return majorSports.map(sport => ({
      sport_key: sport.key,
      sport_title: sport.title,
      active: true,
      has_outrights: false,
      source: 'sportradar'
    }));
  }

  async fetchSportOdds(sportKey, options = {}) {
    // SportRadar implementation would go here
    // For now, return empty array as fallback provider
    console.log(`SportRadar not implemented for ${sportKey}, serving as fallback`);
    return [];
  }

  async getProviderStatus() {
    return {
      status: 'limited',
      name: this.name,
      note: 'SportRadar implementation pending',
      has_api_key: !!this.apiKey
    };
  }
}

// Game enhancement service (simplified to avoid dependency)
class GameEnhancementService {
  static enhanceGameData(games, sportKey, source) {
    if (!Array.isArray(games)) return [];
    
    return games.map(game => ({
      ...game,
      enhanced: true,
      enhancement_source: source,
      last_enhanced: new Date().toISOString(),
      has_odds: !!(game.bookmakers && game.bookmakers.length > 0)
    }));
  }

  static filterGamesByTime(games, hoursAhead, includeLive = false) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    
    return games.filter(game => {
      if (!game.commence_time) return false;
      
      const gameTime = new Date(game.commence_time);
      const isUpcoming = gameTime > now && gameTime <= cutoff;
      const isLive = includeLive && game.status === 'live';
      
      return isUpcoming || isLive;
    });
  }
}

// Data quality service (simplified)
class DataQualityService {
  static assessDataQuality(games) {
    if (!Array.isArray(games) || games.length === 0) {
      return { score: 0, rating: 'poor', issues: ['no_data'] };
    }

    const totalGames = games.length;
    const gamesWithOdds = games.filter(g => g.bookmakers && g.bookmakers.length > 0).length;
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
      odds_coverage: oddsRatio
    };
  }
}

// Main Odds Service Class
class OddsService {
  constructor() {
    this.providers = [
      new TheOddsProvider(env.THE_ODDS_API_KEY),
      new SportRadarProvider(env.SPORTRADAR_API_KEY)
    ].filter(provider => {
      const hasKey = provider.apiKey && provider.apiKey !== 'undefined';
      if (!hasKey) {
        console.warn(`⚠️ Excluding ${provider.name} provider - no API key configured`);
      }
      return hasKey;
    });
    
    // Sort providers by priority
    this.providers.sort((a, b) => a.priority - b.priority);
    this.cache = null;
  }

  async _getCache() {
    if (!this.cache) {
      const redis = await redisClient;
      this.cache = new SimpleCache(redis);
    }
    return this.cache;
  }

  async getAvailableSports() {
    const cacheKey = 'available_sports_odds';
    
    try {
      const cache = await this._getCache();
      
      return await cache.getOrSetJSON(cacheKey, CACHE_TTL.SPORTS, async () => {
        console.log('🔄 Fetching sports list from providers...');
        
        // Try The Odds API first (most reliable for sports list)
        const theOddsProvider = this.providers.find(p => p.name === 'theodds');
        if (theOddsProvider) {
          try {
            const sports = await theOddsProvider.fetchAvailableSports();
            console.log(`✅ Found ${sports.length} sports from The Odds API`);
            return sports;
          } catch (error) {
            console.warn('❌ The Odds API sports fetch failed:', error.message);
          }
        }
        
        // Fallback to comprehensive list
        console.log('🔄 Using comprehensive sports list fallback');
        const { getAllSports } = await import('./sportsService.js');
        return getAllSports();
      });

    } catch (error) {
      console.error('❌ Sports list fetch failed:', error);
      sentryService.captureError(error, { component: 'odds_service', operation: 'getAvailableSports' });
      
      // Final fallback
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
      useCache = true
    } = options;

    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}:${includeLive}:${hoursAhead}`;
    
    try {
      const cache = await this._getCache();
      
      if (!useCache) {
        console.log(`🔄 Bypassing cache for ${sportKey} odds...`);
        return await this._fetchSportOddsWithFallback(sportKey, options);
      }

      return await cache.getOrSetJSON(
        cacheKey, 
        CACHE_TTL.ODDS,
        async () => {
          return await this._fetchSportOddsWithFallback(sportKey, options);
        }
      );

    } catch (error) {
      console.error(`❌ Odds fetch failed for ${sportKey}:`, error.message);
      sentryService.captureError(error, { 
        component: 'odds_service', 
        operation: 'getSportOdds',
        sportKey,
        options
      });
      return [];
    }
  }

  async getPlayerPropsForGame(sportKey, gameId, options = {}) {
    // Player props not implemented in base version
    console.log(`Player props not implemented for ${sportKey} game ${gameId}`);
    return [];
  }

  async getLiveGames(sportKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      hoursAhead = 24,
      maxGames = 50
    } = options;

    try {
      const allGames = await this.getSportOdds(sportKey, {
        regions,
        markets,
        oddsFormat,
        includeLive: true,
        hoursAhead,
        useCache: false
      });

      const liveGames = GameEnhancementService.filterGamesByTime(allGames, hoursAhead, true)
        .slice(0, maxGames);

      console.log(`🎯 Found ${liveGames.length} live/upcoming games for ${sportKey}`);
      return liveGames;

    } catch (error) {
      console.error(`❌ Live games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  async getDataFreshness(sportKey = null) {
    try {
      const now = new Date();
      let freshnessInfo = {
        overall: {
          last_checked: now.toISOString(),
          status: 'current'
        },
        providers: {}
      };

      // Get status from each provider
      for (const provider of this.providers) {
        try {
          freshnessInfo.providers[provider.name] = await provider.getProviderStatus();
        } catch (error) {
          freshnessInfo.providers[provider.name] = {
            status: 'error',
            last_error: error.message
          };
          freshnessInfo.overall.status = 'degraded';
        }
      }

      // Sport-specific info
      if (sportKey) {
        try {
          const testGames = await this.getSportOdds(sportKey, { useCache: false });
          freshnessInfo.sport_specific = {
            sport_key: sportKey,
            games_available: testGames.length,
            data_quality: DataQualityService.assessDataQuality(testGames),
            last_successful_fetch: now.toISOString()
          };
        } catch (error) {
          freshnessInfo.sport_specific = {
            sport_key: sportKey,
            error: error.message,
            last_attempt: now.toISOString()
          };
          freshnessInfo.overall.status = 'degraded';
        }
      }

      return freshnessInfo;

    } catch (error) {
      console.error('❌ Data freshness check failed:', error);
      return {
        overall: { status: 'unknown', last_checked: new Date().toISOString() },
        providers: {},
        error: error.message
      };
    }
  }

  // ========== PRIVATE METHODS ==========

  async _fetchSportOddsWithFallback(sportKey, options) {
    console.log(`🔄 Fetching odds for ${sportKey}...`);
    
    for (const provider of this.providers) {
      try {
        console.log(`🔧 Trying ${provider.name} for ${sportKey}...`);
        const games = await provider.fetchSportOdds(sportKey, options);
        
        if (games && games.length > 0) {
          console.log(`✅ ${provider.name} returned ${games.length} games for ${sportKey}`);
          return GameEnhancementService.enhanceGameData(games, sportKey, provider.name);
        }
        
        console.log(`⚠️ ${provider.name} returned no data for ${sportKey}`);

      } catch (error) {
        console.error(`❌ ${provider.name} failed for ${sportKey}:`, error.message);
        
        // Don't try other providers on 429
        if (error?.response?.status === 429) {
          console.log(`🚫 ${provider.name} rate limited, stopping provider chain`);
          break;
        }

        // Log non-rate-limit errors
        if (error?.response?.status !== 429) {
          sentryService.captureError(error, { 
            component: 'odds_service_provider_failure', 
            provider: provider.name, 
            sportKey 
          });
        }
      }
    }

    console.log(`❌ All providers failed for ${sportKey}`);
    return [];
  }

  async getServiceStatus() {
    const status = {
      service: 'OddsService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: {
        enabled: true,
        ttls: CACHE_TTL
      },
      providers: this.providers.map(p => p.name),
      statistics: {}
    };

    try {
      const freshness = await this.getDataFreshness();
      status.freshness = freshness;
      
      // Test a popular sport
      const testGames = await this.getSportOdds('basketball_nba', { useCache: false });
      status.statistics.test_games = testGames.length;
      status.statistics.data_quality = DataQualityService.assessDataQuality(testGames);

    } catch (error) {
      status.status = 'degraded';
      status.error = error.message;
    }

    return status;
  }
}

export default new OddsService();
