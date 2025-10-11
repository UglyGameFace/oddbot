// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

const SPORTRADAR_BASE = 'https://api.sportradar.us';

export class SportRadarProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sportradar';
    this.priority = 20;
  }

  async fetchSportOdds(sportKey, options = {}) {
    const endpointConfig = this.getEndpointForSport(sportKey);
    if (!endpointConfig) {
      console.warn(`⚠️ SportRadar: No mapping found for sport key: ${sportKey}`);
      return [];
    }

    const url = `${SPORTRADAR_BASE}/${endpointConfig.path}`;
    
    try {
        const response = await withTimeout(
            axios.get(url, { params: { api_key: this.apiKey } }),
            10000,
            `sportradar_${sportKey}`
        );

        await rateLimitService.saveProviderQuota(this.name, response.headers);
        return this.transformScheduleData(response.data?.sport_events, sportKey);
    } catch (error) {
        if (error.response?.status === 403) {
            console.error(`❌ SportRadar 403 Forbidden: Your API key for the "${endpointConfig.name}" feed may not be active. Please verify your subscriptions on the Sportradar dashboard.`);
        }
        throw error;
    }
  }

  getEndpointForSport(sportKey) {
    const mapping = {
      'americanfootball_nfl': { path: `us/odds/v2/en/sports/sr:sport:16/schedule.json`, name: 'US Football Odds' },
      'basketball_nba': { path: `us/odds/v2/en/sports/sr:sport:1/schedule.json`, name: 'US Basketball Odds' },
      'icehockey_nhl': { path: `us/odds/v2/en/sports/sr:sport:4/schedule.json`, name: 'US Hockey Odds' },
      'baseball_mlb': { path: `us/odds/v2/en/sports/sr:sport:3/schedule.json`, name: 'US Baseball Odds' },
      'soccer_england_premier_league': { path: `us/odds/v2/en/sports/sr:sport:25/schedule.json`, name: 'US Soccer Odds' },
      'soccer_uefa_champions_league': { path: `us/odds/v2/en/sports/sr:sport:27/schedule.json`, name: 'UEFA Champions League' },
      'mma_ufc': { path: `us/odds/v2/en/sports/sr:sport:38/schedule.json`, name: 'UFC MMA' }
    };
    return mapping[sportKey];
  }

  transformScheduleData(events, sportKey) {
    if (!Array.isArray(events)) {
      console.warn('⚠️ SportRadar (schedule) returned non-array data');
      return [];
    }

    return events.reduce((acc, event) => {
      if (!event?.id || !event?.start_time || !event?.competitors) {
        return acc;
      }

      const homeTeam = event.competitors.find(c => c.qualifier === 'home')?.name || 'N/A';
      const awayTeam = event.competitors.find(c => c.qualifier === 'away')?.name || 'N/A';
      
      const enhancedGame = {
        event_id: event.id.replace('sr:match:', ''),
        sport_key: sportKey,
        league_key: event.sport_event_context?.competition?.name || this.titleFromKey(sportKey),
        commence_time: event.start_time,
        home_team: homeTeam,
        away_team: awayTeam,
        market_data: { 
          bookmakers: [], 
          last_updated: new Date().toISOString()
        },
        sport_title: this.titleFromKey(sportKey),
        data_quality: this.assessGameDataQuality(event),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  convertToAmericanOdds(decimalOdds) {
    if (decimalOdds >= 2.0) {
      return Math.round((decimalOdds - 1) * 100);
    } else {
      return Math.round(-100 / (decimalOdds - 1));
    }
  }

  assessGameDataQuality(game) {
    let score = 0;
    const factors = [];
    if (game.competitors && game.competitors.length === 2) {
        score += 50;
        factors.push('valid_teams');
    }
    if (game.start_time) {
        score += 30;
        factors.push('start_time');
    }
    if (game.sport_event_context?.competition?.name) {
        score += 20;
        factors.push('league_info');
    }
    return {
      score,
      factors,
      rating: score >= 80 ? 'excellent' : 'good'
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
      'soccer_england_premier_league': 'Premier League'
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
        status: 'active',
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
