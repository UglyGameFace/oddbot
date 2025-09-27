// src/services/oddsService.js
import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentry from './sentryService.js';

const API_KEY = env.ODDS_API_KEY;
const API_KEY_RADAR = env.SPORTRADAR_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const BASE_URL_RADAR = 'https://api.sportradar.us/odds/v1/en/us/sports';

const CACHE_TTL = 3600; // 1 hour

class ProvenOddsService {
  constructor() {
    this.providers = [
      this.fetchFromOddsAPI.bind(this),
      this.fetchFromSportRadar.bind(this)
    ];
  }

  async getSportOdds(sportKey) {
    const redisClient = await redis; // FIX: await the redis connection
    const cacheKey = `odds:${sportKey}`;

    try {
      const cachedData = await redisClient.get(cacheKey);
      if (cachedData) {
        console.log(` CACHE HIT for ${sportKey}`);
        return JSON.parse(cachedData);
      }
    } catch (e) {
      console.error('Redis GET error:', e?.message || e);
      sentry.captureError(e, { component: 'odds_service_cache_read' });
    }

    console.log(` CACHE MISS for ${sportKey}, fetching fresh data...`);
    let combinedOdds = [];
    for (const fetchFn of this.providers) {
      try {
        const odds = await fetchFn(sportKey);
        if (odds && odds.length) {
          combinedOdds = this.mergeOdds(combinedOdds, odds);
        }
      } catch (error) {
        console.error(`Odds fetch failed for provider ${fetchFn.name} sportKey ${sportKey}: ${error.message}`);
      }
    }

    if (combinedOdds.length > 0) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(combinedOdds), 'EX', CACHE_TTL);
      } catch (e) {
        console.error('Redis SET error:', e?.message || e);
        sentry.captureError(e, { component: 'odds_service_cache_write' });
      }
    }
    return combinedOdds;
  }

  mergeOdds(existing, fresh) {
    const map = new Map();
    existing.forEach(item => map.set(item.id, item));
    fresh.forEach(item => map.set(item.id, item));
    return Array.from(map.values());
  }

  async fetchFromOddsAPI(sportKey) {
    try {
      const { data } = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
        params: { apiKey: API_KEY, regions: 'us', markets: 'h2h,spreads', oddsFormat: 'american' }
      });
      return this.transformOddsAPI(data);
    } catch (error) {
      sentry.captureError(error, { component: 'the_odds_api' });
      throw error;
    }
  }

  async fetchFromSportRadar(sportKey) {
    const radarSport = sportKey.split('_')[1] || 'nfl';
    const endpoint = `${BASE_URL_RADAR}/${radarSport}/schedule.json`;
    try {
      const { data } = await axios.get(endpoint, { params: { api_key: API_KEY_RADAR } });
      return this.transformSportRadar(data.sport_events);
    } catch (error) {
      sentry.captureError(error, { component: 'sportradar_api' });
      throw error;
    }
  }

  transformOddsAPI(data) {
    return (data || []).map(d => ({
      id: d.id,
      sport_key: d.sport_key,
      sport_title: d.sport_title,
      commence_time: d.commence_time,
      home_team: d.home_team,
      away_team: d.away_team,
      bookmakers: d.bookmakers
    }));
  }

  transformSportRadar(events) {
    return (events || []).map(event => ({
        id: `sr_${event.id}`,
        sport_key: event.sport_event_context.competition.name.toLowerCase().replace(/ /g, '_'),
        sport_title: event.sport_event_context.competition.name,
        commence_time: event.start_time,
        home_team: event.competitors.find(c => c.qualifier === 'home')?.name || 'N/A',
        away_team: event.competitors.find(c => c.qualifier === 'away')?.name || 'N/A',
        bookmakers: [] // SportRadar schedule does not include odds, needs another call
    }));
  }
}

export default new ProvenOddsService();
