// src/services/gamesService.js - COMPLETE FIXED VERSION
import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import env from '../config/env.js';
import { getRedisClient } from './redisService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { GameEnhancementService } from './gameEnhancementService.js';
import { DataQualityService } from './dataQualityService.js';
import { withTimeout } from '../utils/asyncUtils.js';

const CACHE_TTL = {
  SPORTS_LIST: 300,
  GAMES_DATA: 120,
  ODDS_DATA: 60
};

class GamesService {
  constructor() {
    this.lastRefreshTimes = new Map();
    this.availableSportsCache = null;
    this.availableSportsCacheTime = null;
  }

  async getAvailableSports() {
    const cacheKey = 'available_sports_comprehensive';
    
    try {
      const redis = await getRedisClient();
      if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          console.log('📦 Using cached sports list');
          return JSON.parse(cached);
        }
      }

      console.log('🔄 Building comprehensive sports list...');
      
      let sports = [];
      
      try {
        const oddsSports = await oddsService.getAvailableSports();
        sports = [...sports, ...oddsSports];
        console.log(`✅ Added ${oddsSports.length} sports from Odds API`);
      } catch (error) {
        console.warn('❌ Odds API sports fetch failed:', error.message);
      }

      try {
        const dbSports = await databaseService.getDistinctSports();
        sports = [...sports, ...dbSports];
        console.log(`✅ Added ${dbSports.length} sports from database`);
      } catch (error) {
        console.warn('❌ Database sports fetch failed:', error.message);
      }

      const mappedSports = this._getSportsFromMapping();
      sports = [...sports, ...mappedSports];
      console.log(`✅ Added ${mappedSports.length} sports from comprehensive mapping`);

      const enhancedSports = this._enhanceAndDeduplicateSports(sports);
      console.log(`🎉 Final sports list: ${enhancedSports.length} sports`);

      if (redis) {
        await redis.setex(cacheKey, CACHE_TTL.SPORTS_LIST, JSON.stringify(enhancedSports));
      }
      
