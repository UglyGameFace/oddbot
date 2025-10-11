// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

// This base URL now correctly points to the US Odds API v2, which matches your free trial.
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
    // This mapping uses the specific endpoints for the free US odds packages.
    const mapping = {
      'americanfootball_nfl': { path: `us/odds/v2/en/sports/sr:sport:16/schedule.json`, name: 'US Football Odds' },
      'basketball_nba': { path: `us/odds/v2/en/sports/sr:sport:1/schedule.json`, name: 'US Basketball Odds' },
      'icehockey_nhl': { path: `us/odds/v2/en/sports/sr:sport:4/schedule.json`, name: 'US Hockey Odds' },
      'baseball_mlb': { path: `us/odds/v2/en/sports/sr:sport:3/schedule.json`, name: 'US Baseball Odds' }
    };
    return mapping[sportKey];
  }
      const title = event?.sport_event_context?.competition?.name || this.titleFromKey(sportKey);
      const competitors = event?.competitors || [];
      
      const enhancedGame = {
        event_id: `sr_${event.id}`,
        sport_key: sportKey,
        league_key: title,
        commence_time: event.start_time,
        home_team: competitors.find(c => c.qualifier === 'home')?.name || 'N/A',
        away_team: competitors.find(c => c.qualifier === 'away')?.name || 'N/A',
        market_data: { 
          bookmakers: this.extractMarketsFromEvent(event),
          last_updated: new Date().toISOString()
        },
        sport_title: title,
        data_quality: this.assessGameDataQuality(event),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  extractMarketsFromEvent(event) {
    const markets = [];
    
    if (event?.odds) {
      Object.entries(event.odds).forEach(([bookmaker, oddsData]) => {
        const bookmakerMarkets = {
          key: bookmaker,
          title: bookmaker,
          markets: []
        };

        if (oddsData.moneyline) {
          bookmakerMarkets.markets.push({
            key: 'h2h',
            outcomes: Object.entries(oddsData.moneyline).map(([team, price]) => ({
              name: team,
              price: this.convertToAmericanOdds(price)
            }))
          });
        }

        markets.push(bookmakerMarkets);
      });
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
      score: 60,
      factors: ['sportradar_source', 'official_data'],
      rating: 'good'
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
