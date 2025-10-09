// src/services/gamesService.js - ABSOLUTE FINAL FIXED VERSION
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import env from '../config/env.js';
import redisService from './redisService.js'; // FIX: Import the service instance
import makeCache from './cacheService.js'; // FIX: Import the cache factory
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';

const CACHE_TTL = {
  SPORTS_LIST: 300,
  GAMES_DATA: 120,
  ODDS_DATA: 60
};

// NOTE: These helper classes are kept as-is to preserve original structure.
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

class GamesService {
  constructor() {
    this.lastRefreshTimes = new Map();
    this.cache = null; // FIX: Use a dedicated cache instance
  }
  
  // FIX: Centralized cache initialization
  async _getCache() {
    if (!this.cache) {
      const redisClient = await redisService.getClient();
      this.cache = makeCache(redisClient);
    }
    return this.cache;
  }

  async getAvailableSports() {
    const cacheKey = 'available_sports_comprehensive';
    
    try {
      const cache = await this._getCache();
      
      return await cache.getOrSetJSON(cacheKey, CACHE_TTL.SPORTS_LIST, async () => {
        console.log('🔄 Building comprehensive sports list...');
        
        let sports = [];
        let oddsFetchFailed = false;
        let dbFetchFailed = false;

        try {
          const oddsSports = await withTimeout(oddsService.getAvailableSports(), 5000, 'OddsSportsFetch');
          sports = [...sports, ...oddsSports];
          console.log(`✅ Added ${oddsSports.length} sports from Odds API`);
        } catch (error) {
          if (!(error instanceof TimeoutError)) {
            console.error('❌ Odds API sports fetch CRITICAL error:', error.message);
            oddsFetchFailed = true; // Mark as critical failure
          } else {
            console.warn('❌ Odds API sports fetch TIMEOUT.');
          }
        }

        try {
          const dbSports = await withTimeout(databaseService.getDistinctSports(), 5000, 'DBSportsFetch');
          sports = [...sports, ...dbSports];
          console.log(`✅ Added ${dbSports.length} sports from database`);
        } catch (error) {
          if (!(error instanceof TimeoutError)) {
            console.error('❌ Database sports fetch CRITICAL error:', error.message);
            dbFetchFailed = true; // Mark as critical failure
          } else {
            console.warn('❌ Database sports fetch TIMEOUT.');
          }
        }

        if (oddsFetchFailed && dbFetchFailed) {
          throw new Error('All primary data sources for sports failed to connect.');
        }
        
        const mappedSports = this._getSportsFromMapping();
        sports = [...sports, ...mappedSports];
        console.log(`✅ Added ${mappedSports.length} sports from comprehensive mapping`);

        const enhancedSports = this._enhanceAndDeduplicateSports(sports);
        console.log(`🎉 Final sports list: ${enhancedSports.length} sports`);
        
        return enhancedSports;
      });

    } catch (error) {
      console.error('❌ Comprehensive sports fetch failed:', error.message);
      if (error.message.includes('All primary data sources') || !(error instanceof TimeoutError)) {
        throw error; // Re-throw critical failure
      }
      // Fallback only for timeouts or non-critical issues
      console.log('🔄 Falling back to comprehensive mapping due to error.');
      return this._getSportsFromMapping();
    }
  }

