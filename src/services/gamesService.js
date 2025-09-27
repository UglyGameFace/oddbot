// src/services/gamesService.js

import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import env from '../config/env.js';

const CACHE_TTL = env.CACHE_TTL_DEFAULT || 300; // 5 minutes default

// Fallback titles to guarantee non-null button labels downstream
const SPORT_TITLES = {
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  baseball_mlb: 'MLB',
  football_nfl: 'NFL',
  hockey_nhl: 'NHL',
  icehockey_nhl: 'NHL',
  football_ncaaf: 'NCAAF',
  americanfootball_ncaaf: 'NCAAF',
};

// Prefer College Football over NHL
const PREFERRED_FIRST = ['football_ncaaf', 'americanfootball_ncaaf'];
const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];

function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  return [...(sports || [])].sort(
    (a, b) => rank(a?.sport_key || '') - rank(b?.sport_key || '')
  );
}

// Optional provider sports merge to enrich sparse DB/API results
async function fetchProviderSports() {
  if (!env.THE_ODDS_API_KEY) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports?all=true&apiKey=${env.THE_ODDS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`provider sports ${res.status}`);
    const arr = await res.json();
    return (arr || []).map(s => ({ sport_key: s.key, sport_title: s.title || '', active: !!s.active }));
  } catch (e) {
    sentryService.captureError(e, { component: 'games_service', operation: 'fetchProviderSports' });
    return [];
  }
}

class GamesService {
  /**
   * Gets a list of all currently available sports.
   * Strategy: Redis -> Database -> Live API Fallback -> Provider sports merge (optional)
   */
  async getAvailableSports() {
    const redis = await redisClient;
    const cacheKey = 'games:available_sports';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentryService.captureError(e, { component: 'games_service', operation: 'getAvailableSports_cache_read' });
    }

    try {
      // 1) Primary: DB distinct sports
      let sports = await databaseService.getDistinctSports();

      // 2) Fallback: derive from live games via odds API (upcoming)
      if (!sports || sports.length === 0) {
        console.warn('No sports found in DB, attempting live API fallback...');
        const liveGames = await oddsService.getSportOdds('upcoming'); // your wrapper around /v4/sports/:sport/odds [web:363]
        if (liveGames && liveGames.length > 0) {
          const map = new Map();
          for (const g of liveGames) {
            if (g?.sport_key) map.set(g.sport_key, g.sport_title || '');
          }
          sports = Array.from(map, ([sport_key, sport_title]) => ({ sport_key, sport_title }));
        }
      }

      // 3) Optional enrichment: merge with provider /v4/sports (in-season + off-season) for completeness
      if (sports && sports.length > 0 && env.THE_ODDS_API_KEY) {
        try {
          const provider = await fetchProviderSports(); // may be empty on error [web:363]
          if (provider.length) {
            const seen = new Set(sports.map(s => s.sport_key));
            for (const p of provider) {
              if (!seen.has(p.sport_key)) sports.push({ sport_key: p.sport_key, sport_title: p.sport_title || '' });
            }
          }
        } catch (e) {
          // already captured in fetchProviderSports
        }
      }

      // Normalize titles to guarantee non-null, then sort for UX preference
      const normalized = (sports || [])
        .filter(s => s?.sport_key)
        .map(s => ({
          sport_key: s.sport_key,
          sport_title: s.sport_title || SPORT_TITLES[s.sport_key] || s.sport_key, // non-empty label [web:87]
        }));

      const dedupSeen = new Set();
      const dedup = [];
      for (const s of normalized) {
        if (dedupSeen.has(s.sport_key)) continue;
        dedupSeen.add(s.sport_key);
        dedup.push(s);
      }

      const ordered = sortSports(dedup);

      if (ordered.length > 0) {
        await redis.set(cacheKey, JSON.stringify(ordered), 'EX', CACHE_TTL);
      }

      return ordered;
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getAvailableSports' });
      return [];
    }
  }

  /**
   * Gets a list of all upcoming games for a given sport.
   * Strategy: Redis -> Database -> Live API Fallback
   */
  async getGamesForSport(sportKey) {
    const redis = await redisClient;
    const cacheKey = `games:sport:${sportKey}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentryService.captureError(e, { component: 'games_service', operation: 'getGamesForSport_cache_read' });
    }

    try {
      // 1) Primary: DB
      let games = await databaseService.getGamesBySport(sportKey);

      // 2) Fallback: Odds API
      if (!games || games.length === 0) {
        console.warn(`No games for ${sportKey} in DB, attempting live API fallback...`);
        games = await oddsService.getSportOdds(sportKey); // wrapper for /v4/sports/:sport/odds [web:363]
      }

      if (games && games.length > 0) {
        await redis.set(cacheKey, JSON.stringify(games), 'EX', CACHE_TTL);
      }

      return games || [];
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getGamesForSport' });
      return [];
    }
  }

  /**
   * Gets the full details for a single game by its ID.
   * Strategy: Redis -> Database (ID lookups from DB)
   */
  async getGameDetails(gameId) {
    const redis = await redisClient;
    const cacheKey = `games:details:${gameId}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentryService.captureError(e, { component: 'games_service', operation: 'getGameDetails_cache_read' });
    }

    try {
      const game = await databaseService.getGameById(gameId);

      if (game) {
        await redis.set(cacheKey, JSON.stringify(game), 'EX', CACHE_TTL * 2);
      }

      return game;
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getGameDetails' });
      return null;
    }
  }
}

const gamesServiceInstance = new GamesService();
export default gamesServiceInstance;
