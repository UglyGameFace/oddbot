// src/services/oddsService.js
import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentry from './sentryService.js';

const API_KEY = env.THE_ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const CACHE_TTL_SPORTS = 3600; // 1 hour
const CACHE_TTL_GAMES = 300; // 5 minutes

class OddsService {

  async getAvailableSportsCached() {
    const cacheKey = 'sports:available';
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentry.captureError(e, { component: 'get_sports_cache_read' });
    }
    
    try {
        const { data } = await axios.get(BASE_URL, { params: { apiKey: API_KEY }});
        const sports = (data || []).map(s => ({ sport_key: s.key, sport_title: s.title }));

        await redis.set(cacheKey, JSON.stringify(sports), 'EX', CACHE_TTL_SPORTS);
        return sports;
    } catch (e) {
        sentry.captureError(e, { component: 'get_sports_api_fetch' });
        return [];
    }
  }

  async getGamesForSportCached(sportKey) {
    const cacheKey = `games:${sportKey}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentry.captureError(e, { component: 'get_games_cache_read', context: { sportKey } });
    }
    
    try {
        const { data } = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
          params: { apiKey: API_KEY, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american' }
        });
        
        if (data && data.length) {
           await redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL_GAMES);
        }
        return data || [];
    } catch (e) {
        sentry.captureError(e, { component: 'get_games_api_fetch', context: { sportKey } });
        return [];
    }
  }

  async getGameDetailsCached(gameId) {
    const cacheKey = `game-details:${gameId}`;
     try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentry.captureError(e, { component: 'get_game_details_cache_read', context: { gameId } });
    }
    return null;
  }
}

export default new OddsService();
