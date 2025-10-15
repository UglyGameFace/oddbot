// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

const SR_BASE = 'https://api.sportradar.com';

export class SportRadarProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sportradar';
    this.priority = 20; // Lower priority than OddsAPI and Ninja, higher than others
  }

  async fetchSportOdds(sportKey, options = {}) {
    const endpoint = this._getEndpointForSport(sportKey, 'summary');
    if (!endpoint) {
      console.warn(`[SportRadar] No summary endpoint configured for ${sportKey}`);
      return [];
    }

    try {
      const summaryUrl = `${SR_BASE}${endpoint}?api_key=${this.apiKey}`;
      const summaryResponse = await withTimeout(axios.get(summaryUrl), 8000, `sportradar_summary_${sportKey}`);
      const games = summaryResponse.data.games || [];
      
      const oddsEndpoint = this._getEndpointForSport(sportKey, 'odds');
      if (!oddsEndpoint) return this.transformSummaryData(games, sportKey);

      const oddsUrl = `${SR_BASE}${oddsEndpoint}?api_key=${this.apiKey}`;
      const oddsResponse = await withTimeout(axios.get(oddsUrl), 8000, `sportradar_odds_${sportKey}`);
      const oddsData = oddsResponse.data;

      return this.combineSummaryAndOdds(games, oddsData, sportKey);

    } catch (error) {
      if (error.response && error.response.status === 403) {
          console.error(`❌ SportRadar 403 Forbidden: Your API key for the "${this._getFeedName(sportKey)}" feed may not be active. Please verify your subscriptions on the Sportradar dashboard.`);
      } else {
          console.error(`[SportRadar] Failed to fetch data for ${sportKey}:`, error.message);
      }
      return [];
    }
  }

  combineSummaryAndOdds(summaryGames, oddsData, sportKey) {
      const oddsMap = new Map((oddsData.games || []).map(g => [g.id, g.consensus_odds]));
      
      return summaryGames.map(game => {
          const gameOdds = oddsMap.get(game.id);
          return {
              ...game,
              odds: gameOdds,
              sport_key: sportKey
          };
      });
  }

  transformSummaryData(data, sportKey) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(game => ({
        id: game.id,
        commence_time: game.scheduled,
        home_team: game.home?.name,
        away_team: game.away?.name,
        sport_key: sportKey,
        bookmakers: [] // No odds in summary data
    }));
  }
  
  _getEndpointForSport(sportKey, type) {
    const mapping = {
      americanfootball_nfl: { summary: '/nfl/official/v7/en/games/current_season.json', odds: '/nfl/official/v7/en/odds/live.json' },
      basketball_nba: { summary: '/nba/trial/v8/en/games/current_season.json', odds: '/nba/trial/v8/en/odds/live.json' },
    };
    return mapping[sportKey] ? mapping[sportKey][type] : null;
  }
  
  _getFeedName(sportKey){
      const nameMap = {
          americanfootball_nfl: "US Football Odds",
          basketball_nba: "NBA Odds"
      };
      return nameMap[sportKey] || "Unknown";
  }

  async getProviderStatus() {
    return { name: this.name, status: 'active', priority: this.priority };
  }
}
