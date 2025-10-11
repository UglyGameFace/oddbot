// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

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
        // The data structure for v2 is different, so we need a new transform function.
        return this.transformScheduleData(response.data?.sport_events, sportKey);
    } catch (error) {
        // Add specific logging for 403 errors to help debug permissions
        if (error.response?.status === 403) {
            console.error(`❌ SportRadar 403 Forbidden: Your API key for the "${endpointConfig.name}" feed may not be active. Please verify your subscriptions on the Sportradar dashboard.`);
        }
        throw error; // Re-throw the error to be handled by the oddsService fallback chain
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
          bookmakers: [], // The schedule endpoint does not contain odds data.
          last_updated: new Date().toISOString()
        },
        sport_title: this.titleFromKey(sportKey),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  titleFromKey(key) {
    return key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  async getProviderStatus() {
    try {
      const quota = await rateLimitService.getProviderQuota(this.name);
      return {
        name: this.name,
        status: 'active',
        priority: this.priority,
        last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
      };
    } catch (error) {
      return { name: this.name, status: 'error', error: error.message };
    }
  }
}
