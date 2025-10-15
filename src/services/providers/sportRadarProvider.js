// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

const SPORTRADAR_BASE = 'https://api.sportradar.us';

export class SportRadarProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sportradar';
    this.priority = 20;
  }

  async fetchSportOdds(sportKey, options = {}) {
    if (!this.apiKey) {
      throw new Error('SportRadar API key is not configured. Please check your .env file.');
    }
    const endpointConfig = this.getEndpointForSport(sportKey);
    if (!endpointConfig) {
      console.warn(`⚠️ SportRadar: No trial mapping found for sport key: ${sportKey}`);
      return [];
    }

    const url = `${SPORTRADAR_BASE}/${endpointConfig.path}`;
    
    try {
        const response = await withTimeout(
            axios.get(url, { params: { api_key: this.apiKey } }),
            10000,
            `sportradar_schedule_${sportKey}`
        );

        await rateLimitService.saveProviderQuota(this.name, response.headers);
        return this.transformScheduleData(response.data, sportKey, endpointConfig.name);
    } catch (error) {
        if (error.response?.status === 401) {
            console.error(`❌ SportRadar 401 Unauthorized: The API key is invalid. Please verify SPORTRADAR_API_KEY in your .env file.`);
        } else if (error.response?.status === 403) {
            console.error(`❌ SportRadar 403 Forbidden: Your API key is valid but does not have access to the "${endpointConfig.name}" feed. Please check your subscriptions on the Sportradar dashboard.`);
        }
        throw error;
    }
  }

  getEndpointForSport(sportKey) {
    // --- CHANGE START ---
    // Corrected paths to match the user's trial feeds (NFL v7, NBA v8, etc.)
    // These fetch schedule data, NOT odds, which is what the trial provides.
    const year = new Date().getFullYear();
    const mapping = {
      'americanfootball_nfl': { path: `nfl/official/trial/v7/en/games/${year}/REG/schedule.json`, name: 'NFL v7' },
      'basketball_nba': { path: `nba/trial/v8/en/games/${year}/REG/schedule.json`, name: 'NBA v8' },
      'baseball_mlb': { path: `mlb/trial/v7/en/games/${year}/REG/schedule.json`, name: 'MLB v7' },
      'icehockey_nhl': { path: `nhl/trial/v7/en/games/${year}/REG/schedule.json`, name: 'NHL v7' },
      'soccer_england_premier_league': { path: `soccer/trial/v4/en/competitions/sr:competition:17/schedule.json`, name: 'Soccer Trial v4' }
    };
    // --- CHANGE END ---
    return mapping[sportKey];
  }

  transformScheduleData(data, sportKey, feedName) {
    // --- CHANGE START ---
    // This function is now specifically designed to parse schedule data, not odds data.
    const events = data?.games || data?.schedule || data?.sport_events;
    if (!Array.isArray(events)) {
      console.warn(`⚠️ SportRadar (${feedName}) returned a non-array data structure for ${sportKey}`);
      return [];
    }

    return events.reduce((acc, event) => {
      // Skip if essential data is missing
      if (!event?.id || !event?.scheduled || !(event.home?.name && event.away?.name)) {
        return acc;
      }
      
      const enhancedGame = {
        event_id: event.id.replace('sr:match:', ''),
        sport_key: sportKey,
        league_key: this.titleFromKey(sportKey),
        commence_time: event.scheduled,
        home_team: event.home.name,
        away_team: event.away.name,
        bookmakers: [], // IMPORTANT: Schedule feeds do not provide odds. This will be an empty array.
        sport_title: this.titleFromKey(sportKey),
        data_quality: this.assessGameDataQuality(event),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
    // --- CHANGE END ---
  }

  assessGameDataQuality(game) {
    let score = 0;
    const factors = [];
    if (game.home?.name && game.away?.name) {
        score += 60;
        factors.push('valid_teams');
    }
    if (game.scheduled) {
        score += 40;
        factors.push('start_time');
    }
    return {
      score,
      factors,
      rating: score >= 90 ? 'excellent' : 'good'
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
      // This generic endpoint is often available even on trial keys to check for API status.
      const testUrl = `${SPORTRADAR_BASE}/odds/v2/en/daily_change_log.json`;
      await withTimeout(
        axios.get(testUrl, { params: { api_key: this.apiKey } }),
        8000, 'sportradar_healthcheck'
      );
      const quota = await rateLimitService.getProviderQuota(this.name);
      return {
        name: this.name,
        status: 'active',
        priority: this.priority,
        last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
        remaining_requests: "N/A", // SportRadar doesn't typically provide this in headers
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
