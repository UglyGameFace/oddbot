// src/services/gamesService.js - COMPLETE FIXED VERSION
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import env from '../config/env.js';
import cacheService from './cacheService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';

const CACHE_TTL = {
  SPORTS_LIST: 300,      // 5 minutes
  GAMES_DATA: 120,       // 2 minutes  
  ODDS_DATA: 60,         // 1 minute
  VERIFIED_GAMES: 180    // 3 minutes
};

class GameEnhancementService {
  static enhanceGameData(games, sportKey, source) {
    if (!Array.isArray(games)) return [];

    return games.map((game) => ({
      ...game,
      enhanced: true,
      enhancement_source: source,
      last_enhanced: new Date().toISOString(),
      has_odds: !!(game.bookmakers && game.bookmakers.length > 0),
      sport_key: sportKey,
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
      const isLive = includeLive && game.status === 'live';

      return isUpcoming || isLive;
    });
  }

  static validateGameData(game) {
    if (!game) return false;
    
    const requiredFields = ['event_id', 'sport_key', 'commence_time', 'home_team', 'away_team'];
    const hasRequiredFields = requiredFields.every(field => 
      game[field] !== undefined && game[field] !== null
    );

    if (!hasRequiredFields) {
      console.warn(`⚠️ Game validation failed - missing required fields:`, game.event_id);
      return false;
    }

    // --- CHANGE START ---
    // Increased the time window to 4 hours to allow for games in progress.
    const gameTime = new Date(game.commence_time);
    const now = new Date();
    const isWithinWindow = gameTime > new Date(now.getTime() - 4 * 60 * 60 * 1000); // Up to 4 hours in past
    
    if (!isWithinWindow) {
      console.warn(`⚠️ Game validation failed - commence_time too far in past:`, game.event_id, game.commence_time);
      return false;
    }
    // --- CHANGE END ---

    return true;
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
    };
  }
}

class GamesService {
  constructor() {
    this.lastRefreshTimes = new Map();
    this.requestCounts = new Map();
    this.initialized = false;
    
    console.log('🎮 GamesService: Initializing...');
  }

  async _ensureInitialized() {
    if (this.initialized) return;
    
    console.log('🔄 GamesService: Performing first-time initialization...');
    
    // Warm up the cache service
    try {
      await cacheService.healthCheck();
      console.log('✅ GamesService: Cache service ready');
    } catch (error) {
      console.warn('⚠️ GamesService: Cache service not available, continuing without cache');
    }
    
    this.initialized = true;
  }

  async _incrementRequestCount(sportKey) {
    const now = new Date().toISOString();
    const count = this.requestCounts.get(sportKey) || 0;
    this.requestCounts.set(sportKey, count + 1);
    this.lastRefreshTimes.set(sportKey, now);
  }

  async getAvailableSports() {
    await this._ensureInitialized();
    
    const cacheKey = 'available_sports_comprehensive_v2';
    
    try {
      console.log('🔄 GamesService: Fetching available sports...');
      
      return await cacheService.getOrSetJSON(
        cacheKey, 
        CACHE_TTL.SPORTS_LIST, 
        async () => {
          console.log('🔄 GamesService: Building comprehensive sports list from sources...');
          
          let sports = [];
          let oddsFetchFailed = false;
          let dbFetchFailed = false;

          // Try Odds API first
          try {
            const oddsSports = await withTimeout(
              oddsService.getAvailableSports(), 
              5000, 
              'OddsSportsFetch'
            );
            if (oddsSports && oddsSports.length > 0) {
              sports = [...sports, ...oddsSports];
              console.log(`✅ GamesService: Added ${oddsSports.length} sports from Odds API`);
            } else {
              throw new Error('No sports returned from Odds API');
            }
          } catch (error) {
            if (!(error instanceof TimeoutError)) {
              console.error('❌ GamesService: Odds API sports fetch CRITICAL error:', error.message);
              oddsFetchFailed = true; 
            } else {
              console.warn('❌ GamesService: Odds API sports fetch TIMEOUT');
            }
          }

          // Try Database next
          try {
            const dbSports = await withTimeout(
              databaseService.getDistinctSports(), 
              5000, 
              'DBSportsFetch'
            );
            if (dbSports && dbSports.length > 0) {
              sports = [...sports, ...dbSports];
              console.log(`✅ GamesService: Added ${dbSports.length} sports from database`);
            }
          } catch (error) {
            if (!(error instanceof TimeoutError)) {
              console.error('❌ GamesService: Database sports fetch CRITICAL error:', error.message);
              dbFetchFailed = true; 
            } else {
              console.warn('❌ GamesService: Database sports fetch TIMEOUT');
            }
          }

          if (oddsFetchFailed && dbFetchFailed) {
            console.error('❌ GamesService: All primary data sources for sports failed');
          }
          
          const mappedSports = this._getSportsFromMapping();
          sports = [...sports, ...mappedSports];
          console.log(`✅ GamesService: Added ${mappedSports.length} sports from comprehensive mapping`);

          const enhancedSports = this._enhanceAndDeduplicateSports(sports);
          console.log(`🎉 GamesService: Final sports list - ${enhancedSports.length} sports`);
          
          return enhancedSports;
        },
        {
          context: { operation: 'getAvailableSports' },
          fallbackOnError: true,
          lockMs: 10000
        }
      );

    } catch (error) {
      console.error('❌ GamesService: Comprehensive sports fetch failed:', error.message);
      
      console.log('🔄 GamesService: Falling back to comprehensive mapping only');
      return this._getSportsFromMapping();
    }
  }

