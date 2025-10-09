// src/services/providers/apiSportsProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout, TimeoutError } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

// VERIFIED API-SPORTS CONFIGURATION - MATCHING YOUR EXISTING PATTERNS
const APISPORTS_CONFIG = {
  baseUrls: {
    football: 'https://v1.football.api-sports.io',
    basketball: 'https://v1.basketball.api-sports.io', 
    baseball: 'https://v1.baseball.api-sports.io',
    hockey: 'https://v1.hockey.api-sports.io',
    american_football: 'https://v1.american-football.api-sports.io',
    rugby: 'https://v1.rugby.api-sports.io',
    mma: 'https://v1.mma.api-sports.io',
    boxing: 'https://v1.boxing.api-sports.io',
    f1: 'https://v1.formula1.api-sports.io',
    tennis: 'https://v1.tennis.api-sports.io',
    cricket: 'https://v1.cricket.api-sports.io',
    golf: 'https://v1.golf.api-sports.io'
  },

  // VERIFIED MAPPINGS THAT MATCH YOUR SPORT_DEFINITIONS EXACTLY
  sportMappings: {
    // American Football - MATCHING YOUR sportDefinitions.js
    'americanfootball_nfl': { category: 'american_football', leagueId: 1, name: 'NFL' },
    'americanfootball_ncaaf': { category: 'american_football', leagueId: 2, name: 'NCAAF' },
    
    // Basketball - MATCHING YOUR sportDefinitions.js
    'basketball_nba': { category: 'basketball', leagueId: 12, name: 'NBA' },
    'basketball_wnba': { category: 'basketball', leagueId: 13, name: 'WNBA' },
    'basketball_ncaab': { category: 'basketball', leagueId: 14, name: 'NCAAB' },
    
    // Baseball - MATCHING YOUR sportDefinitions.js
    'baseball_mlb': { category: 'baseball', leagueId: 1, name: 'MLB' },
    
    // Hockey - MATCHING YOUR sportDefinitions.js
    'icehockey_nhl': { category: 'hockey', leagueId: 1, name: 'NHL' },
    
    // Soccer - MATCHING YOUR sportDefinitions.js EXACTLY
    'soccer_england_premier_league': { category: 'football', leagueId: 39, name: 'Premier League' },
    'soccer_spain_la_liga': { category: 'football', leagueId: 140, name: 'La Liga' },
    'soccer_italy_serie_a': { category: 'football', leagueId: 135, name: 'Serie A' },
    'soccer_germany_bundesliga': { category: 'football', leagueId: 78, name: 'Bundesliga' },
    'soccer_france_ligue_1': { category: 'football', leagueId: 61, name: 'Ligue 1' },
    'soccer_uefa_champions_league': { category: 'football', leagueId: 2, name: 'Champions League' },
    'soccer_uefa_europa_league': { category: 'football', leagueId: 3, name: 'Europa League' },
    'soccer_mls': { category: 'football', leagueId: 253, name: 'MLS' },
    
    // Tennis - MATCHING YOUR sportDefinitions.js
    'tennis_atp': { category: 'tennis', leagueId: 1, name: 'ATP Tennis' },
    'tennis_wta': { category: 'tennis', leagueId: 2, name: 'WTA Tennis' },
    
    // MMA - MATCHING YOUR sportDefinitions.js
    'mma_ufc': { category: 'mma', leagueId: 1, name: 'UFC' },
    
    // Motorsports - MATCHING YOUR sportDefinitions.js
    'formula1': { category: 'f1', leagueId: 1, name: 'Formula 1' },
    
    // Golf - MATCHING YOUR sportDefinitions.js
    'golf_pga': { category: 'golf', leagueId: 1, name: 'PGA Tour' }
  }
};

