// src/services/oddsService.js
import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import rateLimitService from './rateLimitService.js';

const CACHE_TTL_ODDS = 60;
const CACHE_TTL_PROPS = 120;
const LOCK_MS = 8000;
const RETRY_MS = 150;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

const titleFromKey = (key) => {
    if (!key) return 'Unknown Sport';
    return key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

async function getOrSetJSON(redis, key, ttlSec, loader) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const lockKey = `lock:${key}`;
  // --- VERIFIED FIX: Use older, more compatible Redis syntax for SET with options ---
  const gotLock = await redis.set(lockKey, '1', 'PX', LOCK_MS, 'NX');
  if (gotLock) {
    try {
      const data = await loader();
      if (data && data.length > 0) {
        await redis.set(key, JSON.stringify(data), 'EX', ttlSec);
      }
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
     if (data && data.length > 0) {
        await redis.set(key, JSON.stringify(data), 'EX', ttlSec);
    }
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

  async getSportOdds(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const redis = await redisClient;
    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}`;
    try {
      return await getOrSetJSON(redis, cacheKey, CACHE_TTL_ODDS, async () => {
        for (const provider of this.apiProviders) {
          try {
            if (await rateLimitService.shouldBypassLive(provider.name)) continue;
            const rows = await provider.fetch(sportKey, { regions, markets, oddsFormat });
            if (rows && rows.length) return rows;
          } catch (error) {
            if (error?.response?.headers) {
              await rateLimitService.saveProviderQuota(provider.name, error.response.headers);
            }
            if (error?.response?.status === 429) break;
            sentryService.captureError(error, { component: 'odds_service_provider_failure', provider: provider.name, sportKey });
          }
        }
        return [];
      });
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_service_cache', sportKey });
      return [];
    }
  }

  async getPlayerPropsForGame(sportKey, gameId, { regions = 'us', bookmakers, markets = 'player_points,player_rebounds,player_assists', oddsFormat = 'american' } = {}) {
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
          if (error?.response?.status !== 429) {
            sentryService.captureError(error, { component: 'odds_service_player_props', sportKey, gameId });
          }
          return [];
        }
      });
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_service_player_props_cache', gameId });
      return [];
    }
  }

  async _fetchFromTheOddsAPI(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const res = await axios.get(url, { params: { apiKey: env.THE_ODDS_API_KEY, regions, markets, oddsFormat, dateFormat: 'iso' }});
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
    return [];
  }

  _transformTheOddsAPIData(data) {
    return (data || []).reduce((acc, d) => {
      if (d.id && d.sport_key && d.commence_time && d.home_team && d.away_team) {
        acc.push({
          event_id: d.id,
          sport_key: d.sport_key,
          league_key: d.sport_title || titleFromKey(d.sport_key),
          commence_time: d.commence_time,
          home_team: d.home_team,
          away_team: d.away_team,
          market_data: { bookmakers: d.bookmakers || [] },
          sport_title: d.sport_title || titleFromKey(d.sport_key)
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
            const title = event?.sport_event_context?.competition?.name || titleFromKey(sportKey);
            acc.push({
                event_id: `sr_${event.id}`,
                sport_key: sportKey,
                league_key: title,
                commence_time: event.start_time,
                home_team: (event?.competitors || []).find(c => c.qualifier === 'home')?.name || 'N/A',
                away_team: (event?.competitors || []).find(c => c.qualifier === 'away')?.name || 'N/A',
                market_data: { bookmakers: [] },
                sport_title: title
            });
        } else {
            console.warn(`[Data Validation] Discarding invalid game object from SportRadar: ${JSON.stringify(event)}`);
        }
        return acc;
    }, []);
  }
}

export default new OddsService();
