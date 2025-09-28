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
      this._fetchFromTheOddsAPI.bind(this),
      this._fetchFromSportRadar.bind(this),
    ];
  }

  // --- Public Methods ---

  // Featured markets (h2h, spreads, totals) with quota-aware fallback
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
            // Skip live The Odds API if snapshot says remaining === 0
            if (provider === this._fetchFromTheOddsAPI && await rateLimitService.shouldBypassLive('theodds')) {
              // Try next provider (e.g., Sportradar) without wasting credits
              continue;
            }
            rows = await provider(sportKey, { regions, markets, oddsFormat });
            if (rows && rows.length) return rows;
          } catch (error) {
            // Record headers if present (captures x-requests-remaining etc.)
            if (provider === this._fetchFromTheOddsAPI && error?.response?.headers) {
              await rateLimitService.saveProviderQuota('theodds', error.response.headers);
            }
            // On 429 stop hitting this provider; will fall through to next or cache
            if (error?.response?.status === 429) break;
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

  // Player props for one event with quota-aware fallback
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
        // If quota exhausted, return empty (or whatever is already cached by getOrSetJSON)
        if (await rateLimitService.shouldBypassLive('theodds')) return [];

        try {
          const url = `${ODDS_BASE}/sports/${sportKey}/events/${gameId}/odds`;
          const params = { apiKey: env.THE_ODDS_API_KEY, oddsFormat, markets, dateFormat: 'iso' };
          if (bookmakers) params.bookmakers = bookmakers; else params.regions = regions;

          const res = await axios.get(url, { params });
          await rateLimitService.saveProviderQuota('theodds', res.headers);
          const props = res.data?.bookmakers || [];
          return props;
        } catch (error) {
          if (error?.response?.headers) {
            await rateLimitService.saveProviderQuota('theodds', error.response.headers);
          }
          // On 429 return [] to avoid burning credits; cache layer will keep prior value if any
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

  // The Odds API featured markets (captures quota headers on success)
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

  // Sportradar schedule fallback (no quota headers assumed)
  async _fetchFromSportRadar(sportKey) {
    const radarSportKey = sportKey.split('_')[1] || 'nfl';
    const url = `https://api.sportradar.us/odds/v1/en/us/sports/${radarSportKey}/schedule.json`;
    const res = await axios.get(url, { params: { api_key: env.SPORTRADAR_API_KEY } });
    return this._transformSportRadarData(res.data?.sport_events, sportKey);
  }

  // --- Mappers ---

  _transformTheOddsAPIData(data) {
    return (data || []).map(d => ({
      event_id: d.id,
      sport_key: d.sport_key,
      league_key: d.sport_title,
      sport_title: d.sport_title,
      commence_time: d.commence_time,
      home_team: d.home_team,
      away_team: d.away_team,
      market_data: { bookmakers: d.bookmakers || [] }
    }));
  }

  _transformSportRadarData(events, sportKey) {
    return (events || []).map(event => ({
      event_id: `sr_${event.id}`,
      sport_key: sportKey,
      league_key: event?.sport_event_context?.competition?.name || 'Unknown',
      sport_title: event?.sport_event_context?.competition?.name || 'Unknown',
      commence_time: event?.start_time,
      home_team: (event?.competitors || []).find(c => c.qualifier === 'home')?.name || 'N/A',
      away_team: (event?.competitors || []).find(c => c.qualifier === 'away')?.name || 'N/A',
      market_data: { bookmakers: [] }
    }));
  }
}

const oddsServiceInstance = new OddsService();
export default oddsServiceInstance;