      return enhancedSports;

    } catch (error) {
      console.error('❌ Comprehensive sports fetch failed:', error);
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
      if (useCache) {
        const redis = await getRedisClient();
        if (redis) {
          const cached = await redis.get(cacheKey);
          if (cached) {
            console.log(`📦 Using cached games for ${sportKey}`);
            return JSON.parse(cached);
          }
        }
      }

      console.log(`🔄 Fetching games for ${sportKey}...`);

      let games = [];
      let source = 'unknown';

      if (includeOdds) {
        try {
          const oddsGames = await oddsService.getSportOdds(sportKey, { 
            includeLive, 
            hoursAhead 
          });
          if (oddsGames && oddsGames.length > 0) {
            games = oddsGames;
            source = 'odds_api';
            console.log(`✅ Found ${games.length} games from Odds API`);
          }
        } catch (error) {
          console.warn(`❌ Odds API fetch failed for ${sportKey}:`, error.message);
        }
      }

      if (games.length === 0) {
        try {
          const dbGames = await databaseService.getUpcomingGames(sportKey, hoursAhead);
          if (dbGames && dbGames.length > 0) {
            games = dbGames;
            source = 'database';
            console.log(`✅ Found ${games.length} games from database`);
          }
        } catch (error) {
          console.warn(`❌ Database fetch failed for ${sportKey}:`, error.message);
        }
      }

      const enhancedGames = GameEnhancementService.enhanceGameData(games, sportKey, source);
      this.lastRefreshTimes.set(sportKey, new Date().toISOString());

      if (useCache && enhancedGames.length > 0) {
        const redis = await getRedisClient();
        if (redis) {
          await redis.setex(cacheKey, CACHE_TTL.GAMES_DATA, JSON.stringify(enhancedGames));
        }
      }

      return enhancedGames;

    } catch (error) {
      console.error(`❌ Games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  async getVerifiedRealGames(sportKey, hours = 72) {
    console.log(`🔍 Getting VERIFIED real games for ${sportKey} from games service...`);
    
    try {
      let realGames = [];
      
      try {
        realGames = await oddsService.getSportOdds(sportKey, { 
          useCache: false,
          hoursAhead: hours 
        });
        console.log(`✅ Odds API: ${realGames?.length || 0} real games`);
      } catch (error) {
        console.warn('❌ Odds API failed for verified games, trying database...');
      }
      
      if (!realGames || realGames.length === 0) {
        try {
          realGames = await databaseService.getVerifiedRealGames(sportKey, hours);
          console.log(`✅ Database: ${realGames?.length || 0} verified games`);
        } catch (error) {
          console.warn('❌ Database verified games failed');
        }
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
      console.error('❌ Verified real games fetch failed:', error);
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
      return [];
    }
  }

  async searchGames(query, sportKey = null) {
    try {
      console.log(`🔍 Searching games for: "${query}"${sportKey ? ` in ${sportKey}` : ''}`);
      
      let allGames = [];
      
      if (sportKey) {
        allGames = await this.getGamesForSport(sportKey, { useCache: false });
      } else {
        const majorSports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
        for (const sport of majorSports) {
          const games = await this.getGamesForSport(sport, { useCache: false });
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
        const testConnection = await databaseService.testConnection();
        freshnessInfo.sources.database = {
          status: testConnection ? 'active' : 'inactive',
          last_checked: now.toISOString()
        };
        if (!testConnection) {
          freshnessInfo.overall.status = 'degraded';
        }
      } catch (error) {
        freshnessInfo.sources.database = {
          status: 'error',
          last_error: error.message,
          last_attempt: now.toISOString()
        };
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
      return {
        overall: { status: 'unknown', last_checked: new Date().toISOString() },
        sources: {},
        error: error.message
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
      active: true
    }));
  }

  _enhanceAndDeduplicateSports(sports) {
    const seen = new Map();
    const enhanced = [];

    for (const sport of sports) {
      if (!sport.sport_key) continue;

      const key = sport.sport_key;
      const existing = seen.get(key);

      if (!existing) {
        const comprehensiveData = COMPREHENSIVE_SPORTS[key];
        const enhancedSport = {
          sport_key: key,
          sport_title: sport.sport_title || comprehensiveData?.title || key,
          emoji: comprehensiveData?.emoji || '🏆',
          priority: sport.priority || comprehensiveData?.priority || 100,
          group: sport.group || comprehensiveData?.group,
          description: sport.description,
          active: sport.active !== false,
          has_outrights: sport.has_outrights || false,
          game_count: sport.game_count || 0,
          last_updated: sport.last_updated,
          source: sport.source || 'unknown',
          is_major: (sport.priority || 100) <= 20,
          is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(key)
        };

        seen.set(key, enhancedSport);
        enhanced.push(enhancedSport);
      } else {
        if (sport.source === 'odds_api' && existing.source !== 'odds_api') {
          Object.assign(existing, sport);
          existing.source = 'odds_api';
        }
        if (sport.game_count && (!existing.game_count || sport.game_count > existing.game_count)) {
          existing.game_count = sport.game_count;
        }
      }
    }

    return enhanced.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  async clearCache(sportKey = null) {
    try {
      const redis = await getRedisClient();
      if (redis) {
        if (sportKey) {
          const pattern = `games_${sportKey}_*`;
          const keys = await redis.keys(pattern);
          if (keys.length > 0) {
            await redis.del(...keys);
            console.log(`🧹 Cleared ${keys.length} cache entries for ${sportKey}`);
          }
        } else {
          await redis.flushdb();
          console.log('🧹 Cleared all cache');
        }
      }
      
      this.availableSportsCache = null;
      this.availableSportsCacheTime = null;
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
      const testConnection = await databaseService.testConnection();
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
