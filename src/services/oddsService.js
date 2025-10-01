// src/services/oddsService.js - COMPLETE FIXED VERSION
import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import rateLimitService from './rateLimitService.js';
import makeCache from './cacheService.js';
import { getSportTitle } from './sportsService.js';
// Cache configuration aligned with other services
const CACHE_TTL = {
  ODDS: 60,     // 1 minute for odds data
  PROPS: 120,   // 2 minutes for player props
  SPORTS: 300   // 5 minutes for sports list
};

// Timeout and retry configuration
const REQUEST_TIMEOUT = 10000;
const LOCK_MS = 8000;
const RETRY_MS = 150;

// API endpoints
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORTRADAR_BASE = 'https://api.sportradar.us/odds/v1/en/us/sports';

// Enhanced sport mapping for consistent titles
const SPORT_MAPPING = {
  'americanfootball_nfl': 'NFL',
  'americanfootball_ncaaf': 'NCAAF',
  'basketball_nba': 'NBA',
  'basketball_wnba': 'WNBA',
  'basketball_ncaab': 'NCAAB',
  'baseball_mlb': 'MLB',
  'icehockey_nhl': 'NHL',
  'soccer_england_premier_league': 'Premier League',
  'soccer_uefa_champions_league': 'Champions League',
  'tennis_atp': 'ATP Tennis',
  'mma_ufc': 'UFC'
};

