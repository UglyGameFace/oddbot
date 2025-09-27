// src/services/oddsCacheAdapters.js
import oddsService from './oddsService.js';
import redis from './redisService.js';
import sentry from './sentryService.js';

const CACHE_TTL = 300; // 5 minutes

export async function getGamesForSportCached(sportKey) {
  const redisClient = await redis; // FIX: await the redis connection
  const cacheKey = `games:${sportKey}`;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    console.error(`Redis GET error for ${cacheKey}:`, err.message);
    sentry.captureError(err, { component: 'odds_cache_adapter_read' });
  }

  const data = await oddsService.getSportOdds(sportKey);

  if (data && data.length) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL);
    } catch (err) {
      console.error(`Redis SET error for ${cacheKey}:`, err.message);
      sentry.captureError(err, { component: 'odds_cache_adapter_write' });
    }
  }

  return data;
}
