// src/services/providers/sportRadarProvider.js
import axios from 'axios';
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';

const SR_BASE = 'https://api.sportradar.com';

export class SportRadarProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sportradar';
    this.priority = 20; // Lower priority than OddsAPI and Ninja
  }

  async fetchSportOdds(sportKey, options = {}) {
    const endpoint = this._getEndpointForSport(sportKey);
    if (!endpoint) {
      console.warn(`[SportRadar] No summary endpoint configured for ${sportKey}`);
      return [];
    }

    try {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      
      const url = `${SR_BASE}${endpoint}/${year}/${month}/${day}/schedule.json?api_key=${this.apiKey}`;
      
      const response = await withTimeout(axios.get(url), 8000, `sportradar_schedule_${sportKey}`);
      await rateLimitService.saveProviderQuota(this.name, response.headers);
      
      const games = response.data.games || [];
      return this.transformScheduleData(games, sportKey);

    } catch (error) {
      if (error.response && error.response.status === 403) {
          console.error(`❌ SportRadar 403 Forbidden: Your API key for the "${this._getFeedName(sportKey)}" feed may not be active or the URL path is incorrect for your plan. Please verify your subscriptions on the Sportradar dashboard.`);
      } else {
          console.error(`[SportRadar] Failed to fetch data for ${sportKey}:`, error.message);
      }
      return [];
    }
  }

  transformScheduleData(games, sportKey) {
    if (!Array.isArray(games)) {
      console.warn('⚠️ SportRadar (schedule) returned non-array data');
      return [];
    }

    return games.reduce((acc, game) => {
      if (!game?.id || !game?.scheduled || !game?.home || !game?.away) {
        return acc;
      }
      
      const enhancedGame = {
        id: game.id,
        event_id: game.id.replace('sr:match:', ''),
        sport_key: sportKey,
        commence_time: game.scheduled,
        home_team: game.home.name,
        away_team: game.away.name,
        bookmakers: [], // SportRadar schedule endpoint does not contain odds.
        sport_title: this.titleFromKey(sportKey),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }
  
  _getEndpointForSport(sportKey) {
    // These paths are for daily schedules, which are often included in base packages.
    // NOTE: These may need to be adjusted based on the user's specific SportRadar subscription.
    const mapping = {
      americanfootball_nfl: '/nfl/official/trial/v7/en/games',
      basketball_nba: '/nba/trial/v8/en/games',
      icehockey_nhl: '/nhl/trial/v7/en/games',
      baseball_mlb: '/mlb/trial/v7/en/games',
    };
    return mapping[sportKey];
  }
  
  _getFeedName(sportKey){
      const nameMap = {
          americanfootball_nfl: "NFL",
          basketball_nba: "NBA",
          icehockey_nhl: "NHL",
          baseball_mlb: "MLB"
      };
      return name
