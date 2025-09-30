// src/services/gamesService.js
// COMPLETE: Enhanced games service with comprehensive sports support

import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import env from '../config/env.js';
import { Redis } from 'ioredis';

// Redis client for caching
const redis = new Redis(env.REDIS_URL);

// Comprehensive sport mapping with all supported sports
const COMPREHENSIVE_SPORTS = {
  // American Football
  'americanfootball_nfl': { title: 'NFL', priority: 1, emoji: '🏈' },
  'americanfootball_ncaaf': { title: 'NCAAF', priority: 2, emoji: '🏈' },
  'americanfootball_xfl': { title: 'XFL', priority: 50, emoji: '🏈' },
  'americanfootball_usfl': { title: 'USFL', priority: 51, emoji: '🏈' },
  
  // Basketball
  'basketball_nba': { title: 'NBA', priority: 3, emoji: '🏀' },
  'basketball_wnba': { title: 'WNBA', priority: 30, emoji: '🏀' },
  'basketball_ncaab': { title: 'NCAAB', priority: 4, emoji: '🏀' },
  'basketball_euroleague': { title: 'EuroLeague', priority: 60, emoji: '🏀' },
  
  // Baseball
  'baseball_mlb': { title: 'MLB', priority: 5, emoji: '⚾' },
  'baseball_npb': { title: 'NPB (Japan)', priority: 40, emoji: '⚾' },
  'baseball_kbo': { title: 'KBO (Korea)', priority: 41, emoji: '⚾' },
  
  // Hockey
  'icehockey_nhl': { title: 'NHL', priority: 6, emoji: '🏒' },
  'icehockey_khl': { title: 'KHL', priority: 45, emoji: '🏒' },
  'icehockey_sweden': { title: 'Swedish Hockey', priority: 46, emoji: '🏒' },
  'icehockey_finland': { title: 'Finnish Hockey', priority: 47, emoji: '🏒' },
  
  // Soccer
  'soccer_england_premier_league': { title: 'Premier League', priority: 7, emoji: '⚽' },
  'soccer_spain_la_liga': { title: 'La Liga', priority: 8, emoji: '⚽' },
  'soccer_italy_serie_a': { title: 'Serie A', priority: 9, emoji: '⚽' },
  'soccer_germany_bundesliga': { title: 'Bundesliga', priority: 10, emoji: '⚽' },
  'soccer_france_ligue_1': { title: 'Ligue 1', priority: 11, emoji: '⚽' },
  'soccer_uefa_champions_league': { title: 'Champions League', priority: 12, emoji: '⚽' },
  'soccer_uefa_europa_league': { title: 'Europa League', priority: 25, emoji: '⚽' },
  'soccer_mls': { title: 'MLS', priority: 26, emoji: '⚽' },
  'soccer_world_cup': { title: 'World Cup', priority: 70, emoji: '⚽' },
  'soccer_euro': { title: 'European Championship', priority: 71, emoji: '⚽' },
  'soccer_copa_america': { title: 'Copa America', priority: 72, emoji: '⚽' },
  
  // Tennis
  'tennis_atp': { title: 'ATP Tennis', priority: 20, emoji: '🎾' },
  'tennis_wta': { title: 'WTA Tennis', priority: 21, emoji: '🎾' },
  'tennis_aus_open': { title: 'Australian Open', priority: 75, emoji: '🎾' },
  'tennis_french_open': { title: 'French Open', priority: 76, emoji: '🎾' },
  'tennis_wimbledon': { title: 'Wimbledon', priority: 77, emoji: '🎾' },
  'tennis_us_open': { title: 'US Open', priority: 78, emoji: '🎾' },
  
  // Fighting Sports
  'mma_ufc': { title: 'UFC', priority: 15, emoji: '🥊' },
  'boxing': { title: 'Boxing', priority: 35, emoji: '🥊' },
  
  // Motorsports
  'formula1': { title: 'Formula 1', priority: 16, emoji: '🏎️' },
  'motogp': { title: 'MotoGP', priority: 55, emoji: '🏍️' },
  'nascar': { title: 'NASCAR', priority: 56, emoji: '🏁' },
  'indycar': { title: 'IndyCar', priority: 57, emoji: '🏎️' },
  
  // Golf
  'golf_pga': { title: 'PGA Tour', priority: 17, emoji: '⛳' },
  'golf_european': { title: 'European Tour', priority: 58, emoji: '⛳' },
  'golf_liv': { title: 'LIV Golf', priority: 59, emoji: '⛳' },
  'golf_masters': { title: 'The Masters', priority: 80, emoji: '⛳' },
  'golf_us_open': { title: 'US Open', priority: 81, emoji: '⛳' },
  'golf_pga_championship': { title: 'PGA Championship', priority: 82, emoji: '⛳' },
  'golf_open_championship': { title: 'The Open', priority: 83, emoji: '⛳' },
  
  // International Sports
  'cricket_ipl': { title: 'IPL Cricket', priority: 65, emoji: '🏏' },
  'cricket_big_bash': { title: 'Big Bash', priority: 66, emoji: '🏏' },
  'cricket_psl': { title: 'PSL Cricket', priority: 67, emoji: '🏏' },
  'rugby_union': { title: 'Rugby Union', priority: 42, emoji: '🏉' },
  'rugby_league': { title: 'Rugby League', priority: 43, emoji: '🏉' },
  'aussie_rules_afl': { title: 'AFL', priority: 44, emoji: '🇦🇺' },
  'handball': { title: 'Handball', priority: 85, emoji: '🤾' },
  'volleyball': { title: 'Volleyball', priority: 86, emoji: '🏐' },
  'table_tennis': { title: 'Table Tennis', priority: 87, emoji: '🏓' },
  'badminton': { title: 'Badminton', priority: 88, emoji: '🏸' },
  'darts': { title: 'Darts', priority: 89, emoji: '🎯' },
  'snooker': { title: 'Snooker', priority: 90, emoji: '🎱' }
};

