// src/services/oddsService.js - COMPLETE FIXED VERSION
import env from '../config/env.js';
import cacheService from './cacheService.js';
import { sentryService } from './sentryService.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';
import { TheOddsProvider } from './providers/theOddsProvider.js';
import { SportRadarProvider } from './providers/sportRadarProvider.js';
import { ApiSportsProvider } from './providers/apiSportsProvider.js';
import { ApiNinjaProvider } from './providers/apiNinjaProvider.js';

// Cache configuration
const CACHE_TTL = {
  ODDS: 60,        // 1 minute for live odds
  PROPS: 120,      // 2 minutes for player props
  SPORTS: 300,     // 5 minutes for sports lists
  LIVE_GAMES: 30,  // 30 seconds for live games
  USAGE: 180       // 3 minutes for usage stats
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
      odds_provider: source,
      cache_timestamp: new Date().toISOString()
    }));
  }

  static filterGamesByTime(games, hoursAhead, includeLive = false) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    return games.filter((game) => {
      if (!game.commence_time) return false;

      const gameTime = new Date(game.commence_time);
      const isUpcoming = gameTime > now && gameTime <= cutoff;
      const isLive = includeLive && (game.status === 'live' || game.live === true);

      return isUpcoming || isLive;
    });
  }

// IN THE GameEnhancementService class - UPDATE THE VALIDATION METHOD:
static validateGameData(game) {
  if (!game) return false;
  
  // More flexible required fields - different providers use different field names
  const hasBasicInfo = (
    (game.id || game.event_id || game.game_id) && 
    game.sport_key &&
    game.commence_time && 
    (game.home_team || game.homeTeam) &&
    (game.away_team || game.awayTeam)
  );

  if (!hasBasicInfo) {
    console.warn(`⚠️ Game validation failed - missing basic info:`, game.id || game.event_id);
    return false;
  }

  // Validate commence_time format and reasonable date - MUCH MORE PERMISSIVE
  try {
    const gameTime = new Date(game.commence_time);
    const now = new Date();
    const maxPastHours = 24; // Allow games up to 24 hours in past (for live games)
    const maxFutureDays = 365; // Allow games up to 1 year in future
    
    const isReasonableTime = gameTime > new Date(now.getTime() - maxPastHours * 60 * 60 * 1000) &&
                            gameTime < new Date(now.getTime() + maxFutureDays * 24 * 60 * 60 * 1000);
    
    if (!isReasonableTime) {
      console.warn(`⚠️ Game validation failed - unreasonable commence_time:`, game.commence_time);
      return false;
    }
  } catch (dateError) {
    console.warn(`⚠️ Game validation failed - invalid commence_time:`, game.commence_time);
    return false;
  }

  return true;
}

  static normalizeGameData(game, provider) {
    if (!game) return null;
    
    const normalized = {
      // Standardize ID field
      id: game.id || game.event_id || game.game_id,
      event_id: game.id || game.event_id || game.game_id,
      
      // Standardize sport fields
      sport_key: game.sport_key || game.sport,
      sport_title: game.sport_title || game.sport_name,
      
      // Standardize team fields
      home_team: game.home_team || game.homeTeam || 'Unknown Home',
      away_team: game.away_team || game.awayTeam || 'Unknown Away',
      
      // Standardize time field
      commence_time: game.commence_time || game.start_time || game.time,
      
      // Preserve original data
      bookmakers: game.bookmakers || game.odds || [],
      raw_data: game,
      provider: provider,
      
      // Metadata
      last_updated: new Date().toISOString(),
      normalized: true
    };

    // Clean up undefined fields
    Object.keys(normalized).forEach(key => {
      if (normalized[key] === undefined) {
        delete normalized[key];
      }
    });

    return normalized;
  }
}

class DataQualityService {
  static assessDataQuality(games) {
    if (!Array.isArray(games) || games.length === 0) {
      return { score: 0, rating: 'poor', issues: ['no_data'] };
    }

    const totalGames = games.length;
    const validGames = games.filter(GameEnhancementService.validateGameData).length;
    const gamesWithOdds = games.filter(
      (g) => g.bookmakers && g.bookmakers.length > 0
    ).length;
    
    const validityRatio = validGames / totalGames;
    const oddsRatio = gamesWithOdds / totalGames;

    let score = Math.round((validityRatio * 0.7 + oddsRatio * 0.3) * 100);
    let rating = 'excellent';

    if (score < 50) rating = 'poor';
    else if (score < 70) rating = 'fair';
    else if (score < 85) rating = 'good';

    return {
      score,
      rating,
      valid_games: validGames,
      games_with_odds: gamesWithOdds,
      total_games: totalGames,
      validity_ratio: validityRatio,
      odds_coverage: oddsRatio,
      timestamp: new Date().toISOString()
    };
  }
}