// Utility functions
const titleFromKey = (key) => {
  if (!key) return 'Unknown Sport';
  return SPORT_MAPPING[key] || key.split('_').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

// Enhanced data validation
function validateGameData(game) {
  if (!game) return false;
  
  const required = ['id', 'sport_key', 'commence_time', 'home_team', 'away_team'];
  return required.every(field => 
    game[field] !== undefined && 
    game[field] !== null && 
    String(game[field]).trim() !== ''
  );
}

function validatePlayerPropsData(props) {
  if (!props || !Array.isArray(props)) return false;
  return props.length > 0 && props.every(bookmaker => 
    bookmaker?.key && bookmaker?.title && Array.isArray(bookmaker.markets)
  );
}

class OddsService {
  constructor() {
    this.apiProviders = [
      { 
        name: 'theodds', 
        fetch: this._fetchFromTheOddsAPI.bind(this),
        priority: 1
      },
      { 
        name: 'sportradar', 
        fetch: this._fetchFromSportRadar.bind(this),
        priority: 2
      },
      { 
        name: 'apisports', 
        fetch: this._fetchFromApiSports.bind(this),
        priority: 3
      },
    ];
    
    // Sort providers by priority
    this.apiProviders.sort((a, b) => a.priority - b.priority);
    
    // Initialize cache
    this.cache = null;
  }

  async _getCache() {
    if (!this.cache) {
      const redis = await redisClient;
      this.cache = makeCache(redis);
    }
    return this.cache;
  }

  /**
   * Get available sports from The Odds API
   */
  async getAvailableSports() {
    const cacheKey = 'available_sports_odds';
    
    try {
      const cache = await this._getCache();
      
      const sports = await cache.getOrSetJSON(cacheKey, CACHE_TTL.SPORTS, async () => {
        console.log('🔄 Fetching sports list from The Odds API...');
        
        try {
          const url = `${ODDS_BASE}/sports`;
          const response = await withTimeout(
            axios.get(url, { 
              params: { 
                apiKey: env.THE_ODDS_API_KEY,
                all: 'false' // Only return active sports
              } 
            }),
            REQUEST_TIMEOUT,
            'getAvailableSports'
          );

          await rateLimitService.saveProviderQuota('theodds', response.headers);
          
          const sports = (response.data || []).map(sport => ({
            key: sport.key,
            title: sport.title || titleFromKey(sport.key),
            group: sport.group,
            description: sport.description,
            active: sport.active !== false,
            has_outrights: sport.has_outrights || false
          }));

          console.log(`✅ Found ${sports.length} sports from The Odds API`);
          return sports;

        } catch (error) {
          console.error('❌ Failed to fetch sports from The Odds API:', error.message);
          
          // Return comprehensive fallback
          return Object.entries(SPORT_MAPPING).map(([key, title]) => ({
            key,
            title,
            group: this._inferSportGroup(key),
            description: `${title} betting markets`,
            active: true,
            has_outrights: this._hasOutrights(key)
          }));
        }
      });

      return sports;

    } catch (error) {
      console.error('❌ Sports list cache error:', error);
      sentryService.captureError(error, { component: 'odds_service', operation: 'getAvailableSports' });
      
      // Final fallback
      return Object.entries(SPORT_MAPPING).map(([key, title]) => ({
        key,
        title,
        group: this._inferSportGroup(key),
        active: true
      }));
    }
  }

  /**
   * Get sport odds with enhanced caching and error handling
   */
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
        },
        { lockMs: LOCK_MS, retryMs: RETRY_MS }
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

  /**
   * Get player props with enhanced data validation
   */
  async getPlayerPropsForGame(sportKey, gameId, options = {}) {
    const {
      regions = 'us',
      bookmakers,
      markets = 'player_points,player_rebounds,player_assists',
      oddsFormat = 'american',
      useCache = true
    } = options;

    const scope = bookmakers ? `bk:${bookmakers}` : `rg:${regions}`;
    const cacheKey = `player_props:${sportKey}:${gameId}:${scope}:${markets}:${oddsFormat}`;
    
    try {
      const cache = await this._getCache();
      
      if (!useCache) {
        console.log(`🔄 Bypassing cache for ${sportKey} player props...`);
        return await this._fetchPlayerProps(sportKey, gameId, options);
      }

      return await cache.getOrSetJSON(
        cacheKey,
        CACHE_TTL.PROPS,
        async () => {
          return await this._fetchPlayerProps(sportKey, gameId, options);
        },
        { lockMs: LOCK_MS, retryMs: RETRY_MS }
      );

    } catch (error) {
      console.error(`❌ Player props fetch failed for ${gameId}:`, error.message);
      sentryService.captureError(error, { 
        component: 'odds_service',
        operation: 'getPlayerPropsForGame', 
        sportKey,
        gameId
      });
      return [];
    }
  }

  /**
   * Get live/upcoming games with real-time odds
   */
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
        useCache: false // Don't cache live data
      });

      // Filter for games happening soon or live
      const now = new Date();
      const soon = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      const liveGames = allGames
        .filter(game => {
          if (!game.commence_time) return false;
          const gameTime = new Date(game.commence_time);
          return gameTime >= now && gameTime <= soon;
        })
        .slice(0, maxGames);

      console.log(`🎯 Found ${liveGames.length} live/upcoming games for ${sportKey}`);
      return liveGames;

    } catch (error) {
      console.error(`❌ Live games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  /**
   * Enhanced data freshness information
   */
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

      // Test each provider
      for (const provider of this.apiProviders) {
        try {
          const quota = await rateLimitService.getProviderQuota(provider.name);
          freshnessInfo.providers[provider.name] = {
            status: quota ? 'active' : 'unknown',
            last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
            remaining_requests: quota?.remaining,
            should_bypass: await rateLimitService.shouldBypassLive(provider.name)
          };
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
            data_quality: this._assessDataQuality(testGames),
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

  /**
   * Fetch sport odds with provider fallback
   */
  async _fetchSportOddsWithFallback(sportKey, options) {
    console.log(`🔄 Fetching odds for ${sportKey}...`);
    
    for (const provider of this.apiProviders) {
      try {
        // Check rate limits
        if (await rateLimitService.shouldBypassLive(provider.name)) {
          console.log(`⏭️ Skipping ${provider.name} due to rate limits`);
          continue;
        }

        console.log(`🔧 Trying ${provider.name} for ${sportKey}...`);
        const rows = await provider.fetch(sportKey, options);
        
        if (rows && rows.length > 0) {
          console.log(`✅ ${provider.name} returned ${rows.length} games for ${sportKey}`);
          return rows;
        }
        
        console.log(`⚠️ ${provider.name} returned no data for ${sportKey}`);

      } catch (error) {
        console.error(`❌ ${provider.name} failed for ${sportKey}:`, error.message);
        
        // Update rate limit info
        if (error?.response?.headers) {
          await rateLimitService.saveProviderQuota(provider.name, error.response.headers);
        }

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

  /**
   * Fetch player props directly
   */
  async _fetchPlayerProps(sportKey, gameId, options) {
    const {
      regions = 'us',
      bookmakers,
      markets = 'player_points,player_rebounds,player_assists',
      oddsFormat = 'american'
    } = options;

    // Check rate limits
    if (await rateLimitService.shouldBypassLive('theodds')) {
      console.log('⏭️ Skipping player props due to rate limits');
      return [];
    }

    try {
      console.log(`🔄 Fetching player props for ${gameId}...`);
      
      const url = `${ODDS_BASE}/sports/${sportKey}/events/${gameId}/odds`;
      const params = { 
        apiKey: env.THE_ODDS_API_KEY, 
        oddsFormat, 
        markets, 
        dateFormat: 'iso' 
      };
      
      if (bookmakers) params.bookmakers = bookmakers; 
      else params.regions = regions;

      const response = await withTimeout(
        axios.get(url, { params }),
        REQUEST_TIMEOUT,
        `getPlayerProps_${gameId}`
      );

      await rateLimitService.saveProviderQuota('theodds', response.headers);
      
      const props = response.data?.bookmakers || [];
      
      if (!validatePlayerPropsData(props)) {
        console.warn(`⚠️ Invalid player props data for ${gameId}`);
        return [];
      }

      console.log(`✅ Found player props from ${props.length} bookmakers for ${gameId}`);
      return props;

    } catch (error) {
      console.error(`❌ Player props fetch failed for ${gameId}:`, error.message);
      
      // Update rate limits
      if (error?.response?.headers) {
        await rateLimitService.saveProviderQuota('theodds', error.response.headers);
      }

      // Only log non-rate-limit errors
      if (error?.response?.status !== 429) {
        sentryService.captureError(error, { 
          component: 'odds_service_player_props', 
          sportKey, 
          gameId 
        });
      }
      
      return [];
    }
  }

  /**
   * Provider implementations with enhanced error handling
   */
  async _fetchFromTheOddsAPI(sportKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american'
    } = options;

    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const response = await withTimeout(
      axios.get(url, { 
        params: { 
          apiKey: env.THE_ODDS_API_KEY, 
          regions, 
          markets, 
          oddsFormat, 
          dateFormat: 'iso' 
        } 
      }),
      REQUEST_TIMEOUT,
      `theodds_${sportKey}`
    );

    await rateLimitService.saveProviderQuota('theodds', response.headers);
    return this._transformTheOddsAPIData(response.data, sportKey);
  }

  async _fetchFromSportRadar(sportKey, options = {}) {
    const radarSportKey = sportKey.split('_')[1] || 'nfl';
    const url = `${SPORTRADAR_BASE}/${radarSportKey}/schedule.json`;
    
    const response = await withTimeout(
      axios.get(url, { 
        params: { 
          api_key: env.SPORTRADAR_API_KEY 
        } 
      }),
      REQUEST_TIMEOUT,
      `sportradar_${sportKey}`
    );

    await rateLimitService.saveProviderQuota('sportradar', response.headers);
    return this._transformSportRadarData(response.data?.sport_events, sportKey);
  }

  async _fetchFromApiSports(sportKey, options = {}) {
    // TODO: Implement API Sports integration
    console.log(`🔧 API Sports not yet implemented for ${sportKey}`);
    return [];
  }

  /**
   * Enhanced data transformation with validation
   */
  _transformTheOddsAPIData(data, sportKey) {
    if (!Array.isArray(data)) {
      console.warn('⚠️ TheOddsAPI returned non-array data');
      return [];
    }

    return data.reduce((acc, game) => {
      if (!validateGameData(game)) {
        console.warn(`[Data Validation] Discarding invalid game: ${JSON.stringify(game)}`);
        return acc;
      }

      const enhancedGame = {
        event_id: game.id,
        sport_key: sportKey,
        league_key: game.sport_title || titleFromKey(sportKey),
        commence_time: game.commence_time,
        home_team: game.home_team,
        away_team: game.away_team,
        market_data: { 
          bookmakers: game.bookmakers || [],
          last_updated: new Date().toISOString()
        },
        sport_title: game.sport_title || titleFromKey(sportKey),
        data_quality: this._assessGameDataQuality(game)
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  _transformSportRadarData(events, sportKey) {
    if (!Array.isArray(events)) {
      console.warn('⚠️ SportRadar returned non-array data');
      return [];
    }

    return events.reduce((acc, event) => {
      if (!event?.id || !event?.start_time) {
        console.warn(`[Data Validation] Discarding invalid SportRadar event: ${JSON.stringify(event)}`);
        return acc;
      }

      const title = event?.sport_event_context?.competition?.name || titleFromKey(sportKey);
      const competitors = event?.competitors || [];
      
      const enhancedGame = {
        event_id: `sr_${event.id}`,
        sport_key: sportKey,
        league_key: title,
        commence_time: event.start_time,
        home_team: competitors.find(c => c.qualifier === 'home')?.name || 'N/A',
        away_team: competitors.find(c => c.qualifier === 'away')?.name || 'N/A',
        market_data: { 
          bookmakers: [],
          last_updated: new Date().toISOString()
        },
        sport_title: title,
        data_quality: this._assessGameDataQuality(event)
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  /**
   * Data quality assessment
   */
  _assessGameDataQuality(game) {
    let score = 0;
    let factors = [];

    if (game.home_team && game.away_team && game.home_team !== 'N/A' && game.away_team !== 'N/A') {
      score += 30;
      factors.push('valid_teams');
    }

    if (game.commence_time) {
      score += 20;
      factors.push('start_time');
    }

    if (game.bookmakers && game.bookmakers.length > 0) {
      score += 30;
      factors.push(`odds_from_${game.bookmakers.length}_books`);
    }

    if (game.bookmakers && game.bookmakers.length >= 3) {
      score += 20;
      factors.push('multiple_sources');
    }

    return {
      score: Math.min(100, score),
      factors,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'
    };
  }

  _assessDataQuality(games) {
    if (!games || games.length === 0) {
      return { score: 0, rating: 'poor', total_games: 0 };
    }

    const totalScore = games.reduce((sum, game) => sum + (game.data_quality?.score || 0), 0);
    const averageScore = totalScore / games.length;

    return {
      score: Math.round(averageScore),
      rating: averageScore >= 80 ? 'excellent' : averageScore >= 60 ? 'good' : averageScore >= 40 ? 'fair' : 'poor',
      total_games: games.length
    };
  }

  /**
   * Utility methods
   */
  _inferSportGroup(sportKey) {
    if (sportKey.includes('americanfootball')) return 'American Football';
    if (sportKey.includes('basketball')) return 'Basketball';
    if (sportKey.includes('baseball')) return 'Baseball';
    if (sportKey.includes('icehockey') || sportKey.includes('hockey')) return 'Hockey';
    if (sportKey.includes('soccer')) return 'Soccer';
    if (sportKey.includes('tennis')) return 'Tennis';
    if (sportKey.includes('mma') || sportKey.includes('ufc')) return 'Combat Sports';
    if (sportKey.includes('golf')) return 'Golf';
    return 'Other';
  }

  _hasOutrights(sportKey) {
    const hasOutrights = ['golf', 'tennis', 'mma', 'formula1', 'nascar'];
    return hasOutrights.some(sport => sportKey.includes(sport));
  }

  /**
   * Service health and status
   */
  async getServiceStatus() {
    const status = {
      service: 'OddsService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: {
        enabled: true,
        ttls: CACHE_TTL
      },
      providers: this.apiProviders.map(p => p.name),
      statistics: {}
    };

    try {
      const freshness = await this.getDataFreshness();
      status.freshness = freshness;
      
      // Test a popular sport
      const testGames = await this.getSportOdds('basketball_nba', { useCache: false });
      status.statistics.test_games = testGames.length;
      status.statistics.data_quality = this._assessDataQuality(testGames);

    } catch (error) {
      status.status = 'degraded';
      status.error = error.message;
    }

    return status;
  }
}

export default new OddsService();