  async getGamesForSport(sportKey, options = {}) {
    await this._ensureInitialized();
    await this._incrementRequestCount(sportKey);
    
    const {
      includeOdds = true,
      includeLive = false,
      hoursAhead = 72,
      useCache = true,
      forceRefresh = false
    } = options;

    const cacheKey = `games_${sportKey}_${hoursAhead}_${includeOdds}_${includeLive}_v2`;

    if (forceRefresh) {
      try {
        await cacheService.deleteKey(cacheKey);
        console.log(`🗑️ GamesService: Force refresh - cleared cache for ${sportKey}`);
      } catch (error) {
        console.warn(`⚠️ GamesService: Failed to clear cache for force refresh:`, error.message);
      }
    }

    try {
      const fetchAndProcessGames = async () => {
        console.log(`🔄 GamesService: Fetching fresh games for ${sportKey}...`);
        let games = [];
        let source = 'unknown';

        if (includeOdds) {
          try {
            const oddsGames = await withTimeout(
              oddsService.getSportOdds(sportKey, { 
                includeLive, 
                hoursAhead,
                useCache: false
              }), 
              10000, 
              `OddsGamesFetch_${sportKey}`
            );
            
            if (oddsGames && oddsGames.length > 0) {
              games = oddsGames;
              source = 'odds_api';
              console.log(`✅ GamesService: Found ${games.length} games from Odds API for ${sportKey}`);
            } else {
              console.warn(`⚠️ GamesService: Odds API returned no games for ${sportKey}`);
            }
          } catch (error) {
            console.warn(`⚠️ GamesService: Odds API failed for ${sportKey}:`, error.message);
          }
        }

        if (games.length === 0) {
          try {
            const dbGames = await withTimeout(
              databaseService.getUpcomingGames(sportKey, hoursAhead), 
              8000, 
              `DBGamesFetch_${sportKey}`
            );
            if (dbGames && dbGames.length > 0) {
              games = dbGames;
              source = 'database';
              console.log(`✅ GamesService: Found ${dbGames.length} games from database for ${sportKey}`);
            } else {
              console.warn(`⚠️ GamesService: Database returned no games for ${sportKey}`);
            }
          } catch (error) {
            console.warn(`⚠️ GamesService: Database fallback also failed for ${sportKey}:`, error.message);
          }
        }
        
        const validGames = games.filter(GameEnhancementService.validateGameData);
        const enhancedGames = GameEnhancementService.enhanceGameData(validGames, sportKey, source);
        
        console.log(`✅ GamesService: Processed ${enhancedGames.length} valid games for ${sportKey} (from ${games.length} raw)`);
        
        this.lastRefreshTimes.set(sportKey, new Date().toISOString());
        return enhancedGames;
      };

      if (useCache && cacheService.isAvailable()) {
        return await cacheService.getOrSetJSON(
          cacheKey, 
          CACHE_TTL.GAMES_DATA, 
          fetchAndProcessGames,
          { context: { sport: sportKey, operation: 'getGamesForSport', includeOdds, hoursAhead }, fallbackOnError: true, lockMs: 15000 }
        );
      } else {
        console.log(`🔄 GamesService: Bypassing cache for ${sportKey} games...`);
        return await fetchAndProcessGames();
      }

    } catch (error) {
      console.error(`❌ GamesService: CRITICAL failure for ${sportKey}:`, error.message);
      
      if (error instanceof TimeoutError) {
        console.warn(`⏰ GamesService: Timeout for ${sportKey}, returning empty results`);
        return [];
      }
      
      throw error;
    }
  }