// Cache configuration
const CACHE_TTL = {
  SPORTS_LIST: 300, // 5 minutes
  GAMES_DATA: 120,  // 2 minutes
  ODDS_DATA: 60     // 1 minute
};

class GamesService {
  constructor() {
    this.lastRefreshTimes = new Map();
    this.availableSportsCache = null;
    this.availableSportsCacheTime = null;
  }

  // ========== CORE METHODS ==========

  /**
   * Get all available sports from multiple sources
   */
  async getAvailableSports() {
    const cacheKey = 'available_sports_comprehensive';
    
    try {
      // Try cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('📦 Using cached sports list');
        return JSON.parse(cached);
      }

      console.log('🔄 Building comprehensive sports list...');
      
      let sports = [];
      
      // Source 1: Odds API (primary)
      try {
        const oddsSports = await this._getSportsFromOddsAPI();
        sports = [...sports, ...oddsSports];
        console.log(`✅ Added ${oddsSports.length} sports from Odds API`);
      } catch (error) {
        console.warn('❌ Odds API sports fetch failed:', error.message);
      }

      // Source 2: Database (secondary)
      try {
        const dbSports = await this._getSportsFromDatabase();
        sports = [...sports, ...dbSports];
        console.log(`✅ Added ${dbSports.length} sports from database`);
      } catch (error) {
        console.warn('❌ Database sports fetch failed:', error.message);
      }

      // Source 3: Comprehensive mapping (fallback)
      const mappedSports = this._getSportsFromMapping();
      sports = [...sports, ...mappedSports];
      console.log(`✅ Added ${mappedSports.length} sports from comprehensive mapping`);

      // Deduplicate and enhance
      const enhancedSports = this._enhanceAndDeduplicateSports(sports);
      console.log(`🎉 Final sports list: ${enhancedSports.length} sports`);

      // Cache the result
      await redis.setex(cacheKey, CACHE_TTL.SPORTS_LIST, JSON.stringify(enhancedSports));
      
      return enhancedSports;

    } catch (error) {
      console.error('❌ Comprehensive sports fetch failed:', error);
      // Return fallback from mapping
      return Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
        sport_key,
        sport_title: data.title,
        priority: data.priority,
        emoji: data.emoji,
        source: 'comprehensive_fallback'
      })).sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Get games for a specific sport with comprehensive data
   */
  async getGamesForSport(sportKey, options = {}) {
    const {
      includeOdds = true,
      includeLive = false,
      hoursAhead = 72,
      useCache = true
    } = options;

    const cacheKey = `games_${sportKey}_${hoursAhead}_${includeOdds}_${includeLive}`;

    try {
      // Try cache first if enabled
      if (useCache) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          console.log(`📦 Using cached games for ${sportKey}`);
          return JSON.parse(cached);
        }
      }

      console.log(`🔄 Fetching games for ${sportKey}...`);

      let games = [];
      let source = 'unknown';

      // Try Odds API first (most current data)
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

      // Fallback to database if no games found
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

      // Enhance games with additional data
      const enhancedGames = await this._enhanceGamesData(games, sportKey, source);
      
      // Update last refresh time
      this.lastRefreshTimes.set(sportKey, new Date().toISOString());

      // Cache the result
      if (useCache && enhancedGames.length > 0) {
        await redis.setex(cacheKey, CACHE_TTL.GAMES_DATA, JSON.stringify(enhancedGames));
      }

      return enhancedGames;

    } catch (error) {
      console.error(`❌ Games fetch failed for ${sportKey}:`, error);
      return [];
    }
  }

  /**
   * Get live/upcoming games with real-time odds
   */
  async getLiveGames(sportKey, options = {}) {
    const {
      includeOdds = true,
      hoursAhead = 24, // Shorter window for "live"
      maxGames = 50
    } = options;

    try {
      const games = await this.getGamesForSport(sportKey, {
        includeOdds,
        includeLive: true,
        hoursAhead,
        useCache: false // Don't cache live data
      });

      // Filter for games happening soon or live
      const now = new Date();
      const soon = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      const liveGames = games
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
   * Search games by team or tournament name
   */
  async searchGames(query, sportKey = null) {
    try {
      console.log(`🔍 Searching games for: "${query}"${sportKey ? ` in ${sportKey}` : ''}`);
      
      let allGames = [];
      
      if (sportKey) {
        // Search in specific sport
        allGames = await this.getGamesForSport(sportKey, { useCache: false });
      } else {
        // Search across major sports
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

  /**
   * Get data freshness information
   */
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

      // Check Odds API status
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

      // Check database status
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

      // Sport-specific freshness
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

  // ========== PRIVATE METHODS ==========

  /**
   * Get sports from Odds API
   */
  async _getSportsFromOddsAPI() {
    try {
      const sports = await oddsService.getAvailableSports();
      if (!sports || !Array.isArray(sports)) {
        throw new Error('Invalid response from Odds API');
      }

      return sports.map(sport => ({
        sport_key: sport.key,
        sport_title: sport.title || sport.description || sport.key,
        group: sport.group,
        description: sport.description,
        active: sport.active !== false,
        has_outrights: sport.has_outrights || false,
        source: 'odds_api',
        priority: this._calculateSportPriority(sport.key)
      }));

    } catch (error) {
      console.warn('❌ Odds API sports fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Get sports from database
   */
  async _getSportsFromDatabase() {
    try {
      const sports = await databaseService.getDistinctSports();
      if (!sports || !Array.isArray(sports)) {
        throw new Error('Invalid response from database');
      }

      return sports.map(sport => ({
        sport_key: sport.sport_key,
        sport_title: sport.sport_title || sport.sport_key,
        game_count: sport.game_count || 0,
        last_updated: sport.last_updated,
        source: 'database',
        priority: this._calculateSportPriority(sport.sport_key)
      }));

    } catch (error) {
      console.warn('❌ Database sports fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Get sports from comprehensive mapping
   */
  _getSportsFromMapping() {
    return Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
      sport_key,
      sport_title: data.title,
      emoji: data.emoji,
      priority: data.priority,
      source: 'comprehensive_mapping'
    }));
  }

  /**
   * Enhance and deduplicate sports list
   */
  _enhanceAndDeduplicateSports(sports) {
    const seen = new Map();
    const enhanced = [];

    for (const sport of sports) {
      if (!sport.sport_key) continue;

      const key = sport.sport_key;
      const existing = seen.get(key);

      if (!existing) {
        // New sport - enhance with comprehensive data
        const comprehensiveData = COMPREHENSIVE_SPORTS[key];
        const enhancedSport = {
          sport_key: key,
          sport_title: sport.sport_title || comprehensiveData?.title || key,
          emoji: comprehensiveData?.emoji || '🏆',
          priority: sport.priority || comprehensiveData?.priority || 100,
          group: sport.group,
          description: sport.description,
          active: sport.active !== false,
          has_outrights: sport.has_outrights || false,
          game_count: sport.game_count || 0,
          last_updated: sport.last_updated,
          source: sport.source || 'unknown',
          // Additional metadata
          is_major: (sport.priority || 100) <= 20,
          is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(key)
        };

        seen.set(key, enhancedSport);
        enhanced.push(enhancedSport);
      } else {
        // Update existing with better data if available
        if (sport.source === 'odds_api' && existing.source !== 'odds_api') {
          Object.assign(existing, sport);
          existing.source = 'odds_api';
        }
        if (sport.game_count && (!existing.game_count || sport.game_count > existing.game_count)) {
          existing.game_count = sport.game_count;
        }
      }
    }

    // Sort by priority (lower = better)
    return enhanced.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  /**
   * Enhance games data with additional information
   */
  async _enhanceGamesData(games, sportKey, source) {
    if (!games || !Array.isArray(games)) return [];

    return games.map(game => ({
      // Core game data
      id: game.id || `${sportKey}_${game.commence_time}_${game.home_team}_${game.away_team}`.replace(/\s+/g, '_'),
      sport_key: sportKey,
      sport_title: COMPREHENSIVE_SPORTS[sportKey]?.title || sportKey,
      commence_time: game.commence_time,
      home_team: game.home_team,
      away_team: game.away_team,
      
      // Enhanced data
      home_team_clean: this._cleanTeamName(game.home_team),
      away_team_clean: this._cleanTeamName(game.away_team),
      tournament: game.tournament || this._inferTournament(sportKey, game),
      venue: game.venue,
      
      // Odds data
      bookmakers: game.bookmakers || [],
      odds_available: !!(game.bookmakers && game.bookmakers.length > 0),
      best_odds: this._extractBestOdds(game),
      
      // Status and metadata
      game_status: game.game_status || 'upcoming',
      source: source,
      last_updated: game.last_updated || new Date().toISOString(),
      data_quality: this._assessDataQuality(game),
      
      // AI analysis enhancements
      analysis_ready: this._isGameReadyForAnalysis(game),
      market_variety: this._countMarkets(game),
      
      // Display helpers
      display_name: `${game.away_team} @ ${game.home_team}`,
      short_name: `${this._abbreviateTeam(game.away_team)} @ ${this._abbreviateTeam(game.home_team)}`,
      time_until: this._calculateTimeUntil(game.commence_time)
    }));
  }

  /**
   * Calculate sport priority for sorting
   */
  _calculateSportPriority(sportKey) {
    const sportData = COMPREHENSIVE_SPORTS[sportKey];
    if (sportData) return sportData.priority;

    // Default priorities based on sport type
    if (sportKey.includes('americanfootball')) return 10;
    if (sportKey.includes('basketball')) return 15;
    if (sportKey.includes('baseball')) return 20;
    if (sportKey.includes('icehockey')) return 25;
    if (sportKey.includes('soccer')) return 30;
    if (sportKey.includes('tennis')) return 40;
    if (sportKey.includes('mma')) return 45;
    if (sportKey.includes('golf')) return 50;
    if (sportKey.includes('formula1')) return 55;
    
    return 100; // Default low priority for unknown sports
  }

  /**
   * Clean team names for consistency
   */
  _cleanTeamName(teamName) {
    if (!teamName) return '';
    
    return teamName
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\./, '') // Remove leading dots
      .replace(/\.$/, ''); // Remove trailing dots
  }

  /**
   * Infer tournament name from sport and teams
   */
  _inferTournament(sportKey, game) {
    const sport = COMPREHENSIVE_SPORTS[sportKey];
    if (!sport) return sportKey.replace(/_/g, ' ').toUpperCase();

    if (sportKey.includes('nfl')) return 'NFL';
    if (sportKey.includes('nba')) return 'NBA';
    if (sportKey.includes('mlb')) return 'MLB';
    if (sportKey.includes('nhl')) return 'NHL';
    if (sportKey.includes('premier_league')) return 'Premier League';
    if (sportKey.includes('champions_league')) return 'Champions League';
    
    return sport.title;
  }

  /**
   * Extract best odds from game data
   */
  _extractBestOdds(game) {
    if (!game.bookmakers || game.bookmakers.length === 0) return null;

    const bestOdds = {
      moneyline: { home: null, away: null },
      spread: { home: null, away: null },
      total: { over: null, under: null }
    };

    game.bookmakers.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        if (market.key === 'h2h' && market.outcomes) {
          market.outcomes.forEach(outcome => {
            const current = bestOdds.moneyline[outcome.name === game.home_team ? 'home' : 'away'];
            if (!current || outcome.price > current.price) {
              bestOdds.moneyline[outcome.name === game.home_team ? 'home' : 'away'] = {
                price: outcome.price,
                bookmaker: bookmaker.title
              };
            }
          });
        }
      });
    });

    return bestOdds;
  }

  /**
   * Assess data quality for a game
   */
  _assessDataQuality(game) {
    let score = 0;
    let factors = [];

    if (game.home_team && game.away_team) {
      score += 30;
      factors.push('teams_available');
    }

    if (game.commence_time) {
      score += 20;
      factors.push('start_time_available');
    }

    if (game.bookmakers && game.bookmakers.length > 0) {
      score += 30;
      factors.push(`odds_available_${game.bookmakers.length}_books`);
    }

    if (game.bookmakers && game.bookmakers.length >= 3) {
      score += 20;
      factors.push('multiple_books');
    }

    return {
      score: Math.min(100, score),
      factors,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'
    };
  }

  /**
   * Check if game is ready for AI analysis
   */
  _isGameReadyForAnalysis(game) {
    return game.home_team && 
           game.away_team && 
           game.commence_time && 
           game.bookmakers && 
           game.bookmakers.length >= 2;
  }

  /**
   * Count available markets
   */
  _countMarkets(game) {
    if (!game.bookmakers) return 0;
    
    const markets = new Set();
    game.bookmakers.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        markets.add(market.key);
      });
    });
    
    return markets.size;
  }

  /**
   * Abbreviate team name for display
   */
  _abbreviateTeam(teamName) {
    if (!teamName) return '';
    
    // Common team abbreviations
    const abbreviations = {
      'san francisco': 'SF',
      'los angeles': 'LA',
      'new york': 'NY',
      'chicago': 'CHI',
      'boston': 'BOS',
      'philadelphia': 'PHI',
      'dallas': 'DAL',
      'miami': 'MIA',
      'atlanta': 'ATL',
      'houston': 'HOU',
      'detroit': 'DET',
      'phoenix': 'PHX',
      'seattle': 'SEA',
      'minnesota': 'MIN',
      'denver': 'DEN',
      'cleveland': 'CLE',
      'tampa bay': 'TB',
      'carolina': 'CAR',
      'new england': 'NE',
      'green bay': 'GB'
    };

    const lowerName = teamName.toLowerCase();
    for (const [full, abbr] of Object.entries(abbreviations)) {
      if (lowerName.includes(full)) {
        return abbr;
      }
    }

    // Return first 3 characters if no abbreviation found
    return teamName.substring(0, 3).toUpperCase();
  }

  /**
   * Calculate time until game starts
   */
  _calculateTimeUntil(commenceTime) {
    if (!commenceTime) return null;
    
    const now = new Date();
    const gameTime = new Date(commenceTime);
    const diffMs = gameTime - now;
    
    if (diffMs < 0) return 'started';
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
    if (diffHours > 0) return `${diffHours}h`;
    
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return `${diffMinutes}m`;
  }

  // ========== UTILITY METHODS ==========

  /**
   * Clear cache for specific sport or all sports
   */
  async clearCache(sportKey = null) {
    try {
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
      
      this.availableSportsCache = null;
      this.availableSportsCacheTime = null;
      this.lastRefreshTimes.clear();
      
      return true;
    } catch (error) {
      console.error('❌ Cache clearance failed:', error);
      return false;
    }
  }

  /**
   * Get service status and health
   */
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
        total_sports_supported: Object.keys(COMPREHENSIVE_SPORTS).length,
        last_cache_clearance: await this._getLastCacheClearance(),
        memory_usage: process.memoryUsage()
      }
    };

    // Test each data source
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

  async _getLastCacheClearance() {
    try {
      const info = await redis.info('persistence');
      const lines = info.split('\n');
      const lastSaveLine = lines.find(line => line.startsWith('rdb_last_save_time'));
      if (lastSaveLine) {
        const timestamp = parseInt(lastSaveLine.split(':')[1]);
        return new Date(timestamp * 1000).toISOString();
      }
    } catch (error) {
      // Ignore errors
    }
    return 'unknown';
  }

  /**
   * Preload cache for popular sports
   */
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

// Create and export singleton instance
const gamesService = new GamesService();
export default gamesService;
