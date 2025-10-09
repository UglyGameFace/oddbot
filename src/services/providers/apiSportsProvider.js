// src/services/providers/apiSportsProvider.js - NEW FILE
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

const APISPORTS_BASE = 'https://v1.american-football.api-sports.io';

export class ApiSportsProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'apisports';
    this.priority = 3; // Higher than fallback
  }

  async fetchSportOdds(sportKey, options = {}) {
    const apiSportsKey = this.mapToApiSportsKey(sportKey);
    if (!apiSportsKey) {
      console.log(`⚠️ API-Sports doesn't support ${sportKey}`);
      return [];
    }

    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for API-Sports');
    }

    const url = `${APISPORTS_BASE}/${apiSportsKey}`;
    
    const response = await withTimeout(
      axios.get(url, { 
        headers: { 
          'x-apisports-key': this.apiKey,
          'Content-Type': 'application/json'
        } 
      }),
      10000,
      `apisports_${sportKey}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return this.transformData(response.data?.response, sportKey);
  }

  mapToApiSportsKey(sportKey) {
    const mapping = {
      'americanfootball_nfl': 'games',
      'americanfootball_ncaaf': 'games',
      'basketball_nba': 'games', 
      'baseball_mlb': 'games',
      'icehockey_nhl': 'games'
    };
    return mapping[sportKey] || null;
  }

  transformData(events, sportKey) {
    if (!Array.isArray(events)) {
      console.warn('⚠️ API-Sports returned non-array data');
      return [];
    }

    return events.reduce((acc, event) => {
      if (!event?.id || !event?.date) {
        return acc;
      }

      const enhancedGame = {
        event_id: `as_${event.id}`,
        sport_key: sportKey,
        league_key: event.league?.name || this.titleFromKey(sportKey),
        commence_time: event.date,
        home_team: event.teams?.home?.name || 'N/A',
        away_team: event.teams?.away?.name || 'N/A',
        market_data: { 
          bookmakers: this.extractMarketsFromEvent(event),
          last_updated: new Date().toISOString()
        },
        sport_title: this.titleFromKey(sportKey),
        data_quality: this.assessGameDataQuality(event),
        source: 'apisports'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  extractMarketsFromEvent(event) {
    const markets = [];
    
    if (event.odds) {
      const bookmakerMarkets = {
        key: 'apisports',
        title: 'API-Sports',
        markets: []
      };

      // Convert API-Sports format to common format
      if (event.odds.home && event.odds.away) {
        bookmakerMarkets.markets.push({
          key: 'h2h',
          outcomes: [
            { name: 'home', price: this.convertToAmericanOdds(event.odds.home) },
            { name: 'away', price: this.convertToAmericanOdds(event.odds.away) }
          ]
        });
      }

      markets.push(bookmakerMarkets);
    }

    return markets;
  }

  convertToAmericanOdds(decimalOdds) {
    if (decimalOdds >= 2.0) {
      return Math.round((decimalOdds - 1) * 100);
    } else {
      return Math.round(-100 / (decimalOdds - 1));
    }
  }

  assessGameDataQuality(game) {
    return {
      score: 70,
      factors: ['apisports_source', 'official_data'],
      rating: 'good'
    };
  }

  titleFromKey(key) {
    const sportMapping = {
      'americanfootball_nfl': 'NFL',
      'americanfootball_ncaaf': 'NCAAF',
      'basketball_nba': 'NBA',
      'baseball_mlb': 'MLB',
      'icehockey_nhl': 'NHL'
    };
    return sportMapping[key] || key.split('_').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }

  async fetchAvailableSports() {
    if (await rateLimitService.shouldBypassLive(this.name)) {
      throw new Error('Rate limit exceeded for API-Sports');
    }

    // API-Sports supported sports
    return [
      {
        key: 'americanfootball_nfl',
        title: 'NFL Football',
        group: 'american',
        active: true,
        source: 'apisports'
      },
      {
        key: 'americanfootball_ncaaf', 
        title: 'NCAAF',
        group: 'american',
        active: true,
        source: 'apisports'
      },
      {
        key: 'basketball_nba',
        title: 'NBA Basketball',
        group: 'american', 
        active: true,
        source: 'apisports'
      },
      {
        key: 'baseball_mlb',
        title: 'MLB Baseball',
        group: 'american',
        active: true,
        source: 'apisports'
      },
      {
        key: 'icehockey_nhl',
        title: 'NHL Hockey',
        group: 'american',
        active: true,
        source: 'apisports'
      }
    ];
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
