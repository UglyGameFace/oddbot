// src/services/gamesService.js

import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import env from '../config/env.js';
import axios from 'axios';

const CACHE_TTL = env.CACHE_TTL_DEFAULT || 300; // 5 minutes default

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

const PREFERRED_FIRST = ['football_ncaaf', 'americanfootball_ncaaf'];
const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];

function sortSports(sports) {
  const rank = (sportObj) => {
    const k = sportObj?.sport || '';
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  return [...(sports || [])].sort((a, b) => rank(a) - rank(b));
}

async function fetchProviderSports() {
  if (!env.THE_ODDS_API_KEY) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports?all=true&apiKey=${env.THE_ODDS_API_KEY}`;
    const res = await axios.get(url, { timeout: 5000 });
    return (res.data || []).map(s => ({ sport: s.key, sport_title: s.title || '', active: !!s.active }));
  } catch (e) {
    sentryService.captureError(e, { component: 'games_service', operation: 'fetchProviderSports' });
    return [];
  }
}

class GamesService {
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
      let sports = await databaseService.getDistinctSports();

      if (!sports || sports.length === 0) {
        console.warn('No sports found in DB, attempting live API fallback...');
        const liveGames = await oddsService.getSportOdds('upcoming');
        if (liveGames && liveGames.length > 0) {
          const map = new Map();
          for (const g of liveGames) {
            if (g?.sport) map.set(g.sport, g.sport_title || '');
          }
          sports = Array.from(map, ([sport, sport_title]) => ({ sport, sport_title }));
        }
      }

      if (sports && sports.length > 0 && env.THE_ODDS_API_KEY) {
        try {
          const provider = await fetchProviderSports();
          if (provider.length) {
            const seen = new Set(sports.map(s => s.sport));
            for (const p of provider) {
              if (!seen.has(p.sport)) {
                sports.push({ sport: p.sport, sport_title: p.sport_title || '' });
              }
            }
          }
        } catch (e) { /* already captured */ }
      }

      const normalized = (sports || [])
        .filter(s => s?.sport)
        .map(s => ({
          sport: s.sport,
          sport_title: s.sport_title || SPORT_TITLES[s.sport] || s.sport,
        }));

      const dedupSeen = new Set();
      const dedup = [];
      for (const s of normalized) {
        if (dedupSeen.has(s.sport)) continue;
        dedupSeen.add(s.sport);
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
      let games = await databaseService.getGamesBySport(sportKey);

      if (!games || games.length === 0) {
        console.warn(`No games for ${sportKey} in DB, attempting live API fallback...`);
        games = await oddsService.getSportOdds(sportKey);
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
