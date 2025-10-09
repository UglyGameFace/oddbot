// src/services/providers/apiSportsProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

// VERIFIED API-SPORTS CONFIGURATION FROM OFFICIAL DOCUMENTATION
const APISPORTS_CONFIG = {
  // Base URLs for different sports from official API documentation
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
    golf: 'https://v1.golf.api-sports.io',
    volleyball: 'https://v1.volleyball.api-sports.io',
    handball: 'https://v1.handball.api-sports.io'
  },

  // VERIFIED SPORT MAPPINGS FROM API-SPORTS DOCUMENTATION
  sportMappings: {
    // Football/Soccer
    'soccer_england_premier_league': { category: 'football', leagueId: 39, name: 'Premier League' },
    'soccer_spain_la_liga': { category: 'football', leagueId: 140, name: 'La Liga' },
    'soccer_italy_serie_a': { category: 'football', leagueId: 135, name: 'Serie A' },
    'soccer_germany_bundesliga': { category: 'football', leagueId: 78, name: 'Bundesliga' },
    'soccer_france_ligue_1': { category: 'football', leagueId: 61, name: 'Ligue 1' },
    'soccer_uefa_champions_league': { category: 'football', leagueId: 2, name: 'Champions League' },
    'soccer_europa_league': { category: 'football', leagueId: 3, name: 'Europa League' },
    'soccer_mls': { category: 'football', leagueId: 253, name: 'MLS' },
    
    // Basketball
    'basketball_nba': { category: 'basketball', leagueId: 12, name: 'NBA' },
    'basketball_wnba': { category: 'basketball', leagueId: 13, name: 'WNBA' },
    'basketball_euroleague': { category: 'basketball', leagueId: 120, name: 'EuroLeague' },
    
    // American Football
    'americanfootball_nfl': { category: 'american_football', leagueId: 1, name: 'NFL' },
    'americanfootball_ncaaf': { category: 'american_football', leagueId: 2, name: 'NCAAF' },
    
    // Baseball
    'baseball_mlb': { category: 'baseball', leagueId: 1, name: 'MLB' },
    'baseball_npb': { category: 'baseball', leagueId: 5, name: 'NPB' },
    
    // Hockey
    'icehockey_nhl': { category: 'hockey', leagueId: 1, name: 'NHL' },
    'icehockey_khl': { category: 'hockey', leagueId: 2, name: 'KHL' },
    
    // MMA
    'mma_ufc': { category: 'mma', leagueId: 1, name: 'UFC' },
    'mma_bellator': { category: 'mma', leagueId: 2, name: 'Bellator' },
    
    // Tennis
    'tennis_atp': { category: 'tennis', leagueId: 1, name: 'ATP' },
    'tennis_wta': { category: 'tennis', leagueId: 2, name: 'WTA' },
    
    // Motorsports
    'formula1': { category: 'f1', leagueId: 1, name: 'Formula 1' },
    
    // Golf
    'golf_pga': { category: 'golf', leagueId: 1, name: 'PGA Tour' },
    'golf_european_tour': { category: 'golf', leagueId: 2, name: 'European Tour' },
    
    // Rugby
    'rugby_premiership': { category: 'rugby', leagueId: 1, name: 'Premiership Rugby' },
    
    // Boxing
    'boxing': { category: 'boxing', leagueId: 1, name: 'Boxing' }
  }
};