class FallbackProvider {
  constructor() {
    this.name = 'fallback';
    this.priority = 100;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    console.log('🔄 FallbackProvider: Initializing...');
    this.initialized = true;
  }

  async fetchSportOdds(sportKey, options = {}) {
    await this.initialize();
    console.log(`🔄 FallbackProvider: Using fallback for ${sportKey} (no real odds)`);
    
    // Return minimal mock data structure
    return [{
      id: `fallback_${sportKey}_${Date.now()}`,
      sport_key: sportKey,
      sport_title: this._formatSportKey(sportKey),
      commence_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
      home_team: 'Home Team',
      away_team: 'Away Team',
      bookmakers: []
    }];
  }

  async fetchAvailableSports() {
    await this.initialize();
    console.log('🔄 FallbackProvider: Using comprehensive sports list');
    
    try {
      const { COMPREHENSIVE_SPORTS } = await import('../config/sportDefinitions.js');
      return Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
        sport_key,
        sport_title: data.title,
        key: sport_key,
        active: true,
        has_outrights: false,
        source: 'fallback'
      }));
    } catch (error) {
      console.error('❌ FallbackProvider: Failed to load sports definitions:', error);
      return [];
    }
  }

  async getProviderStatus() {
    return {
      name: this.name,
      status: 'fallback',
      priority: this.priority,
      initialized: this.initialized,
      message: 'Using fallback mode - no real odds data',
      timestamp: new Date().toISOString()
    };
  }

  _formatSportKey(sportKey) {
    return sportKey
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}

class OddsService {
  constructor() {
    this.providers = [];
    this.initialized = false;
    this.providerStatus = new Map();
    
    console.log('🎯 OddsService: Initializing providers...');
    this._initializeProviders();
  }

  async _ensureInitialized() {
    if (this.initialized) return;
    
    console.log('🔄 OddsService: Performing first-time initialization...');
    
    // Initialize all providers
    for (const provider of this.providers) {
      if (provider.initialize) {
        try {
          await provider.initialize();
          this.providerStatus.set(provider.name, 'initialized');
        } catch (error) {
          console.error(`❌ OddsService: Failed to initialize ${provider.name}:`, error.message);
          this.providerStatus.set(provider.name, 'initialization_failed');
        }
      }
    }
    
    // Warm up cache service
    try {
      await cacheService.healthCheck();
      console.log('✅ OddsService: Cache service ready');
    } catch (error) {
      console.warn('⚠️ OddsService: Cache service not available, continuing without cache');
    }
    
    this.initialized = true;
    console.log(`✅ OddsService: Initialized with ${this.providers.length} providers`);
  }

  _initializeProviders() {
    // The Odds API Provider
    if (env.THE_ODDS_API_KEY && !env.THE_ODDS_API_KEY.includes('expired') && env.THE_ODDS_API_KEY.length >= 20) {
      this.providers.push(new TheOddsProvider(env.THE_ODDS_API_KEY));
      console.log('✅ The Odds API provider registered');
    } else {
      console.warn('❌ The Odds API provider SKIPPED - invalid or missing key');
    }
    
    // API-Ninja Provider
    if (env.ODDS_API_NINJA_KEY && !env.ODDS_API_NINJA_KEY.includes('expired') && env.ODDS_API_NINJA_KEY.length >= 10) {
      this.providers.push(new ApiNinjaProvider(env.ODDS_API_NINJA_KEY));
      console.log('✅ API-Ninja provider registered');
    } else {
      console.warn('❌ API-Ninja provider SKIPPED - invalid or missing key');
    }

    // SportRadar API Provider
    if (env.SPORTRADAR_API_KEY && !env.SPORTRADAR_API_KEY.includes('expired') && env.SPORTRADAR_API_KEY.length >= 10) {
      this.providers.push(new SportRadarProvider(env.SPORTRADAR_API_KEY));
      console.log('✅ SportRadar API provider registered');
    } else {
      console.warn('❌ SportRadar API provider SKIPPED - invalid or missing key');
    }

    // API-Sports Provider
    if (env.APISPORTS_API_KEY && !env.APISPORTS_API_KEY.includes('expired') && env.APISPORTS_API_KEY.length >= 10) {
      this.providers.push(new ApiSportsProvider(env.APISPORTS_API_KEY));
      console.log('✅ API-Sports provider registered');
    } else {
      console.warn('❌ API-Sports provider SKIPPED - invalid or missing key');
    }

    // Always include fallback provider
    this.providers.push(new FallbackProvider());
    console.log('✅ Fallback provider registered');

    // Sort by priority (lower number = higher priority)
    this.providers.sort((a, b) => (a.priority || 100) - (b.priority || 100));
    
    console.log(`🎯 OddsService: ${this.providers.length} providers ready:`, this.providers.map(p => p.name).join(', '));
  }

