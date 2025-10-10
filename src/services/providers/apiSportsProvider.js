// src/services/providers/apiSportsProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout, TimeoutError } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

// --- CHANGE START ---
// Corrected all baseUrls to use the latest, verified API versions.
// This is the primary fix for all 'getaddrinfo ENOTFOUND' network errors.
const APISPORTS_CONFIG = {
  baseUrls: {
    football: 'https://v3.football.api-sports.io',
    basketball: 'https://v1.basketball.api-sports.io',
    baseball: 'https://v1.baseball.api-sports.io',
    hockey: 'https://v1.hockey.api-sports.io',
    american_football: 'https://v1.american-football.api-sports.io',
    rugby: 'https://v1.rugby.api-sports.io',
    mma: 'https://v1.mma.api-sports.io',
    boxing: 'https://v1.boxing.api-sports.io',
    f1: 'https://v1.formula-1.api-sports.io', // Corrected endpoint
    tennis: 'https://v1.tennis.api-sports.io',
    cricket: 'https://v1.cricket.api-sports.io',
    golf: 'https://v1.golf.api-sports.io'
  },
  // --- CHANGE END ---

  sportMappings: {
    'americanfootball_nfl': { category: 'american_football', leagueId: 1, name: 'NFL' },
    'americanfootball_ncaaf': { category: 'american_football', leagueId: 2, name: 'NCAAF' },
    'basketball_nba': { category: 'basketball', leagueId: 12, name: 'NBA' },
    'basketball_wnba': { category: 'basketball', leagueId: 13, name: 'WNBA' },
    'basketball_ncaab': { category: 'basketball', leagueId: 14, name: 'NCAAB' },
    'baseball_mlb': { category: 'baseball', leagueId: 1, name: 'MLB' },
    'icehockey_nhl': { category: 'hockey', leagueId: 1, name: 'NHL' },
    'soccer_england_premier_league': { category: 'football', leagueId: 39, name: 'Premier League' },
    'soccer_spain_la_liga': { category: 'football', leagueId: 140, name: 'La Liga' },
    'soccer_italy_serie_a': { category: 'football', leagueId: 135, name: 'Serie A' },
    'soccer_germany_bundesliga': { category: 'football', leagueId: 78, name: 'Bundesliga' },
    'soccer_france_ligue_1': { category: 'football', leagueId: 61, name: 'Ligue 1' },
    'soccer_uefa_champions_league': { category: 'football', leagueId: 2, name: 'Champions League' },
    'soccer_uefa_europa_league': { category: 'football', leagueId: 3, name: 'Europa League' },
    'soccer_mls': { category: 'football', leagueId: 253, name: 'MLS' },
    'tennis_atp': { category: 'tennis', leagueId: 1, name: 'ATP Tennis' },
    'tennis_wta': { category: 'tennis', leagueId: 2, name: 'WTA Tennis' },
    'mma_ufc': { category: 'mma', leagueId: 1, name: 'UFC' },
    'formula1': { category: 'f1', leagueId: 1, name: 'Formula 1' },
    'golf_pga': { category: 'golf', leagueId: 1, name: 'PGA Tour' }
  }
};

