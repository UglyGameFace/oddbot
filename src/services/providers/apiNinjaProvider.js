// src/services/providers/apiNinjaProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

const NINJA_BASE = 'https://api.api-ninjas.com/v1/sportsodds';

export class ApiNinjaProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apininja';
    this.priority = 15; // Higher priority than SportRadar, lower than TheOddsAPI
  }

  async fetchSportOdds(sportKey, options = {}) {
    const league = this.getLeagueForSport(sportKey);
    if (!league) {
      console.warn(`⚠️ ApiNinja: No mapping found for sport key: ${sportKey}`);
      return [];
    }

    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for API-Ninja');
    }

    const url = `${NINJA_BASE}?league=${league}`;
    
    const response = await withTimeout(
        axios.get(url, { headers: { 'X-Api-Key': this.apiKey } }),
        10000,
        `apininja_${sportKey}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return this.transformData(response.data, sportKey);
  }

  getLeagueForSport(sportKey) {
    const mapping = {
      'americanfootball_nfl': 'nfl',
      'basketball_nba': 'nba',
      'icehockey_nhl': 'nhl',
      'baseball_mlb': 'mlb',
      'soccer_epl': 'epl', // Note: API-Ninja may use different keys
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
      acc.push({
        event_id: `${this.name}_${game.home_team}_${game.away_team}_${game.start_time}`,
        sport_key: sportKey,
        league_key: this.titleFromKey(sportKey),
        commence_time: new Date(game.start_time * 1000).toISOString(),
        home_team: game.home_team,
        away_team: game.away_team,
        bookmakers: this.transformBookmakers(game.odds),
        sport_title: this.titleFromKey(sportKey),
        source: this.name
      });
      return acc;
    }, []);
  }

  transformBookmakers(odds) {
      if (!odds || !Array.isArray(odds.bookmakers)) return [];
      return odds.bookmakers.map(bookmaker => ({
          key: bookmaker.key,
          title: bookmaker.title,
          last_update: new Date(bookmaker.last_update * 1000).toISOString(),
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

  titleFromKey(key) {
    const mapping = {
      'americanfootball_nfl': 'NFL',
      'basketball_nba': 'NBA',
      'baseball_mlb': 'MLB',
      'icehockey_nhl': 'NHL',
      'soccer_epl': 'Premier League'
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
