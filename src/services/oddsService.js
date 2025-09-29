// src/services/oddsService.js
import axios from 'axios';
import env from '../config/env.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import rateLimitService from './rateLimitService.js';

const CACHE_TTL_ODDS = 60;
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
  const gotLock = await redis.set(lockKey, '1', { NX: true, PX: LOCK_MS });
  if (gotLock) {
    try {
      const data = await loader();
      if (data && data.length > 0) {
        await redis.set(key, JSON.stringify(data), { EX: ttlSec });
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
        await redis.set(key, JSON.stringify(data), { EX: ttlSec });
    }
    return data;
  }
}

class OddsService {
  constructor() {
    this.apiProviders = [
      { name: 'theodds', fetch: this._fetchFromTheOddsAPI.bind(this) }
    ];
  }

  async getSportOdds(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const redis = await redisClient;
    const cacheKey = `odds:${sportKey}:${regions}:${markets}:${oddsFormat}`;
    return getOrSetJSON(redis, cacheKey, CACHE_TTL_ODDS, async () => {
      for (const provider of this.apiProviders) {
        try {
          if (await rateLimitService.shouldBypassLive(provider.name)) continue;
          const rows = await provider.fetch(sportKey, { regions, markets, oddsFormat });
          if (rows && rows.length) return rows;
        } catch (error) {
          if (error?.response?.headers) {
            await rateLimitService.saveProviderQuota(provider.name, error.response.headers);
          }
          sentryService.captureError(error, { component: 'odds_service', provider: provider.name });
        }
      }
      return [];
    });
  }
  
  async _fetchFromTheOddsAPI(sportKey, { regions = 'us', markets = 'h2h,spreads,totals', oddsFormat = 'american' } = {}) {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds`;
    const res = await axios.get(url, { params: { apiKey: env.THE_ODDS_API_KEY, regions, markets, oddsFormat, dateFormat: 'iso' }});
    await rateLimitService.saveProviderQuota('theodds', res.headers);
    return this._transformTheOddsAPIData(res.data);
  }

  _transformTheOddsAPIData(data) {
    return (data || []).reduce((acc, d) => {
      if (d.id && d.sport_key && d.commence_time && d.home_team && d.away_team) {
        acc.push({
          // This structure now perfectly matches your 'games' table schema.
          event_id: d.id,
          sport_key: d.sport_key,
          league_key: d.sport_title || titleFromKey(d.sport_key),
          commence_time: d.commence_time,
          home_team: d.home_team,
          away_team: d.away_team,
          // FIX: Separated market_data and bookmakers to match your schema
          market_data: { a: 1 }, // Placeholder for any non-bookmaker market data
          bookmakers: d.bookmakers || [], // Correctly maps to the top-level 'bookmakers' column
          sport_title: d.sport_title || titleFromKey(d.sport_key)
        });
      }
      return acc;
    }, []);
  }
}

export default new OddsService();