  async getVerifiedRealGames(sportKey, hours = 72) {
    await this._ensureInitialized();
    const cacheKey = `verified_games_${sportKey}_${hours}_v2`;
    console.log(`🔍 GamesService: Getting VERIFIED real games for ${sportKey}...`);
    
    try {
      return await cacheService.getOrSetJSON(
        cacheKey,
        CACHE_TTL.VERIFIED_GAMES,
        async () => {
          let realGames = [];
          
          try {
            const webGames = await withTimeout(
              import('../services/webSportsService.js').then(module => 
                module.WebSportsService.getUpcomingGames(sportKey, hours)
              ), 
              15000, 
              'WebSportsFetch'
            );
            
            if (webGames && webGames.length > 0) {
              console.log(`✅ GamesService: Web Sources - ${webGames.length} real ${sportKey} games`);
              realGames = webGames;
            } else {
              console.warn(`⚠️ GamesService: Web sources returned no games for ${sportKey}`);
            }
          } catch (webError) {
            console.warn('❌ GamesService: Web sources failed:', webError.message);
          }
          
          const { THE_ODDS_API_KEY } = env;
          const hasValidOddsAPI = THE_ODDS_API_KEY && !THE_ODDS_API_KEY.includes('expired') && THE_ODDS_API_KEY.length > 20;
          
          if (hasValidOddsAPI && realGames.length === 0) {
            try {
              const oddsGames = await withTimeout(
                oddsService.getSportOdds(sportKey, { useCache: false, hoursAhead: hours }), 
                8000, 
                'VerifiedOddsFetch'
              );
              
              if (oddsGames && oddsGames.length > 0) {
                console.log(`✅ GamesService: Odds API - ${oddsGames.length} real games`);
                realGames = oddsGames;
              }
            } catch (oddsError) {
              console.warn('❌ GamesService: Odds API failed:', oddsError.message);
            }
          } else if (!hasValidOddsAPI) {
            console.log('🎯 GamesService: Skipping Odds API - keys expired, using web sources only');
          }
          
          const validGames = realGames.filter(GameEnhancementService.validateGameData);
          console.log(`📅 GamesService: VERIFIED - ${validGames.length} real ${sportKey} games in next ${hours}h`);
          
          return validGames;
        },
        { context: { operation: 'getVerifiedRealGames', sport: sportKey }, fallbackOnError: true }
      );
      
    } catch (error) {
      console.error('❌ GamesService: Verified real games fetch failed:', error);
      return [];
    }
  }