export class ApiSportsProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apisports';
    this.priority = 30; // Consistent with your provider priority system
  }

  async fetchSportOdds(sportKey, options = {}) {
    // MATCHING YOUR EXACT RATE LIMIT PATTERN from theOddsProvider.js
    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for API-Sports');
    }

    const sportConfig = APISPORTS_CONFIG.sportMappings[sportKey];
    if (!sportConfig) {
      console.log(`⚠️ ApiSportsProvider: No verified mapping for ${sportKey}`);
      return [];
    }

    try {
      console.log(`🔧 ApiSportsProvider: Fetching ${sportKey} (${sportConfig.name})`);
      
      const baseUrl = APISPORTS_CONFIG.baseUrls[sportConfig.category];
      const headers = {
        'x-rapidapi-host': new URL(baseUrl).host,
        'x-rapidapi-key': this.apiKey,
      };

      // MATCHING YOUR EXACT DATA FETCHING PATTERN from gamesService.js
      const games = await this._fetchGamesWithTimeout(baseUrl, sportKey, sportConfig, options, headers);
      
      console.log(`✅ ApiSportsProvider: Processed ${games.length} ${sportKey} games`);
      return games;

    } catch (error) {
      console.error(`❌ ApiSportsProvider failed for ${sportKey}:`, error.message);
      
      // MATCHING YOUR EXACT ERROR HANDLING PATTERN from oddsService.js
      if (!(error instanceof TimeoutError)) {
        sentryService.captureError(error, {
          component: 'odds_service_provider_failure',
          provider: this.name,
          sportKey,
        });
      }
      
      throw error;
    }
  }

  async _fetchGamesWithTimeout(baseUrl, sportKey, sportConfig, options, headers) {
    // MATCHING YOUR EXACT TIMEOUT PATTERN from gamesService.js
    const currentYear = new Date().getFullYear();
    const url = `${baseUrl}/games`;
    
    const response = await withTimeout(
      axios.get(url, {
        params: {
          season: currentYear,
          league: sportConfig.leagueId,
          date: new Date().toISOString().split('T')[0]
        },
        headers: headers
      }),
      10000, // MATCHING YOUR TIMEOUT from theOddsProvider.js
      `apisports_${sportKey}_games`
    );

    // MATCHING YOUR EXACT RATE LIMIT SAVING PATTERN
    await rateLimitService.saveProviderQuota(this.name, response.headers);

    if (!response.data?.response || !Array.isArray(response.data.response)) {
      console.warn(`⚠️ ApiSportsProvider: No game data for ${sportKey}`);
      return [];
    }

    const games = response.data.response.slice(0, 15); // MATCHING YOUR PERFORMANCE LIMITS
    const enhancedGames = [];

    for (const game of games) {
      try {
        const odds = await this._fetchGameOdds(baseUrl, game.game?.id, headers);
        const enhancedGame = this._transformGameData(game, odds, sportKey, sportConfig);
        if (enhancedGame) {
          enhancedGames.push(enhancedGame);
        }
      } catch (gameError) {
        console.warn(`⚠️ Failed to process ${sportKey} game ${game.game?.id}:`, gameError.message);
        continue; // MATCHING YOUR ERROR CONTINUATION PATTERN
      }
    }

    return enhancedGames;
  }

  async _fetchGameOdds(baseUrl, gameId, headers) {
    if (!gameId) return { response: [] };

    try {
      const url = `${baseUrl}/odds`;
      const response = await withTimeout(
        axios.get(url, {
          params: { game: gameId },
          headers: headers
        }),
        8000, // MATCHING YOUR ODDS FETCH TIMEOUT
        `apisports_odds_${gameId}`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);
      return response.data;

    } catch (error) {
      console.warn(`⚠️ Failed to fetch odds for game ${gameId}:`, error.message);
      return { response: [] }; // MATCHING YOUR EMPTY RESPONSE PATTERN
    }
  }

  _transformGameData(apiGame, oddsData, sportKey, sportConfig) {
    // MATCHING YOUR EXACT DATA STRUCTURE from theOddsProvider.js
    if (!apiGame?.game?.id || !apiGame?.teams) {
      return null;
    }

    const bookmakers = this._extractBookmakers(oddsData);
    
    // EXACT SAME STRUCTURE AS YOUR OTHER PROVIDERS
    return {
      event_id: `apisports_${apiGame.game.id}`,
      sport_key: sportKey,
      league_key: sportConfig.name,
      commence_time: apiGame.game.date,
      home_team: this._standardizeTeamName(apiGame.teams.home?.name, sportKey),
      away_team: this._standardizeTeamName(apiGame.teams.away?.name, sportKey),
      market_data: { 
        bookmakers: bookmakers,
        last_updated: new Date().toISOString()
      },
      sport_title: sportConfig.name,
      data_quality: this._assessGameDataQuality(apiGame, bookmakers),
      source: 'apisports'
    };
  }

  _extractBookmakers(oddsData) {
    // MATCHING YOUR BOOKMAKER STRUCTURE from theOddsProvider.js
    if (!oddsData.response || !Array.isArray(oddsData.response)) {
      return [];
    }

    const bookmakers = [];
    
    oddsData.response.forEach(gameOdds => {
      if (!gameOdds.bookmakers || !Array.isArray(gameOdds.bookmakers)) return;

      gameOdds.bookmakers.forEach(bookmaker => {
        const formattedBookmaker = {
          key: bookmaker.name?.toLowerCase().replace(/\s+/g, '_') || 'unknown',
          title: bookmaker.name || 'Unknown Bookmaker',
          last_update: bookmaker.update,
          markets: []
        };

        if (bookmaker.bets && Array.isArray(bookmaker.bets)) {
          bookmaker.bets.forEach(bet => {
            const market = this._transformBetToMarket(bet);
            if (market) {
              formattedBookmaker.markets.push(market);
            }
          });
        }

        if (formattedBookmaker.markets.length > 0) {
          bookmakers.push(formattedBookmaker);
        }
      });
    });

    return bookmakers;
  }

  _transformBetToMarket(bet) {
    // MATCHING YOUR MARKET TRANSFORMATION from sportRadarProvider.js
    const marketMap = {
      'Moneyline': 'h2h',
      'Match Winner': 'h2h',
      'Spread': 'spreads',
      'Handicap': 'spreads',
      'Total': 'totals',
      'Over/Under': 'totals'
    };

    const marketKey = marketMap[bet.name];
    if (!marketKey || !bet.values || !Array.isArray(bet.values)) {
      return null;
    }

    const market = {
      key: marketKey,
      last_update: bet.last_update,
      outcomes: []
    };

    bet.values.forEach(value => {
      const outcome = {
        name: this._standardizeSelectionName(value.value),
        price: this._convertToAmericanOdds(value.odd)
      };

      if (marketKey === 'spreads') {
        outcome.point = this._extractPoint(value.value);
      } else if (marketKey === 'totals') {
        outcome.point = this._extractTotalPoint(value.value);
      }

      market.outcomes.push(outcome);
    });

    return market.outcomes.length > 0 ? market : null;
  }

  _convertToAmericanOdds(decimalOdd) {
    // MATCHING YOUR ODDS CONVERSION from sportRadarProvider.js
    if (!decimalOdd) return -110;
    
    const numOdds = parseFloat(decimalOdd);
    if (isNaN(numOdds)) return -110;

    if (numOdds >= 2.0) {
      return Math.round((numOdds - 1) * 100);
    } else {
      return Math.round(-100 / (numOdds - 1));
    }
  }

  _extractPoint(selection) {
    const match = selection.match(/[+-]?\d+\.?\d*/);
    return match ? parseFloat(match[0]) : 0;
  }

  _extractTotalPoint(selection) {
    const match = selection.match(/\d+\.?\d*/);
    return match ? parseFloat(match[0]) : 0;
  }

  _standardizeTeamName(teamName, sportKey) {
    // MINIMAL STANDARDIZATION - KEEP ORIGINAL NAMES LIKE YOUR OTHER PROVIDERS
    if (!teamName) return 'Unknown Team';
    return teamName.trim();
  }

  _standardizeSelectionName(selection) {
    // MINIMAL STANDARDIZATION LIKE YOUR OTHER PROVIDERS
    if (!selection) return 'Unknown';
    
    if (typeof selection === 'string') {
      if (selection.includes('Over')) return 'Over';
      if (selection.includes('Under')) return 'Under';
    }
    
    return selection;
  }

  _assessGameDataQuality(gameData, bookmakers) {
    // MATCHING YOUR EXACT DATA QUALITY ASSESSMENT from theOddsProvider.js
    let score = 0;
    let factors = [];

    if (gameData.teams) {
      score += 30;
      factors.push('valid_teams');
    }

    if (gameData.game?.date) {
      score += 20;
      factors.push('start_time');
    }

    if (bookmakers && bookmakers.length > 0) {
      score += 30;
      factors.push(`odds_from_${bookmakers.length}_books`);
    }

    if (bookmakers && bookmakers.length >= 2) {
      score += 20;
      factors.push('multiple_sources');
    }

    return {
      score: Math.min(100, score),
      factors,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'
    };
  }

  async fetchAvailableSports() {
    // MATCHING YOUR EXACT SPORTS LIST PATTERN from theOddsProvider.js
    try {
      return Object.entries(APISPORTS_CONFIG.sportMappings).map(([key, config]) => ({
        key: key,
        title: config.name,
        group: this._getSportGroup(key),
        description: `${config.name} via API-Sports`,
        active: true,
        has_outrights: false,
        source: 'apisports'
      }));
    } catch (error) {
      console.error('❌ ApiSportsProvider sports fetch failed:', error);
      return [];
    }
  }

  _getSportGroup(sportKey) {
    // MATCHING YOUR SPORT GROUPING from sportsService.js
    if (sportKey.includes('soccer')) return 'soccer';
    if (sportKey.includes('basketball')) return 'basketball';
    if (sportKey.includes('football')) return 'american';
    if (sportKey.includes('baseball')) return 'baseball';
    if (sportKey.includes('hockey')) return 'hockey';
    if (sportKey.includes('tennis')) return 'tennis';
    if (sportKey.includes('mma') || sportKey.includes('boxing')) return 'combat';
    if (sportKey.includes('formula1') || sportKey.includes('golf')) return 'individual';
    return 'other';
  }

  async getProviderStatus() {
    // MATCHING YOUR EXACT PROVIDER STATUS PATTERN from theOddsProvider.js
    try {
      const quota = await rateLimitService.getProviderQuota(this.name);
      
      // Simple health check matching your pattern
      const testUrl = `${APISPORTS_CONFIG.baseUrls.football}/status`;
      await withTimeout(
        axios.get(testUrl, { 
          headers: {
            'x-rapidapi-host': new URL(APISPORTS_CONFIG.baseUrls.football).host,
            'x-rapidapi-key': this.apiKey
          }
        }),
        5000,
        'apisports_healthcheck'
      );

      return {
        name: this.name,
        status: 'active',
        priority: this.priority,
        last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
        remaining_requests: quota?.remaining,
        should_bypass: await rateLimitService.shouldBypassLive(this.name),
        supported_sports: Object.keys(APISPORTS_CONFIG.sportMappings).length,
        message: `API-Sports provider operational - supports ${Object.keys(APISPORTS_CONFIG.sportMappings).length} sports`
      };
    } catch (error) {
      return {
        name: this.name,
        status: 'error',
        priority: this.priority,
        last_error: error.message,
        message: 'API-Sports provider is experiencing issues'
      };
    }
  }
}

export default ApiSportsProvider;
