// src/services/oddsService.js

import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';

// CONFIG
const CACHE_TTL_ODDS = 60;     // 1 minute for live featured markets
const CACHE_TTL_PROPS = 120;   // 2 minutes for props (slower-changing)
const LOCK_MS = 8000;          // short lock to prevent stampede
const RETRY_MS = 150;

const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// Small helper for lock + TTL cache to prevent stampedes [web:606][web:609]
async function getOrSetJSON(redis, key, ttlSec, loader) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const lockKey = `lock:${key}`;
  // SET NX + PX (ms) basic lock; see Redis locking pattern [web:614]
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
    // last resort: load once to avoid deadlock
    const data = await loader();
    await redis.set(key, JSON.stringify(data), { EX: ttlSec });
    return data;
  }
}

class OddsService {
  constructor() {
    this.apiProviders = [
      this._fetchFromTheOddsAPI,
      this._fetchFromSportRadar,
    ];
  }

  // --- Public Methods ---

  /**
   * Fetches game odds for a given sport with cache-aside and provider fallback.
   * Uses featured markets only (h2h, spreads, totals) for speed and quota efficiency. [web:363][web:617]
   */
  async getSportOdds(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const redis = await redisClient;
    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}`;

    try {
      return await getOrSetJSON(redis, cacheKey, CACHE_TTL_ODDS, async () => {
        // Try providers in order; first success wins
        for (const provider of this.apiProviders) {
          try {
            const oddsData = await provider.call(this, sportKey, { regions, markets, oddsFormat });
            if (oddsData && oddsData.length > 0) return oddsData;
          } catch (error) {
            console.error(`API provider ${provider.name} failed for ${sportKey}:`, error.message);
            sentryService.captureError(error, { component: 'odds_service_provider_failure', provider: provider.name, sportKey });
          }
        }
        console.warn(`All API providers failed to return data for ${sportKey}.`);
        return [];
      });
    } catch (e) {
      console.error(`getSportOdds error for ${sportKey}:`, e.message);
      sentryService.captureError(e, { component: 'odds_service_cache', sportKey });
      return [];
    }
  }

  /**
   * Fetches detailed player prop markets for a specific game.
   * IMPORTANT: Uses event-odds endpoint and player_* markets; regions OR bookmakers must be set. [web:363][web:385]
   * Returns array of bookmakers payload (pass-through) or [] on failure.
   */
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
        console.log(`CACHE MISS for player props: ${gameId}. Fetching...`);
        try {
          const url = `${ODDS_BASE}/sports/${sportKey}/events/${gameId}/odds`; // event-odds endpoint [web:363]
          const params = { apiKey: env.THE_ODDS_API_KEY, oddsFormat, markets, dateFormat: 'iso' };
          if (bookmakers) params.bookmakers = bookmakers; else params.regions = regions;
          const { data } = await axios.get(url, { params });

          const props = data?.bookmakers || [];
          return props;
        } catch (error) {
          // 422 = unprocessable (invalid event id, markets not supported, etc.) [web:559]
          console.error(`Failed to fetch player props for game ${gameId}:`, error.message);
          sentryService.captureError(error, { component: 'odds_service_player_props', sportKey, gameId, regions, bookmakers, markets });
          return [];
        }
      });
    } catch (e) {
      console.error(`Redis cache error for player props ${gameId}:`, e.message);
      sentryService.captureError(e, { component: 'odds_service_player_props_cache', gameId });
      return [];
    }
  }

  // --- Private API Fetching and Transformation Logic ---

  /**
   * The Odds API featured markets (fast path). [web:363][web:617]
   */
  async _fetchFromTheOddsAPI(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const { data } = await axios.get(url, {
      params: { apiKey: env.THE_ODDS_API_KEY, regions, markets, oddsFormat, dateFormat: 'iso' }
    });
    return this._transformTheOddsAPIData(data);
  }

  /**
   * Sportradar schedule fallback (structure kept; transformation uses existing mapper).
   */
  async _fetchFromSportRadar(sportKey) {
    const radarSportKey = sportKey.split('_')[1] || 'nfl';
    const url = `https://api.sportradar.us/odds/v1/en/us/sports/${radarSportKey}/schedule.json`;
    const { data } = await axios.get(url, { params: { api_key: env.SPORTRADAR_API_KEY } });
    return this._transformSportRadarData(data.sport_events, sportKey);
  }

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