  async getGamesForSport(sportKey, options = {}) {
    const {
      includeOdds = true,
      includeLive = false,
      hoursAhead = 72,
      useCache = true
    } = options;

    const cacheKey = `games_${sportKey}_${hoursAhead}_${includeOdds}_${includeLive}`;

    try {
      const cache = await this._getCache();

      const fetchGames = async () => {
        console.log(`🔄 Fetching games for ${sportKey}...`);
        let games = [];
        let source = 'unknown';

        if (includeOdds) {
          try {
            const oddsGames = await withTimeout(oddsService.getSportOdds(sportKey, { 
              includeLive, 
              hoursAhead 
            }), 8000, `OddsGamesFetch_${sportKey}`);
            if (oddsGames && oddsGames.length > 0) {
              games = oddsGames;
              source = 'odds_api';
              console.log(`✅ Found ${games.length} games from Odds API`);
            }
          } catch (error) {
            if (!(error instanceof TimeoutError)) {
               console.error(`❌ Odds API fetch CRITICAL error for ${sportKey}:`, error.message);
               throw error; // Propagate critical error
            }
            console.warn(`❌ Odds API fetch TIMEOUT for ${sportKey}.`);
          }
        }

        if (games.length === 0) {
          try {
            const dbGames = await withTimeout(databaseService.getUpcomingGames(sportKey, hoursAhead), 8000, `DBGamesFetch_${sportKey}`);
            if (dbGames && dbGames.length > 0) {
              games = dbGames;
              source = 'database';
              console.log(`✅ Found ${games.length} games from database`);
            }
          } catch (error) {
             if (!(error instanceof TimeoutError)) {
               console.error(`❌ Database fetch CRITICAL error for ${sportKey}:`, error.message);
               throw error; // Propagate critical error
             }
             console.warn(`❌ Database fetch TIMEOUT for ${sportKey}.`);
          }
        }

        const enhancedGames = GameEnhancementService.enhanceGameData(games, sportKey, source);
        this.lastRefreshTimes.set(sportKey, new Date().toISOString());
        return enhancedGames;
      };

      if (useCache) {
        return await cache.getOrSetJSON(cacheKey, CACHE_TTL.GAMES_DATA, fetchGames);
      } else {
        console.log(`🔄 Bypassing cache for ${sportKey} games...`);
        return await fetchGames();
      }

    } catch (error) {
      console.error(`❌ Games fetch CRITICAL failure for ${sportKey}:`, error);
      if (!(error instanceof TimeoutError)) {
        throw error; // Re-throw critical error
      }
      return []; // Return empty array only on timeout
    }
  }

async getVerifiedRealGames(sportKey, hours = 72) {
    console.log(`🔍 Getting VERIFIED real games for ${sportKey} from games service...`);
    
    const { THE_ODDS_API_KEY } = env;
    if (!THE_ODDS_API_KEY || THE_ODDS_API_KEY.includes('expired') || THE_ODDS_API_KEY.length < 10) {
        console.log('🎯 Skipping game validation - API keys appear invalid or expired');
        return [];
    }
    
    try {
        let realGames = [];
        
        try {
            realGames = await withTimeout(oddsService.getSportOdds(sportKey, { 
                useCache: false,
                hoursAhead: hours 
            }), 6000, 'VerifiedOddsFetch');
            console.log(`✅ Odds API: ${realGames?.length || 0} real games`);
        } catch (error) {
            console.warn(`❌ Odds API failed for verification, cannot proceed: ${error.message}`);
            return [];
        }
        
        const now = new Date();
        const horizon = new Date(now.getTime() + hours * 60 * 60 * 1000);
        
        const upcomingGames = (realGames || []).filter(game => {
            try {
                const gameTime = new Date(game.commence_time);
                return gameTime > now && gameTime <= horizon;
            } catch {
                return false;
            }
        });
        
        console.log(`📅 VERIFIED: ${upcomingGames.length} real ${sportKey} games in next ${hours}h`);
        return upcomingGames;
        
    } catch (error) {
        console.error('❌ Verified real games fetch failed:', error.message);
        return [];
    }
}

  async getLiveGames(sportKey, options = {}) {
    const {
      includeOdds = true,
      hoursAhead = 24,
      maxGames = 50
    } = options;

    try {
      const games = await this.getGamesForSport(sportKey, {
        includeOdds,
        includeLive: true,
        hoursAhead,
        useCache: false
      });

      const liveGames = GameEnhancementService.filterGamesByTime(games, hoursAhead, true)
        .slice(0, maxGames);

      console.log(`🎯 Found ${liveGames.length} live/upcoming games for ${sportKey}`);
      return liveGames;

    } catch (error) {
      console.error(`❌ Live games fetch failed for ${sportKey}:`, error);
      throw error; 
    }
  }

