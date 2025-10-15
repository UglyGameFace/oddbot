// src/services/providers/apiNinjaProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

const NINJA_BASE = 'https://api.api-ninjas.com/v1/odds';

export class ApiNinjaProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apininja';
    this.priority = 15; // Higher priority than SportRadar, lower than TheOddsAPI
  }

  async fetchSportOdds(sportKey, options = {}) {
    const sport = this.getSportForApiKey(sportKey);
    if (!sport) {
      console.warn(`[ApiNinja] No mapping found for sport key: ${sportKey}`);
      return [];
    }

    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for API-Ninja');
    }

    const url = `${NINJA_BASE}?sport=${sport}`;
    
    try {
        const response = await withTimeout(
            axios.get(url, { headers: { 'X-Api-Key': this.apiKey } }),
            10000,
            `apininja_${sportKey}`
        );

        await rateLimitService.saveProviderQuota(this.name, response.headers);
        return this.transformData(response.data, sportKey);
    } catch (error) {
        sentryService.captureError(error, { component: 'ApiNinjaProvider', sportKey });
        throw error;
    }
  }

  getSportForApiKey(sportKey) {
    const mapping = {
      'americanfootball_nfl': 'football_nfl',
      'basketball_nba': 'basketball_nba',
      'icehockey_nhl': 'hockey_nhl',
      'baseball_mlb': 'baseball_mlb',
      'soccer_epl': 'soccer_epl',
      'soccer_england_premier_league': 'soccer_epl'
    };
    return mapping[sportKey];
  }

  transformData(data, sportKey) {
    if (!Array.isArray(data)) {
      console.warn('⚠️ ApiNinja returned non-array data');
      return [];
    }

    return data.reduce((acc, game) => {
      if (!this.validateGameData(game)) {
        console.warn(`[Data Validation] ApiNinja: Discarding invalid game data.`);
        return acc;
      }
      
      const eventId = `apininja_${game.home_team.replace(/\s/g, '')}_${game.away_team.replace(/\s/g, '')}_${game.start_time}`;

      acc.push({
        event_id: eventId,
        id: eventId,
        sport_key: sportKey,
        sport_title: this.titleFromKey(sportKey),
        commence_time: new Date(game.start_time).toISOString(),
        home_team: game.home_team,
        away_team: game.away_team,
        bookmakers: this.transformBookmakers(game.bookmakers),
        source: this.name
      });
      return acc;
    }, []);
  }

  transformBookmakers(bookmakers) {
      if (!Array.isArray(bookmakers)) return [];
      return bookmakers.map(bookmaker => ({
          key: bookmaker.key,
          title: bookmaker.title,
          last_update: new Date(bookmaker.last_update).toISOString(),
          markets: this.transformMarkets(bookmaker.markets)
      }));
  }

  transformMarkets(markets) {
      if (!Array.isArray(markets)) return [];
      return markets.map(market => ({
          key: market.key,
          outcomes: market.outcomes.map(outcome => ({
              name: outcome.name,
              price: outcome.price
          }))
      }));
  }

  validateGameData(game) {
    if (!game) return false;
    const required = ['home_team', 'away_team', 'start_time'];
    return required.every(field => game[field] !== undefined && game[field] !== null);
  }
  
  async fetchAvailableSports() {
    // API-Ninja does not provide a sports endpoint, so we return a hardcoded list of supported sports.
    return [
        { key: 'americanfootball_nfl', title: 'NFL', group: 'American Football' },
        { key: 'basketball_nba', title: 'NBA', group: 'Basketball' },
        { key: 'baseball_mlb', title: 'MLB', group: 'Baseball' },
        { key: 'icehockey_nhl', title: 'NHL', group: 'Hockey' },
        { key: 'soccer_england_premier_league', title: 'Premier League', group: 'Soccer' }
    ];
  }

  titleFromKey(key) {
    const mapping = {
      'americanfootball_nfl': 'NFL',
      'basketball_nba': 'NBA',
      'baseball_mlb': 'MLB',
      'icehockey_nhl': 'NHL',
      'soccer_england_premier_league': 'Premier League'
    };
    return mapping[key] || key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  async getProviderStatus() {
    try {
      const quota = await rateLimitService.getProviderQuota(this.name);
      return {
        name: this.name,
        status: quota ? 'active' : 'unknown',
        priority: this.priority,
        last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
        remaining_requests: quota?.remaining,
        should_bypass: await rateLimitService.shouldBypassLive(this.name)
      };
    } catch (error) {
      return {
        name: this.name,
        status: 'error',
        error: error.message
      };
    }
  }
}