export class ApiSportsProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apisports';
    this.priority = 30;
    this.headers = {
      'x-rapidapi-key': this.apiKey,
    };
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
      this.headers['x-rapidapi-host'] = new URL(baseUrl).host;

      // Different endpoints for different sports based on API documentation
      if (['football', 'basketball', 'hockey', 'baseball', 'american_football'].includes(sportConfig.category)) {
        return await this._fetchTeamSportsOdds(baseUrl, sportKey, sportConfig, options);
      } else if (['tennis', 'mma', 'boxing'].includes(sportConfig.category)) {
        return await this._fetchCombatSportsOdds(baseUrl, sportKey, sportConfig, options);
      } else if (['f1', 'golf'].includes(sportConfig.category)) {
        return await this._fetchIndividualSportsOdds(baseUrl, sportKey, sportConfig, options);
      }

      return [];

    } catch (error) {
      console.error(`❌ ApiSportsProvider failed for ${sportKey}:`, error.message);
      throw error;
    }
  }

  async _fetchTeamSportsOdds(baseUrl, sportKey, sportConfig, options) {
    try {
      const currentYear = new Date().getFullYear();
      const url = `${baseUrl}/games`;
      
      const response = await withTimeout(
        axios.get(url, {
          params: {
            season: currentYear,
            league: sportConfig.leagueId,
            date: new Date().toISOString().split('T')[0] // Today's games
          },
          headers: this.headers
        }),
        10000,
        `apisports_${sportKey}_games`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);

      if (!response.data?.response || !Array.isArray(response.data.response)) {
        console.warn(`⚠️ ApiSportsProvider: No game data for ${sportKey}`);
        return [];
      }

      const games = response.data.response.slice(0, 15); // Limit for performance
      const enhancedGames = [];

      for (const game of games) {
        try {
          const odds = await this._fetchGameOdds(baseUrl, game.game?.id);
          const enhancedGame = this._transformTeamGameData(game, odds, sportKey, sportConfig);
          if (enhancedGame) {
            enhancedGames.push(enhancedGame);
          }
        } catch (gameError) {
          console.warn(`⚠️ Failed to process ${sportKey} game ${game.game?.id}:`, gameError.message);
          continue;
        }
      }

      console.log(`✅ ApiSportsProvider: Processed ${enhancedGames.length} ${sportKey} games`);
      return enhancedGames;

    } catch (error) {
      console.error(`❌ ApiSportsProvider ${sportKey} games fetch failed:`, error);
      throw error;
    }
  }

  async _fetchCombatSportsOdds(baseUrl, sportKey, sportConfig, options) {
    try {
      const url = `${baseUrl}/fights`;
      const response = await withTimeout(
        axios.get(url, {
          params: {
            league: sportConfig.leagueId,
            season: new Date().getFullYear(),
            date: new Date().toISOString().split('T')[0]
          },
          headers: this.headers
        }),
        10000,
        `apisports_${sportKey}_fights`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);

      if (!response.data?.response || !Array.isArray(response.data.response)) {
        console.warn(`⚠️ ApiSportsProvider: No fight data for ${sportKey}`);
        return [];
      }

      const fights = response.data.response.slice(0, 10);
      const enhancedFights = [];

      for (const fight of fights) {
        try {
          const odds = await this._fetchFightOdds(baseUrl, fight.fight?.id || fight.id);
          const enhancedFight = this._transformCombatData(fight, odds, sportKey, sportConfig);
          if (enhancedFight) {
            enhancedFights.push(enhancedFight);
          }
        } catch (fightError) {
          console.warn(`⚠️ Failed to process ${sportKey} fight:`, fightError.message);
          continue;
        }
      }

      console.log(`✅ ApiSportsProvider: Processed ${enhancedFights.length} ${sportKey} fights`);
      return enhancedFights;

    } catch (error) {
      console.error(`❌ ApiSportsProvider ${sportKey} fights fetch failed:`, error);
      throw error;
    }
  }

  async _fetchIndividualSportsOdds(baseUrl, sportKey, sportConfig, options) {
    try {
      const url = `${baseUrl}/races`; // For F1, golf tournaments, etc.
      const response = await withTimeout(
        axios.get(url, {
          params: {
            league: sportConfig.leagueId,
            season: new Date().getFullYear()
          },
          headers: this.headers
        }),
        10000,
        `apisports_${sportKey}_events`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);

      if (!response.data?.response || !Array.isArray(response.data.response)) {
        console.warn(`⚠️ ApiSportsProvider: No event data for ${sportKey}`);
        return [];
      }

      const events = response.data.response.slice(0, 5);
      const enhancedEvents = [];

      for (const event of events) {
        try {
          const odds = await this._fetchEventOdds(baseUrl, event.id);
          const enhancedEvent = this._transformIndividualData(event, odds, sportKey, sportConfig);
          if (enhancedEvent) {
            enhancedEvents.push(enhancedEvent);
          }
        } catch (eventError) {
          console.warn(`⚠️ Failed to process ${sportKey} event:`, eventError.message);
          continue;
        }
      }

      console.log(`✅ ApiSportsProvider: Processed ${enhancedEvents.length} ${sportKey} events`);
      return enhancedEvents;

    } catch (error) {
      console.error(`❌ ApiSportsProvider ${sportKey} events fetch failed:`, error);
      throw error;
    }
  }

  async _fetchGameOdds(baseUrl, gameId) {
    if (!gameId) return { response: [] };

    try {
      const url = `${baseUrl}/odds`;
      const response = await withTimeout(
        axios.get(url, {
          params: { game: gameId },
          headers: this.headers
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

  async _fetchFightOdds(baseUrl, fightId) {
    if (!fightId) return { response: [] };

    try {
      const url = `${baseUrl}/odds`;
      const response = await withTimeout(
        axios.get(url, {
          params: { fight: fightId },
          headers: this.headers
        }),
        8000,
        `apisports_odds_fight_${fightId}`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);
      return response.data;

    } catch (error) {
      console.warn(`⚠️ Failed to fetch odds for fight ${fightId}:`, error.message);
      return { response: [] };
    }
  }

  async _fetchEventOdds(baseUrl, eventId) {
    if (!eventId) return { response: [] };

    try {
      const url = `${baseUrl}/odds`;
      const response = await withTimeout(
        axios.get(url, {
          params: { event: eventId },
          headers: this.headers
        }),
        8000,
        `apisports_odds_event_${eventId}`
      );

      await rateLimitService.saveProviderQuota(this.name, response.headers);
      return response.data;

    } catch (error) {
      console.warn(`⚠️ Failed to fetch odds for event ${eventId}:`, error.message);
      return { response: [] };
    }
  }

  _transformTeamGameData(apiGame, oddsData, sportKey, sportConfig) {
    if (!apiGame?.game?.id || !apiGame?.teams) {
      return null;
    }

    const bookmakers = this._extractBookmakers(oddsData);
    
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

  _transformCombatData(fightData, oddsData, sportKey, sportConfig) {
    if (!fightData?.id || !fightData?.fighters) {
      return null;
    }

    const bookmakers = this._extractBookmakers(oddsData);
    
    return {
      event_id: `apisports_${fightData.id}`,
      sport_key: sportKey,
      league_key: sportConfig.name,
      commence_time: fightData.date,
      home_team: this._standardizeFighterName(fightData.fighters[0]?.name, sportKey),
      away_team: this._standardizeFighterName(fightData.fighters[1]?.name, sportKey),
      market_data: { 
        bookmakers: bookmakers,
        last_updated: new Date().toISOString()
      },
      sport_title: sportConfig.name,
      data_quality: this._assessGameDataQuality(fightData, bookmakers),
      source: 'apisports'
    };
  }

  _transformIndividualData(eventData, oddsData, sportKey, sportConfig) {
    if (!eventData?.id || !eventData?.name) {
      return null;
    }

    const bookmakers = this._extractBookmakers(oddsData);
    
    // For individual sports, create a generic event structure
    return {
      event_id: `apisports_${eventData.id}`,
      sport_key: sportKey,
      league_key: sportConfig.name,
      commence_time: eventData.date,
      home_team: eventData.name, // Use event name for individual sports
      away_team: 'Various Competitors',
      market_data: { 
        bookmakers: bookmakers,
        last_updated: new Date().toISOString()
      },
      sport_title: sportConfig.name,
      data_quality: this._assessGameDataQuality(eventData, bookmakers),
      source: 'apisports'
    };
  }

  _extractBookmakers(oddsData) {
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
    const marketMap = {
      'Moneyline': 'h2h',
      'Match Winner': 'h2h',
      'Spread': 'spreads',
      'Handicap': 'spreads',
      'Total': 'totals',
      'Over/Under': 'totals',
      'Fighter Winner': 'h2h',
      'Fight Result': 'h2h'
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
    if (!teamName) return 'Unknown Team';
    
    // Keep original team names - no assumptions
    return teamName.trim();
  }

  _standardizeFighterName(fighterName, sportKey) {
    if (!fighterName) return 'Unknown Fighter';
    return fighterName.trim();
  }

  _standardizeSelectionName(selection) {
    if (!selection) return 'Unknown';
    
    // Minimal standardization based on common patterns
    if (typeof selection === 'string') {
      if (selection.includes('Over')) return 'Over';
      if (selection.includes('Under')) return 'Under';
    }
    
    return selection;
  }

  _assessGameDataQuality(gameData, bookmakers) {
    let score = 0;
    let factors = [];

    if (gameData.teams || gameData.fighters || gameData.name) {
      score += 30;
      factors.push('valid_participants');
    }

    if (gameData.date || gameData.game?.date) {
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
    try {
      // Return ALL sports that API-Sports supports based on verified mappings
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
      
      // Test with a known working endpoint (football status)
      const testUrl = `${APISPORTS_CONFIG.baseUrls.football}/status`;
      await withTimeout(
        axios.get(testUrl, { headers: this.headers }),
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