  _validateSportKey(sportKey) {
    if (!sportKey || sportKey === 'undefined' || sportKey === 'null') {
      console.warn('⚠️ OddsService: sportKey is undefined or invalid');
      return false;
    }
    
    if (typeof sportKey !== 'string') {
      console.warn('⚠️ OddsService: sportKey is not a string:', typeof sportKey);
      return false;
    }
    
    const validSportPattern = /^[a-z0-9_]+$/;
    if (!validSportPattern.test(sportKey)) {
      console.warn(`⚠️ OddsService: Suspicious sport key format: ${sportKey}`);
      return false;
    }
    
    if (sportKey.length > 50) {
      console.warn(`⚠️ OddsService: Sport key too long: ${sportKey}`);
      return false;
    }
    
    return true;
  }

  async getAvailableSports() {
    await this._ensureInitialized();
    
    const cacheKey = 'available_sports_odds_v2';

    try {
      console.log('🔄 OddsService: Fetching available sports...');
      
      return await cacheService.getOrSetJSON(
        cacheKey, 
        CACHE_TTL.SPORTS, 
        async () => {
          console.log('🔄 OddsService: Building sports list from providers...');

          for (const provider of this.providers) {
            if (provider.name === 'fallback') continue;
            
            try {
              const sports = await withTimeout(
                provider.fetchAvailableSports(), 
                8000, 
                `SportsFetch_${provider.name}`
              );
              
              if (sports && sports.length > 0) {
                console.log(`✅ OddsService: Found ${sports.length} sports from ${provider.name}`);
                
                const enhancedSports = sports.map(sport => ({
                  ...sport,
                  source: provider.name,
                  last_updated: new Date().toISOString(),
                  provider: provider.name
                }));
                
                return enhancedSports;
              }
            } catch (error) {
              if (!(error instanceof TimeoutError)) {
                console.error(`❌ OddsService: ${provider.name} sports fetch failed:`, error.message);
              } else {
                console.warn(`⏰ OddsService: ${provider.name} sports fetch timeout`);
              }
            }
          }

          console.log('🔄 OddsService: All primary providers failed, using fallback sports list');
          const fallbackProvider = this.providers.find(p => p.name === 'fallback');
          return await fallbackProvider.fetchAvailableSports();
        },
        {
          context: { operation: 'getAvailableSports' },
          fallbackOnError: true,
          lockMs: 15000
        }
      );

    } catch (error) {
      console.error('❌ OddsService: Sports list fetch failed:', error.message);
      sentryService.captureError(error, {
        component: 'odds_service',
        operation: 'getAvailableSports',
      });
      
      console.log('🔄 OddsService: Using emergency fallback sports');
      const fallbackProvider = this.providers.find(p => p.name === 'fallback');
      return await fallbackProvider.fetchAvailableSports();
    }
  }