  async searchGames(query, sportKey = null) {
    try {
      console.log(`🔍 Searching games for: "${query}"${sportKey ? ` in ${sportKey}` : ''}`);
      
      let allGames = [];
      
      if (sportKey) {
        allGames = await this.getGamesForSport(sportKey, { useCache: false, hoursAhead: 168 }); // Wider search window
      } else {
        const majorSports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
        for (const sport of majorSports) {
          const games = await this.getGamesForSport(sport, { useCache: false, hoursAhead: 168 });
          allGames = [...allGames, ...games];
        }
      }

      const searchTerm = query.toLowerCase();
      const results = allGames.filter(game => {
        const homeTeam = game.home_team?.toLowerCase() || '';
        const awayTeam = game.away_team?.toLowerCase() || '';
        const tournament = game.tournament?.toLowerCase() || '';
        
        return homeTeam.includes(searchTerm) || 
               awayTeam.includes(searchTerm) || 
               tournament.includes(searchTerm);
      });

      console.log(`✅ Search found ${results.length} games for "${query}"`);
      return results;

    } catch (error) {
      console.error('❌ Game search failed:', error);
      throw error;
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
        sources: {}
      };

      try {
        const testSports = await oddsService.getAvailableSports();
        freshnessInfo.sources.odds_api = {
          status: 'active',
          last_success: now.toISOString(),
          sports_available: testSports?.length || 0
        };
      } catch (error) {
        freshnessInfo.sources.odds_api = {
          status: 'inactive',
          last_error: error.message,
          last_attempt: now.toISOString()
        };
        freshnessInfo.overall.status = 'degraded';
      }

      try {
        const testConnection = await withTimeout(databaseService.testConnection(), 3000, 'GamesDBTest');
        freshnessInfo.sources.database = testConnection ? 'active' : 'inactive';
        if (!testConnection) freshnessInfo.overall.status = 'degraded';
      } catch (error) {
        freshnessInfo.sources.database = 'error';
        freshnessInfo.overall.status = 'degraded';
      }

      if (sportKey) {
        const lastRefresh = this.lastRefreshTimes.get(sportKey);
        freshnessInfo.sport_specific = {
          sport_key: sportKey,
          last_refresh: lastRefresh || 'never',
          hours_since_refresh: lastRefresh ? 
            Math.round((now - new Date(lastRefresh)) / (1000 * 60 * 60)) : null
        };
      }

      return freshnessInfo;

    } catch (error) {
      console.error('❌ Data freshness check failed:', error);
      throw error;
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
      active: true
    }));
  }

  _enhanceAndDeduplicateSports(sports) {
    const seen = new Map();
    
    // Process sports with a priority source first
    const sortedSports = sports.sort((a, b) => {
        const priorityA = a.source === 'odds_api' ? 1 : a.source === 'database' ? 2 : 3;
        const priorityB = b.source === 'odds_api' ? 1 : b.source === 'database' ? 2 : 3;
        return priorityA - priorityB;
    });

    for (const sport of sortedSports) {
      if (!sport.sport_key) continue;

      const key = sport.sport_key;
      const existing = seen.get(key);

      if (!existing) {
        const comprehensiveData = COMPREHENSIVE_SPORTS[key];
        const enhancedSport = {
          sport_key: key,
          sport_title: sport.sport_title || comprehensiveData?.title || key,
          emoji: comprehensiveData?.emoji || '🏆',
          priority: sport.priority ?? comprehensiveData?.priority ?? 100,
          group: sport.group || comprehensiveData?.group,
          description: sport.description,
          active: sport.active !== false,
          has_outrights: sport.has_outrights || false,
          game_count: sport.game_count || 0,
          last_updated: sport.last_updated,
          source: sport.source || 'unknown',
          is_major: (sport.priority ?? 100) <= 20,
          is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(key)
        };
        seen.set(key, enhancedSport);
      } else {
        // Merge properties from lower priority sources if they don't exist
        existing.game_count = existing.game_count || sport.game_count || 0;
        existing.sport_title = existing.sport_title || sport.sport_title;
      }
    }

    return Array.from(seen.values()).sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  async clearCache(sportKey = null) {
    try {
      const cache = await this._getCache();
      if (sportKey) {
        const pattern = `games_${sportKey}_*`;
        await cache.delPattern(pattern); // Assumes cacheService has delPattern
        console.log(`🧹 Cleared cache entries for ${sportKey}`);
      } else {
        await cache.flush(); // Assumes cacheService has flush
        console.log('🧹 Cleared all cache');
      }
      
      this.lastRefreshTimes.clear();
      
      return true;
    } catch (error) {
      console.error('❌ Cache clearance failed:', error);
      return false;
    }
  }

  async getServiceStatus() {
    const status = {
      service: 'GamesService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: {
        enabled: true,
        ttl: CACHE_TTL
      },
      sources: {},
      statistics: {
        total_sports_supported: Object.keys(COMPREHENSIVE_SPORTS).length
      }
    };

    try {
      const testSports = await this.getAvailableSports();
      status.sources.odds_api = 'active';
      status.statistics.sports_available = testSports.length;
    } catch (error) {
      status.sources.odds_api = 'inactive';
      status.status = 'degraded';
    }

    try {
      const testConnection = await withTimeout(databaseService.testConnection(), 3000, 'GamesDBTest');
      status.sources.database = testConnection ? 'active' : 'inactive';
      if (!testConnection) status.status = 'degraded';
    } catch (error) {
      status.sources.database = 'error';
      status.status = 'degraded';
    }

    return status;
  }

  async preloadPopularSports() {
    const popularSports = [
      'americanfootball_nfl',
      'basketball_nba', 
      'baseball_mlb',
      'icehockey_nhl',
      'soccer_england_premier_league'
    ];

    console.log('🚀 Preloading cache for popular sports...');
    
    const results = [];
    for (const sport of popularSports) {
      try {
        const games = await this.getGamesForSport(sport, { useCache: true });
        results.push({
          sport,
          games_loaded: games.length,
          status: 'success'
        });
      } catch (error) {
        results.push({
          sport, 
          games_loaded: 0,
          status: 'error',
          error: error.message
        });
      }
    }

    console.log('✅ Cache preload completed');
    return results;
  }
}

export default new GamesService();
