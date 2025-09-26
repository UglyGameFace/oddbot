// src/services/oddsCacheAdapters.js
// Adapter to expose handler-expected ESM named exports by delegating to the
// existing ProvenOddsService default export in oddsService.js.

import redis from './redisService.js';
import service from './oddsService.js';

// TTLs for per-id game index
const GAMEIDX_TTL = 120; // seconds

// Map ProvenOddsService.getSupportedSports() to handler-expected shape
export async function getAvailableSportsCached() {
  const sports = await service.getSupportedSports();
  // Handlers expect { sport_key, sport_title }
  return (sports || []).map(s => ({
    sport_key: s.key,
    sport_title: s.title || s.key,
  }));
}

// Map ProvenOddsService.getSportOdds(sportKey) and build an ID index for details
export async function getGamesForSportCached(sportKey) {
  const games = await service.getSportOdds(sportKey);
  // Index by id for quick details lookup on refresh
  for (const g of games || []) {
    if (g?.id) {
      await redis.set(`odds:game:${g.id}`, JSON.stringify(g), 'EX', GAMEIDX_TTL);
    }
  }
  return games || [];
}

// Retrieve latest game object by id from the adapter’s index
export async function getGameDetailsCached(gameId) {
  if (!gameId) return null;
  const raw = await redis.get(`odds:game:${gameId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