  async getSportOdds(sportKey, options = {}) {
    await this._ensureInitialized();
    
    if (!this._validateSportKey(sportKey)) {
      console.warn(`⚠️ OddsService: Invalid sport key "${sportKey}", returning empty array`);
      return [];
    }
    
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      includeLive = false,
      hoursAhead = 72,
      useCache = true,
      forceRefresh = false
    } = options;

    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}:${includeLive}:${hoursAhead}:v2`;

    if (forceRefresh) {
      try {
        await cacheService.deleteKey(cacheKey);
        console.log(`🗑️ OddsService: Force refresh - cleared cache for ${sportKey}`);
      } catch (error) {
        console.warn(`⚠️ OddsService: Failed to clear cache for force refresh:`, error.message);
      }
    }

    try {
      const fetchOdds = async () => {
        return await this._fetchSportOddsWithFallback(sportKey, options);
      };

      if (useCache && cacheService.isAvailable()) {
        return await cacheService.getOrSetJSON(
          cacheKey, 
          CACHE_TTL.ODDS, 
          fetchOdds,
          {
            context: { 
              sport: sportKey, 
              operation: 'getSportOdds',
              regions,
              markets,
              includeLive
            },
            fallbackOnError: true,
            lockMs: 20000
          }
        );
      } else {
        console.log(`🔄 OddsService: Bypassing cache for ${sportKey} odds...`);
        return await fetchOdds();
      }

    } catch (error) {
      console.error(`❌ OddsService: Odds fetch failed for ${sportKey}:`, error.message);
      
      if (!(error instanceof TimeoutError)) {
        sentryService.captureError(error, {
          component: 'odds_service',
          operation: 'getSportOdds',
          sportKey,
          options,
        });
      }
      
      return [];
    }
  }

  async getPlayerPropsForGame(sportKey, gameId, options = {}) {
    await this._ensureInitialized();
    
    if (!this._validateSportKey(sportKey)) {
      console.warn(`⚠️ OddsService: Invalid sport key for player props: ${sportKey}`);
      return [];
    }

    const cacheKey = `player_props:${sportKey}:${gameId}:v2`;

    try {
      console.log(`🎯 OddsService: Fetching player props for ${sportKey} game ${gameId}`);

      for (const provider of this.providers) {
        if (provider.name === 'fallback') continue;
        
        if (typeof provider.fetchPlayerProps === 'function') {
          try {
            const props = await withTimeout(
              provider.fetchPlayerProps(sportKey, gameId, options),
              10000,
              `PlayerProps_${provider.name}`
            );
            
            if (props && props.length > 0) {
              console.log(`✅ OddsService: Found ${props.length} player props from ${provider.name}`);
              
              if (cacheService.isAvailable()) {
                await cacheService.setJSON(cacheKey, props, CACHE_TTL.PROPS);
              }
              
              return props;
            }
          } catch (error) {
            console.warn(`❌ OddsService: ${provider.name} player props failed:`, error.message);
          }
        }
      }

      console.log(`⚠️ OddsService: No player props available for ${sportKey} game ${gameId}`);
      return [];

    } catch (error) {
      console.error(`❌ OddsService: Player props fetch failed for ${sportKey}:`, error.message);
      return [];
    }
  }

  async getLiveGames(sportKey, options = {}) {
    await this._ensureInitialized();
    
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      hoursAhead = 24,
      maxGames = 50,
    } = options;

    const cacheKey = `live_games:${sportKey}:${regions}:${markets}:v2`;

    try {
      return await cacheService.getOrSetJSON(
        cacheKey,
        CACHE_TTL.LIVE_GAMES,
        async () => {
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
          )
          .filter(GameEnhancementService.validateGameData)
          .slice(0, maxGames);

          console.log(`🎯 OddsService: Found ${liveGames.length} live/upcoming games for ${sportKey}`);
          return liveGames;
        },
        {
          context: { operation: 'getLiveGames', sport: sportKey },
          fallbackOnError: true
        }
      );

    } catch (error) {
      console.error(`❌ OddsService: Live games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  async getDataFreshness(sportKey = null) {
    await this._ensureInitialized();
    
    try {
      const now = new Date();
      let freshnessInfo = {
        overall: {
          last_checked: now.toISOString(),
          status: 'current',
          service: 'OddsService'
        },
        providers: {},
        cache: {
          enabled: cacheService.isAvailable(),
          status: cacheService.isAvailable() ? 'active' : 'inactive'
        }
      };

      for (const provider of this.providers) {
        try {
          const statusResult = await withTimeout(
            provider.getProviderStatus(), 
            5000, 
            `ProviderStatus_${provider.name}`
          );
          freshnessInfo.providers[provider.name] = {
            ...statusResult,
            response_time: 'ok'
          };
        } catch (error) {
          freshnessInfo.providers[provider.name] = {
            name: provider.name,
            status: 'error',
            last_error: error.message,
            response_time: 'timeout',
            timestamp: now.toISOString()
          };
          freshnessInfo.overall.status = 'degraded';
        }
      }

      if (sportKey && this._validateSportKey(sportKey)) {
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

      if (cacheService.isAvailable()) {
        try {
          const cacheHealth = await cacheService.healthCheck();
          freshnessInfo.cache.health = cacheHealth.healthy ? 'healthy' : 'unhealthy';
          freshnessInfo.cache.response_time = cacheHealth.response_time;
        } catch (error) {
          freshnessInfo.cache.health = 'error';
          freshnessInfo.cache.error = error.message;
        }
      }

      return freshnessInfo;

    } catch (error) {
      console.error('❌ OddsService: Data freshness check failed:', error);
      return {
        overall: { 
          status: 'error', 
          error: error.message, 
          last_checked: new Date().toISOString() 
        },
        providers: {},
        cache: { enabled: false, status: 'unknown' }
      };
    }
  }

  async _fetchSportOddsWithFallback(sportKey, options) {
    console.log(`🔄 OddsService: Fetching odds for ${sportKey}...`);
    
    if (!this._validateSportKey(sportKey)) {
      return [];
    }

    let lastError = null;
    let successfulProvider = null;
    
    for (const provider of this.providers) {
      try {
        console.log(`🔧 OddsService: Trying ${provider.name} for ${sportKey}...`);

        const games = await withTimeout(
          provider.fetchSportOdds(sportKey, options), 
          12000,
          `FetchOdds_${provider.name}_${sportKey}`
        );

        if (games && games.length > 0) {
          const normalizedGames = games
            .map(game => GameEnhancementService.normalizeGameData(game, provider.name))
            .filter(game => game !== null && GameEnhancementService.validateGameData(game));
          
          console.log(`✅ OddsService: ${provider.name} returned ${normalizedGames.length} valid games for ${sportKey} (from ${games.length} raw)`);
          
          successfulProvider = provider.name;
          return GameEnhancementService.enhanceGameData(normalizedGames, sportKey, provider.name);
        }

        console.log(`⚠️ OddsService: ${provider.name} returned no valid data for ${sportKey}`);

      } catch (error) {
        lastError = error;
        console.error(`❌ OddsService: ${provider.name} failed for ${sportKey}:`, error.message);

        if (error?.response?.status === 401 || error?.response?.status === 403) {
          console.error(`🔐 OddsService: ${provider.name} authentication failed - check API key`);
          continue;
        }
        
        if (error?.response?.status === 429) {
          console.log(`🚫 OddsService: ${provider.name} rate limited, trying next provider...`);
          continue;
        }
        
        if (error.code === 'ENOTFOUND') {
          console.error(`🌐 OddsService: Network error for ${provider.name} - check DNS/network`);
          continue;
        }
        
        if (!(error instanceof TimeoutError)) {
          sentryService.captureError(error, {
            component: 'odds_service_provider_failure',
            provider: provider.name,
            sportKey,
            options
          });
        }
      }
    }

    console.log(`❌ OddsService: All providers failed for ${sportKey}`);
    if (lastError) {
      console.error(`📋 OddsService: Last error details:`, lastError.message);
    }
    
    const fallbackProvider = this.providers.find(p => p.name === 'fallback');
    const fallbackGames = await fallbackProvider.fetchSportOdds(sportKey, options);
    const normalizedFallback = fallbackGames
      .map(game => GameEnhancementService.normalizeGameData(game, 'fallback'))
      .filter(game => game !== null);
    
    return GameEnhancementService.enhanceGameData(normalizedFallback, sportKey, 'fallback');
  }

  async getUsage() {
    await this._ensureInitialized();
    
    const cacheKey = 'odds_api_usage_v2';

    try {
      return await cacheService.getOrSetJSON(
        cacheKey,
        CACHE_TTL.USAGE,
        async () => {
          const theOddsProvider = this.providers.find((p) => p.name === 'theodds');
          if (theOddsProvider && typeof theOddsProvider.fetchUsage === 'function') {
            try {
              const usage = await withTimeout(theOddsProvider.fetchUsage(), 5000, 'TheOddsUsage');
              console.log('✅ OddsService: Fetched usage stats from The Odds API');
              return usage;
            } catch (error) {
              console.error('❌ OddsService: Failed to fetch usage stats from The Odds API:', error.message);
              return { error: error.message, provider: 'theodds' };
            }
          }
          
          console.warn('⚠️ OddsService: No provider available to fetch usage stats.');
          return { 
            requests_remaining: 'N/A',
            message: 'No usage provider available',
            timestamp: new Date().toISOString()
          };
        },
        {
          context: { operation: 'getUsage' },
          fallbackOnError: true
        }
      );
    } catch (error) {
      console.error('❌ OddsService: Usage stats fetch failed:', error.message);
      return { 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async getServiceStatus() {
    await this._ensureInitialized();
    
    const status = {
      service: 'OddsService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: {
        enabled: cacheService.isAvailable(),
        status: cacheService.isAvailable() ? 'active' : 'inactive',
        ttls: CACHE_TTL,
      },
      providers: this.providers.map((p) => p.name),
      statistics: {},
      initialization: {
        initialized: this.initialized,
        provider_status: Object.fromEntries(this.providerStatus)
      }
    };

    try {
      const usage = await this.getUsage();
      status.statistics.usage = usage;
      
      const freshness = await this.getDataFreshness();
      status.freshness = freshness;

      try {
        const availableSports = await this.getAvailableSports();
        if (availableSports && availableSports.length > 0) {
          const testSport = availableSports[0]?.sport_key;
          if (testSport && this._validateSportKey(testSport)) {
            const testGames = await this.getSportOdds(testSport, { useCache: false });
            status.statistics.test_games = testGames.length;
            status.statistics.data_quality = DataQualityService.assessDataQuality(testGames);
            status.statistics.test_sport = testSport;
          } else {
            status.statistics.test_games = 0;
            status.statistics.data_quality = { score: 0, rating: 'invalid_test_sport' };
          }
        } else {
          status.statistics.test_games = 0;
          status.statistics.data_quality = { score: 0, rating: 'no_sports' };
        }
      } catch (testError) {
        console.warn('❌ OddsService: Service status test failed:', testError.message);
        status.statistics.test_games = 0;
        status.statistics.data_quality = { score: 0, rating: 'test_failed', error: testError.message };
      }
        
      if (usage.error || freshness.overall.status !== 'current' || status.statistics.test_games === 0) {
        status.status = 'degraded';
      }
      
      const activeProviders = this.providers.filter(p => p.name !== 'fallback' && this.providerStatus.get(p.name) === 'initialized');
      if (activeProviders.length === 0) {
        status.status = 'fallback_only';
        status.message = 'Only fallback provider is available - no real odds data';
      }
      
    } catch (error) {
      status.status = 'error';
      status.error = error.message;
    }

    return status;
  }

  async clearCache(sportKey = null) {
    await this._ensureInitialized();
    
    try {
      if (sportKey) {
        const patterns = [
          `odds:${sportKey}:*`,
          `live_games:${sportKey}:*`,
          `player_props:${sportKey}:*`
        ];
        
        let totalCleared = 0;
        for (const pattern of patterns) {
          totalCleared += await cacheService.flushPattern(pattern);
        }
        
        console.log(`🧹 OddsService: Cleared ${totalCleared} cache entries for ${sportKey}`);
      } else {
        await cacheService.flushPattern('odds:*');
        await cacheService.flushPattern('live_games:*');
        await cacheService.flushPattern('player_props:*');
        await cacheService.deleteKey('available_sports_odds_v2');
        await cacheService.deleteKey('odds_api_usage_v2');
        console.log('🧹 OddsService: Cleared all odds cache');
      }
      
      return true;
    } catch (error) {
      console.error('❌ OddsService: Cache clearance failed:', error);
      return false;
    }
  }

  getActiveProviders() {
    return this.providers
      .filter(provider => provider.name !== 'fallback')
      .map(provider => ({
        name: provider.name,
        status: this.providerStatus.get(provider.name) || 'unknown',
        priority: provider.priority
      }));
  }

  isProviderAvailable(providerName) {
    const provider = this.providers.find(p => p.name === providerName);
    return provider && this.providerStatus.get(providerName) === 'initialized';
  }
}

const oddsServiceInstance = new OddsService();
export default oddsServiceInstance;
