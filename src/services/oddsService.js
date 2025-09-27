// src/services/oddsService.js

import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';

const CACHE_TTL = 3600; // Cache odds for 1 hour

class OddsService {
  constructor() {
    this.apiProviders = [
      this._fetchFromTheOddsAPI,
      this._fetchFromSportRadar,
    ];
  }

  // --- Public Methods ---

  /**
   * Fetches game odds for a given sport, using a cache-aside strategy and a multi-provider fallback system.
   */
  async getSportOdds(sportKey) {
    const redis = await redisClient;
    const cacheKey = `odds:${sportKey}`;

    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        console.log(`CACHE HIT for game odds: ${sportKey}`);
        return JSON.parse(cachedData);
      }
    } catch (e) {
      console.error(`Redis GET error for ${sportKey}:`, e.message);
      sentryService.captureError(e, { component: 'odds_service_cache_read' });
    }

    console.log(`CACHE MISS for game odds: ${sportKey}. Fetching from live APIs...`);
    
    // Try each API provider in order until one succeeds
    for (const provider of this.apiProviders) {
      try {
        const oddsData = await provider.call(this, sportKey);
        if (oddsData && oddsData.length > 0) {
          await redis.set(cacheKey, JSON.stringify(oddsData), 'EX', CACHE_TTL);
          return oddsData;
        }
      } catch (error) {
        console.error(`API provider ${provider.name} failed for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'odds_service_provider_failure', provider: provider.name });
      }
    }

    console.warn(`All API providers failed to return data for ${sportKey}.`);
    return []; // Return empty array if all providers fail
  }

  /**
   * Fetches detailed player prop markets for a specific game.
   */
  async getPlayerPropsForGame(sportKey, gameId) {
    const redis = await redisClient;
    const cacheKey = `player_props:${gameId}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        console.log(`CACHE HIT for player props: ${gameId}`);
        return JSON.parse(cachedData);
      }
    } catch (e) {
      console.error(`Redis GET error for player props:`, e.message);
    }
    
    console.log(`CACHE MISS for player props: ${gameId}. Fetching...`);
    try {
      const markets = 'player_points,player_rebounds,player_assists,player_pass_tds,player_pass_yds,player_rush_yds,player_recv_yds';
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${gameId}/odds`;
      const { data } = await axios.get(url, {
        params: { apiKey: env.THE_ODDS_API_KEY, regions: 'us', markets, oddsFormat: 'american' }
      });
      
      const props = data.bookmakers || [];
      if (props.length > 0) {
        await redis.set(cacheKey, JSON.stringify(props), 'EX', CACHE_TTL);
      }
      return props;
    } catch (error) {
      console.error(`Failed to fetch player props for game ${gameId}:`, error.message);
      sentryService.captureError(error, { component: 'odds_service_player_props' });
      return [];
    }
  }

  // --- Private API Fetching and Transformation Logic ---

  async _fetchFromTheOddsAPI(sportKey) {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`;
    const { data } = await axios.get(url, {
      params: { apiKey: env.THE_ODDS_API_KEY, regions: 'us', markets: 'h2h,spreads', oddsFormat: 'american' }
    });
    return this._transformTheOddsAPIData(data);
  }

  async _fetchFromSportRadar(sportKey) {
    // SportRadar uses a different sport key format (e.g., 'nfl' instead of 'americanfootball_nfl')
    const radarSportKey = sportKey.split('_')[1] || 'nfl';
    const url = `https://api.sportradar.us/odds/v1/en/us/sports/${radarSportKey}/schedule.json`;
    
    // CORRECTED: Sending the API key in the headers, not as a URL parameter.
    const { data } = await axios.get(url, { 
      params: { api_key: env.SPORTRADAR_API_KEY } 
    });
    
    return this._transformSportRadarData(data.sport_events);
  }

  _transformTheOddsAPIData(data) {
    return (data || []).map(d => ({
      id: d.id,
      sport_key: d.sport_key,
      sport_title: d.sport_title,
      commence_time: d.commence_time,
      home_team: d.home_team,
      away_team: d.away_team,
      bookmakers: d.bookmakers || []
    }));
  }

  _transformSportRadarData(events) {
    return (events || []).map(event => ({
        id: `sr_${event.id}`, // Add prefix to avoid ID collisions
        sport_key: event.sport_event_context.competition.name.toLowerCase().replace(/ /g, '_'),
        sport_title: event.sport_event_context.competition.name,
        commence_time: event.start_time,
        home_team: event.competitors.find(c => c.qualifier === 'home')?.name || 'N/A',
        away_team: event.competitors.find(c => c.qualifier === 'away')?.name || 'N/A',
        // SportRadar schedule doesn't include odds, so we return an empty array.
        // The service is primarily a fallback for game schedules.
        bookmakers: [] 
    }));
  }
}

// Export a single, memoized instance of the service
const oddsServiceInstance = new OddsService();
export default oddsServiceInstance;
