// src/services/providers/theOddsProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout, sleep } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

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
      includeLive = false
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
      dateFormat: 'iso' 
    };

    if (includeLive) {
      params.commenceTimeFrom = new Date().toISOString();
      params.commenceTimeTo = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    }

    const response = await withTimeout(
      axios.get(url, { params }),
      10000,
      `theodds_${sportKey}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return this.transformData(response.data, sportKey);
  }

  async fetchPlayerProps(sportKey, gameId, options = {}) {
    const {
      regions = 'us',
      markets = 'player_points,player_rebounds,player_assists',
      oddsFormat = 'american'
    } = options;

    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for The Odds API');
    }

    const url = `${ODDS_BASE}/sports/${sportKey}/events/${gameId}/odds`;
    const params = { 
      apiKey: this.apiKey, 
      oddsFormat, 
      markets, 
      dateFormat: 'iso' 
    };
    
    if (options.bookmakers) params.bookmakers = options.bookmakers; 
    else params.regions = regions;

    const response = await withTimeout(
      axios.get(url, { params }),
      10000,
      `getPlayerProps_${gameId}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return response.data?.bookmakers || [];
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

      const enhancedGame = {
        event_id: game.id,
        sport_key: sportKey,
        league_key: game.sport_title || this.titleFromKey(sportKey),
        commence_time: game.commence_time,
        home_team: game.home_team,
        away_team: game.away_team,
        market_data: { 
          bookmakers: game.bookmakers || [],
          last_updated: new Date().toISOString()
        },
        sport_title: game.sport_title || this.titleFromKey(sportKey),
        data_quality: this.assessGameDataQuality(game),
        source: 'theodds'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  validateGameData(game) {
    if (!game) return false;
    
    const required = ['id', 'sport_key', 'commence_time', 'home_team', 'away_team'];
    return required.every(field => 
      game[field] !== undefined && 
      game[field] !== null && 
      String(game[field]).trim() !== ''
    );
  }

  assessGameDataQuality(game) {
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

  titleFromKey(key) {
    const sportMapping = {
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
    return sportMapping[key] || key.split('_').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
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