export class ApiSportsProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apisports';
    this.priority = 30;
  }

  async fetchSportOdds(sportKey, options = {}) {
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
      // --- CHANGE START ---
      // Corrected the headers to use 'x-apisports-key' as per the latest documentation
      // and removed the incorrect 'x-rapidapi-host'.
      const headers = {
        'x-apisports-key': this.apiKey,
      };
      // --- CHANGE END ---

      const games = await this._fetchGamesWithTimeout(baseUrl, sportKey, sportConfig, options, headers);
      
      console.log(`✅ ApiSportsProvider: Processed ${games.length} ${sportKey} games`);
      return games;

    } catch (error) {
      console.error(`❌ ApiSportsProvider failed for ${sportKey}:`, error.message);
      
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
    const currentYear = new Date().getFullYear();
    // --- CHANGE START ---
    // The endpoint for fixtures/games is different for some sports. This handles it.
    const endpoint = sportConfig.category === 'football' ? '/fixtures' : '/games';
    const url = `${baseUrl}${endpoint}`;
    // --- CHANGE END ---
    
    const response = await withTimeout(
      axios.get(url, {
        params: {
          season: currentYear,
          league: sportConfig.leagueId,
          date: new Date().toISOString().split('T')[0]
        },
        headers: headers
      }),
      10000,
      `apisports_${sportKey}_games`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);

    if (!response.data?.response || !Array.isArray(response.data.response)) {
      console.warn(`⚠️ ApiSportsProvider: No game data for ${sportKey}`);
      return [];
    }

    const games = response.data.response.slice(0, 15);
    const enhancedGames = [];

    for (const game of games) {
      try {
        // Correctly get the ID for different sport types
        const gameId = game.fixture?.id || game.game?.id || game.id;
        const odds = await this._fetchGameOdds(baseUrl, gameId, headers);
        const enhancedGame = this._transformGameData(game, odds, sportKey, sportConfig);
        if (enhancedGame) {
          enhancedGames.push(enhancedGame);
        }
      } catch (gameError) {
        console.warn(`⚠️ Failed to process ${sportKey} game ${game.fixture?.id || game.game?.id}:`, gameError.message);
        continue;
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
          // --- CHANGE START ---
          // The parameter for odds can be 'fixture' or 'game' depending on the sport.
          params: { fixture: gameId, game: gameId },
          // --- CHANGE END ---
          headers: headers
        }),
        8000,
        `apisports_odds_${gameId}`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);
      return response.data;

    } catch (error) {
      console.warn(`⚠️ Failed to fetch odds for game ${gameId}:`, error.message);
      return { response: [] };
    }
  }

  _transformGameData(apiGame, oddsData, sportKey, sportConfig) {
    const gameInfo = apiGame.fixture || apiGame.game || apiGame;
    if (!gameInfo?.id || !apiGame?.teams) {
      return null;
    }

    const bookmakers = this._extractBookmakers(oddsData);
    
    return {
      event_id: `apisports_${gameInfo.id}`,
      sport_key: sportKey,
      league_key: sportConfig.name,
      commence_time: gameInfo.date,
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
    if (!oddsData.response || !Array.isArray(oddsData.response) || oddsData.response.length === 0) {
      return [];
    }

    const bookmakers = [];
    const fixtureOdds = oddsData.response[0];
    
    if (!fixtureOdds.bookmakers || !Array.isArray(fixtureOdds.bookmakers)) return [];

    fixtureOdds.bookmakers.forEach(bookmaker => {
      const formattedBookmaker = {
        key: bookmaker.name?.toLowerCase().replace(/\s+/g, '_') || 'unknown',
        title: bookmaker.name || 'Unknown Bookmaker',
        last_update: new Date().toISOString(),
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

    return bookmakers;
  }

  _transformBetToMarket(bet) {
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
      last_update: new Date().toISOString(),
      outcomes: []
    };

    bet.values.forEach(value => {
      const outcome = {
        name: this._standardizeSelectionName(value.value, marketKey),
        price: this._convertToAmericanOdds(value.odd)
      };

      if (marketKey === 'spreads' || marketKey === 'totals') {
          const pointMatch = String(value.handicap || value.value).match(/[+-]?\d+\.?\d*/);
          if (pointMatch) {
              outcome.point = parseFloat(pointMatch[0]);
          }
      }

      market.outcomes.push(outcome);
    });

    return market.outcomes.length > 0 ? market : null;
  }

  _convertToAmericanOdds(decimalOdd) {
    if (!decimalOdd) return null;
    const numOdds = parseFloat(decimalOdd);
    if (isNaN(numOdds)) return null;

    if (numOdds >= 2.0) {
      return Math.round((numOdds - 1) * 100);
    } else {
      return Math.round(-100 / (numOdds - 1));
    }
  }

  _standardizeTeamName(teamName, sportKey) {
    if (!teamName) return 'Unknown Team';
    return teamName.trim();
  }

  _standardizeSelectionName(selection, marketKey) {
    if (!selection) return 'Unknown';
    if (selection === 'Home') return 'Home';
    if (selection === 'Away') return 'Away';
    if (typeof selection === 'string') {
      if (selection.toLowerCase().startsWith('over')) return 'Over';
      if (selection.toLowerCase().startsWith('under')) return 'Under';
    }
    return selection;
  }

  _assessGameDataQuality(gameData, bookmakers) {
    let score = 0;
    const factors = [];
    const gameInfo = gameData.fixture || gameData.game || gameData;

    if (gameData.teams) { score += 30; factors.push('valid_teams'); }
    if (gameInfo?.date) { score += 20; factors.push('start_time'); }
    if (bookmakers && bookmakers.length > 0) { score += 30; factors.push(`odds_from_${bookmakers.length}_books`); }
    if (bookmakers && bookmakers.length >= 2) { score += 20; factors.push('multiple_sources'); }

    const finalScore = Math.min(100, score);
    return {
      score: finalScore,
      factors,
      rating: finalScore >= 80 ? 'excellent' : finalScore >= 60 ? 'good' : finalScore >= 40 ? 'fair' : 'poor'
    };
  }

  async fetchAvailableSports() {
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
    try {
      const quota = await rateLimitService.getProviderQuota(this.name);
      
      const testUrl = `${APISPORTS_CONFIG.baseUrls.football}/status`;
      await withTimeout(
        axios.get(testUrl, { 
          headers: { 'x-apisports-key': this.apiKey }
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
        message: `API-Sports provider operational`
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
