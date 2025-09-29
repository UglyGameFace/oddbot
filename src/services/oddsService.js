// src/services/oddsService.js
import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import rateLimitService from './rateLimitService.js';

// CONFIG
const CACHE_TTL_ODDS = 60;     // seconds
const CACHE_TTL_PROPS = 120;   // seconds
const LOCK_MS = 8000;          // ms
const RETRY_MS = 150;

const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// Cache-aside with short lock to prevent stampede
async function getOrSetJSON(redis, key, ttlSec, loader) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const lockKey = `lock:${key}`;
  const gotLock = await redis.set(lockKey, '1', { NX: true, PX: LOCK_MS });
  if (gotLock) {
    try {
      const data = await loader();
      await redis.set(key, JSON.stringify(data), { EX: ttlSec });
      return data;
    } finally {
      await redis.del(lockKey);
    }
  } else {
    const deadline = Date.now() + LOCK_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, RETRY_MS));
      const again = await redis.get(key);
      if (again) return JSON.parse(again);
    }
    const data = await loader();
    await redis.set(key, JSON.stringify(data), { EX: ttlSec });
    return data;
  }
}

class OddsService {
  constructor() {
    this.apiProviders = [
      { name: 'theodds', fetch: this._fetchFromTheOddsAPI.bind(this) },
      { name: 'sportradar', fetch: this._fetchFromSportRadar.bind(this) },
      { name: 'apisports', fetch: this._fetchFromApiSports.bind(this) },
    ];
  }

  // --- Public Methods ---
  async getSportOdds(
    sportKey,
    { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}
  ) {
    const redis = await redisClient;
    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}`;

    try {
      return await getOrSetJSON(redis, cacheKey, CACHE_TTL_ODDS, async () => {
        let rows = [];
        for (const provider of this.apiProviders) {
          try {
            if (await rateLimitService.shouldBypassLive(provider.name)) {
              console.log(`Bypassing ${provider.name} due to zero remaining quota.`);
              continue;
            }
            rows = await provider.fetch(sportKey, { regions, markets, oddsFormat });
            if (rows && rows.length) return rows;
          } catch (error) {
            if (error?.response?.headers) {
              await rateLimitService.saveProviderQuota(provider.name, error.response.headers);
            }
            if (error?.response?.status === 429) {
              console.warn(`${provider.name} returned 429. Stopping attempts for this cycle.`);
              break; 
            }
            sentryService.captureError(error, {
              component: 'odds_service_provider_failure',
              provider: provider.name,
              sportKey,
            });
          }
        }
        return rows || [];
      });
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_service_cache', sportKey });
      return [];
    }
  }

  async getPlayerPropsForGame(
    sportKey,
    gameId,
    { regions = 'us', bookmakers, markets = 'player_points,player_rebounds,player_assists', oddsFormat = 'american' } = {}
  ) {
    const redis = await redisClient;
    const scope = bookmakers ? `bk:${bookmakers}` : `rg:${regions}`;
    const cacheKey = `player_props:${sportKey}:${gameId}:${scope}:${markets}:${oddsFormat}`;

    try {
      return await getOrSetJSON(redis, cacheKey, CACHE_TTL_PROPS, async () => {
        if (await rateLimitService.shouldBypassLive('theodds')) return [];
        try {
          const url = `${ODDS_BASE}/sports/${sportKey}/events/${gameId}/odds`;
          const params = { apiKey: env.THE_ODDS_API_KEY, oddsFormat, markets, dateFormat: 'iso' };
          if (bookmakers) params.bookmakers = bookmakers; else params.regions = regions;
          const res = await axios.get(url, { params });
          await rateLimitService.saveProviderQuota('theodds', res.headers);
          return res.data?.bookmakers || [];
        } catch (error) {
          if (error?.response?.headers) {
            await rateLimitService.saveProviderQuota('theodds', error.response.headers);
          }
          if (error?.response?.status === 429) return [];
          sentryService.captureError(error, {
            component: 'odds_service_player_props',
            sportKey, gameId, regions, bookmakers, markets
          });
          return [];
        }
      });
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_service_player_props_cache', gameId });
      return [];
    }
  }

  // --- Private Providers ---
  async _fetchFromTheOddsAPI(
    sportKey,
    { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}
  ) {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const res = await axios.get(url, {
      params: { apiKey: env.THE_ODDS_API_KEY, regions, markets, oddsFormat, dateFormat: 'iso' }
    });
    await rateLimitService.saveProviderQuota('theodds', res.headers);
    return this._transformTheOddsAPIData(res.data);
  }

  async _fetchFromSportRadar(sportKey) {
    const radarSportKey = sportKey.split('_')[1] || 'nfl';
    const url = `https://api.sportradar.us/odds/v1/en/us/sports/${radarSportKey}/schedule.json`;
    const res = await axios.get(url, { params: { api_key: env.SPORTRADAR_API_KEY } });
    await rateLimitService.saveProviderQuota('sportradar', res.headers);
    return this._transformSportRadarData(res.data?.sport_events, sportKey);
  }

  async _fetchFromApiSports(sportKey) {
    const url = `https://v3.football.api-sports.io/odds`;
    try {
        const res = await axios.get(url, {
            headers: { 'x-apisports-key': env.API_SPORTS_KEY },
            params: { sport: sportKey, season: '2024' }
        });
        await rateLimitService.saveProviderQuota('apisports', res.headers);
        return [];
    } catch (error) {
        if (error.response && error.response.headers) {
            await rateLimitService.saveProviderQuota('apisports', error.response.headers);
        }
        console.error(`Error fetching from API-SPORTS for ${sportKey}:`, error.message);
        return [];
    }
  }

  // --- Mappers ---
  _transformTheOddsAPIData(data) {
    return (data || []).reduce((acc, d) => {
      if (d.id && d.sport_key && d.commence_time && d.home_team && d.away_team) {
        acc.push({
          event_id: d.id,
          sport_key: d.sport_key,
          sport_title: d.sport_title,
          commence_time: d.commence_time,
          home_team: d.home_team,
          away_team: d.away_team,
          bookmakers: d.bookmakers || []
        });
      } else {
        console.warn(`[Data Validation] Discarding invalid game object from TheOddsAPI: ${JSON.stringify(d)}`);
      }
      return acc;
    }, []);
  }

  _transformSportRadarData(events, sportKey) {
    return (events || []).reduce((acc, event) => {
        if (event.id && event.start_time) {
            acc.push({
                event_id: `sr_${event.id}`,
                sport_key: sportKey,
                sport_title: event?.sport_event_context?.competition?.name || 'Unknown',
                commence_time: event?.start_time,
                home_team: (event?.competitors || []).find(c => c.qualifier === 'home')?.name || 'N/A',
                away_team: (event?.competitors || []).find(c => c.qualifier === 'away')?.name || 'N/A',
                bookmakers: []
            });
        } else {
            console.warn(`[Data Validation] Discarding invalid game object from SportRadar: ${JSON.stringify(event)}`);
        }
        return acc;
    }, []);
  }
}

const oddsServiceInstance = new OddsService();
export default oddsServiceInstance;
