// src/services/providers/theOddsProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

const ODDS_BASE = 'https://api.the-odds-api.com/v4';

export class TheOddsProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'theodds';
    this.priority = 1;
  }

  async fetchSportOdds(sportKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      bookmakers = 'draftkings,fanduel,betmgm,caesars,pointsbetus,wynnbet,betrivers,unibet' // Expanded list of bookmakers
    } = options;

    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for The Odds API');
    }

    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const params = {
      apiKey: this.apiKey,
      regions,
      markets,
      oddsFormat,
      bookmakers, // Pass the selected bookmakers to the API
      dateFormat: 'iso'
    };

    const response = await withTimeout(
      axios.get(url, { params }),
      10000,
      `theodds_${sportKey}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return this.transformData(response.data, sportKey);
  }

  async fetchAvailableSports() {
    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for The Odds API');
    }

    const url = `${ODDS_BASE}/sports`;
    const response = await withTimeout(
      axios.get(url, {
        params: {
          apiKey: this.apiKey,
          all: 'false'
        }
      }),
      8000,
      'theodds_sports_list'
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);

    return (response.data || []).map(sport => ({
      key: sport.key,
      title: sport.title,
      group: sport.group,
      description: sport.description,
      active: sport.active !== false,
      has_outrights: sport.has_outrights || false,
      source: 'theodds'
    }));
  }

  transformData(data, sportKey) {
    if (!Array.isArray(data)) {
      console.warn('⚠️ TheOddsAPI returned non-array data');
      return [];
    }

    return data.reduce((acc, game) => {
      if (!this.validateGameData(game)) {
        console.warn(`[Data Validation] Discarding invalid game: ${game.id}`);
        return acc;
      }
      acc.push({
        event_id: game.id,
        sport_key: sportKey,
        league_key: game.sport_title || this.titleFromKey(sportKey),
        commence_time: game.commence_time,
        home_team: game.home_team,
        away_team: game.away_team,
        bookmakers: game.bookmakers || [],
        sport_title: game.sport_title || this.titleFromKey(sportKey),
        source: 'theodds'
      });
      return acc;
    }, []);
  }

  validateGameData(game) {
    if (!game) return false;
    const required = ['id', 'sport_key', 'commence_time', 'home_team', 'away_team'];
    return required.every(field => game[field] !== undefined && game[field] !== null && String(game[field]).trim() !== '');
  }

  titleFromKey(key) {
    const mapping = {
      'americanfootball_nfl': 'NFL',
      'americanfootball_ncaaf': 'NCAAF',
      'basketball_nba': 'NBA',
      'basketball_wnba': 'WNBA',
      'baseball_mlb': 'MLB',
      'icehockey_nhl': 'NHL',
      'soccer_england_premier_league': 'Premier League',
      'soccer_uefa_champions_league': 'Champions League',
      'tennis_atp': 'ATP Tennis',
      'mma_ufc': 'UFC'
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