  async getLiveGames(sportKey, options = {}) {
    await this._ensureInitialized();
    await this._incrementRequestCount(sportKey);
    
    const { includeOdds = true, hoursAhead = 24, maxGames = 50 } = options;
    const cacheKey = `live_games_${sportKey}_${hoursAhead}_v2`;

    try {
      return await cacheService.getOrSetJSON(
        cacheKey,
        CACHE_TTL.GAMES_DATA,
        async () => {
          const games = await this.getGamesForSport(sportKey, { includeOdds, includeLive: true, hoursAhead, useCache: false });
          const liveGames = GameEnhancementService.filterGamesByTime(games, hoursAhead, true)
            .filter(GameEnhancementService.validateGameData)
            .slice(0, maxGames);

          console.log(`🎯 GamesService: Found ${liveGames.length} live/upcoming games for ${sportKey}`);
          return liveGames;
        },
        { context: { operation: 'getLiveGames', sport: sportKey }, fallbackOnError: true }
      );

    } catch (error) {
      console.error(`❌ GamesService: Live games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  async searchGames(query, sportKey = null) {
    await this._ensureInitialized();
    const cacheKey = `search_${sportKey || 'all'}_${query.toLowerCase().replace(/[^a-z0-9]/g, '_')}_v2`;

    try {
      return await cacheService.getOrSetJSON(
        cacheKey,
        300,
        async () => {
          console.log(`🔍 GamesService: Searching games for: "${query}"${sportKey ? ` in ${sportKey}` : ''}`);
          
          let allGames = [];
          
          if (sportKey) {
            allGames = await this.getGamesForSport(sportKey, { useCache: false, hoursAhead: 168 });
          } else {
            const majorSports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
            const gamePromises = majorSports.map(sport => 
              this.getGamesForSport(sport, { useCache: false, hoursAhead: 168 })
                .catch(error => {
                  console.warn(`⚠️ GamesService: Failed to get games for ${sport} during search:`, error.message);
                  return [];
                })
            );
            
            const results = await Promise.allSettled(gamePromises);
            results.forEach(result => {
              if (result.status === 'fulfilled') {
                allGames = [...allGames, ...result.value];
              }
            });
          }

          const searchTerm = query.toLowerCase();
          const results = allGames.filter(game => {
            const homeTeam = game.home_team?.toLowerCase() || '';
            const awayTeam = game.away_team?.toLowerCase() || '';
            const tournament = game.tournament?.toLowerCase() || '';
            const sportTitle = game.sport_title?.toLowerCase() || '';
            
            return homeTeam.includes(searchTerm) || awayTeam.includes(searchTerm) || tournament.includes(searchTerm) || sportTitle.includes(searchTerm);
          });

          console.log(`✅ GamesService: Search found ${results.length} games for "${query}"`);
          return results;
        },
        { context: { operation: 'searchGames', query, sportKey }, fallbackOnError: true }
      );

    } catch (error) {
      console.error('❌ GamesService: Game search failed:', error);
      return [];
    }
  }

  async getDataFreshness(sportKey = null) {
    await this._ensureInitialized();
    
    try {
      const now = new Date();
      let freshnessInfo = {
        overall: { last_checked: now.toISOString(), status: 'current', service: 'GamesService' },
        sources: {},
        cache: { enabled: cacheService.isAvailable(), status: cacheService.isAvailable() ? 'active' : 'inactive' }
      };

      try {
        const testSports = await withTimeout(oddsService.getAvailableSports(), 5000, 'FreshnessOddsTest');
        freshnessInfo.sources.odds_api = { status: 'active', last_success: now.toISOString(), sports_available: testSports?.length || 0, response_time: 'ok' };
      } catch (error) {
        freshnessInfo.sources.odds_api = { status: 'inactive', last_error: error.message, last_attempt: now.toISOString(), response_time: 'timeout' };
        freshnessInfo.overall.status = 'degraded';
      }

      try {
        const testConnection = await withTimeout(databaseService.testConnection(), 3000, 'FreshnessDBTest');
        freshnessInfo.sources.database = { status: testConnection ? 'active' : 'inactive', last_checked: now.toISOString() };
        if (!testConnection) freshnessInfo.overall.status = 'degraded';
      } catch (error) {
        freshnessInfo.sources.database = { status: 'error', last_error: error.message, last_attempt: now.toISOString() };
        freshnessInfo.overall.status = 'degraded';
      }

      if (sportKey) {
        const lastRefresh = this.lastRefreshTimes.get(sportKey);
        const requestCount = this.requestCounts.get(sportKey) || 0;
        freshnessInfo.sport_specific = {
          sport_key: sportKey,
          last_refresh: lastRefresh || 'never',
          hours_since_refresh: lastRefresh ? Math.round((now - new Date(lastRefresh)) / (1000 * 60 * 60)) : null,
          request_count: requestCount,
          in_comprehensive_mapping: !!COMPREHENSIVE_SPORTS[sportKey]
        };
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
      console.error('❌ GamesService: Data freshness check failed:', error);
      return {
        overall: { status: 'error', error: error.message, last_checked: new Date().toISOString() },
        sources: {},
        cache: { enabled: false, status: 'unknown' }
      };
    }
  }

  _getSportsFromMapping() {
    return Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
      sport_key,
      sport_title: data.title,
      emoji: data.emoji,
      priority: data.priority,
      group: data.group,
      source: 'comprehensive_mapping',
      active: true,
      has_mapping: true,
      is_fallback: true
    }));
  }

  _enhanceAndDeduplicateSports(sports) {
    const seen = new Map();
    const sortedSports = sports.sort((a, b) => {
        const priorityMap = { 'odds_api': 1, 'database': 2, 'comprehensive_mapping': 3, 'unknown': 4 };
        return (priorityMap[a.source] || 4) - (priorityMap[b.source] || 4);
    });

    for (const sport of sortedSports) {
      if (!sport.sport_key) continue;
      const key = sport.sport_key;
      const existing = seen.get(key);
      if (!existing) {
        const comprehensiveData = COMPREHENSIVE_SPORTS[key];
        seen.set(key, {
          sport_key: key,
          sport_title: sport.sport_title || comprehensiveData?.title || this._formatSportKey(key),
          emoji: comprehensiveData?.emoji || '🏆',
          priority: sport.priority ?? comprehensiveData?.priority ?? 100,
          group: sport.group || comprehensiveData?.group || 'other',
          description: sport.description,
          active: sport.active !== false,
          has_outrights: sport.has_outrights || false,
          game_count: sport.game_count || 0,
          last_updated: sport.last_updated || new Date().toISOString(),
          source: sport.source || 'unknown',
          is_major: (sport.priority ?? 100) <= 20,
          is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(key),
          has_mapping: !!COMPREHENSIVE_SPORTS[key]
        });
      } else {
        existing.game_count = existing.game_count || sport.game_count || 0;
        existing.sport_title = existing.sport_title || sport.sport_title;
        existing.active = existing.active || sport.active;
      }
    }
    return Array.from(seen.values()).sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  _formatSportKey(sportKey) {
    return sportKey.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  async clearCache(sportKey = null) {
    await this._ensureInitialized();
    try {
      if (sportKey) {
        const patterns = [`games_${sportKey}_*`, `live_games_${sportKey}_*`, `verified_games_${sportKey}_*`, `search_${sportKey}_*`];
        let totalCleared = 0;
        for (const pattern of patterns) {
          totalCleared += await cacheService.flushPattern(pattern);
        }
        console.log(`🧹 GamesService: Cleared ${totalCleared} cache entries for ${sportKey}`);
      } else {
        await Promise.all([
          cacheService.flushPattern('games_*'),
          cacheService.flushPattern('live_games_*'),
          cacheService.flushPattern('verified_games_*'),
          cacheService.flushPattern('search_*'),
          cacheService.deleteKey('available_sports_comprehensive_v2')
        ]);
        console.log('🧹 GamesService: Cleared all games cache');
      }
      this.lastRefreshTimes.clear();
      return true;
    } catch (error) {
      console.error('❌ GamesService: Cache clearance failed:', error);
      return false;
    }
  }

  async getServiceStatus() {
    await this._ensureInitialized();
    const status = {
      service: 'GamesService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: { enabled: cacheService.isAvailable(), status: cacheService.isAvailable() ? 'active' : 'inactive' },
      sources: {},
      statistics: {
        total_sports_supported: Object.keys(COMPREHENSIVE_SPORTS).length,
        last_refresh_times: Object.fromEntries(this.lastRefreshTimes),
        request_counts: Object.fromEntries(this.requestCounts)
      }
    };

    try {
      const testSports = await withTimeout(this.getAvailableSports(), 5000, 'StatusSportsTest');
      status.sources.odds_api = 'active';
      status.statistics.sports_available = testSports.length;
    } catch (error) {
      status.sources.odds_api = 'inactive';
      status.status = 'degraded';
      status.statistics.sports_available = 0;
    }

    try {
      const testConnection = await withTimeout(databaseService.testConnection(), 3000, 'StatusDBTest');
      status.sources.database = testConnection ? 'active' : 'inactive';
      if (!testConnection) status.status = 'degraded';
    } catch (error) {
      status.sources.database = 'error';
      status.status = 'degraded';
    }

    if (cacheService.isAvailable()) {
      try {
        const cacheHealth = await cacheService.healthCheck();
        status.cache.health = cacheHealth.healthy ? 'healthy' : 'unhealthy';
        status.cache.response_time = cacheHealth.response_time;
      } catch (error) {
        status.cache.health = 'error';
        status.cache.error = error.message;
        status.status = 'degraded';
      }
    }
    return status;
  }

  async preloadPopularSports() {
    await this._ensureInitialized();
    const popularSports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'soccer_england_premier_league'];
    console.log('🚀 GamesService: Preloading cache for popular sports...');
    const results = [];
    for (const sport of popularSports) {
      try {
        const games = await this.getGamesForSport(sport, { useCache: true });
        results.push({ sport, games_loaded: games.length, status: 'success', data_quality: DataQualityService.assessDataQuality(games) });
      } catch (error) {
        results.push({ sport, games_loaded: 0, status: 'error', error: error.message });
      }
    }
    console.log('✅ GamesService: Cache preload completed');
    return results;
  }

  async getDataQualityReport(sportKey = null) {
    await this._ensureInitialized();
    try {
      if (sportKey) {
        const games = await this.getGamesForSport(sportKey, { useCache: false });
        return DataQualityService.assessDataQuality(games);
      }
      const majorSports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
      const reports = {};
      for (const sport of majorSports) {
        try {
          const games = await this.getGamesForSport(sport, { useCache: false });
          reports[sport] = DataQualityService.assessDataQuality(games);
        } catch (error) {
          reports[sport] = { error: error.message, status: 'failed' };
        }
      }
      return reports;
    } catch (error) {
      console.error('❌ GamesService: Data quality report failed:', error);
      throw error;
    }
  }
}

const gamesServiceInstance = new GamesService();
export default gamesServiceInstance;
