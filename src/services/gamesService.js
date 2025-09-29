// src/services/gamesService.js

import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import env from '../config/env.js';
import axios from 'axios';

const CACHE_TTL = Number(env.CACHE_TTL_DEFAULT || 300);

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
    // FIX: Ensure sportObj and sport_key exist to prevent errors on malformed data
    const k = sportObj?.sport_key || '';
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
    // IMPORTANT: Map the API response to match the database schema directly
    return (res.data || []).map(s => ({ sport_key: s.key, sport_title: s.title || '', active: !!s.active }));
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

      // --- THIS IS THE CRITICAL FIX ---
      // If the database is empty, we MUST fall back to the API provider to bootstrap the system.
      if (!sports || sports.length === 0) {
        console.log('Database contains no sports; falling back to API provider to bootstrap.');
        sports = await fetchProviderSports();
      }
      
      // Normalize/merge titles and order
      const normalized = (sports || [])
        .filter(s => s?.sport_key) // Filter by sport_key for consistency
        .map(s => ({
          sport_key: s.sport_key,
          sport_title: s.sport_title || SPORT_TITLES[s.sport_key] || s.sport_key,
        }));

      const deduped = [...new Map(normalized.map(item => [item.sport_key, item])).values()];
      const ordered = sortSports(deduped);

      if (ordered.length > 0) {
        await redis.set(cacheKey, JSON.stringify(ordered), { EX: CACHE_TTL });
      } else {
        console.warn("getAvailableSports is returning an empty array. The Odds API may be down or have no active sports.");
      }

      return ordered;
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getAvailableSports' });
      return [];
    }
  }

  async getGamesForSport(sportKey) {
    if (!sportKey) return [];
    const redis = await redisClient;
    const cacheKey = `games:sport:${sportKey}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      sentryService.captureError(e, { component: 'games_service', operation: 'getGamesForSport_cache_read' });
    }

    try {
      // Prioritize fetching live odds directly from the source for freshness
      let games = await oddsService.getSportOdds(sportKey);
      if (!games || games.length === 0) {
        // Fallback to database if live odds fail
        games = await databaseService.getGamesBySport(sportKey);
      }
      if (games && games.length > 0) {
        await redis.set(cacheKey, JSON.stringify(games), { EX: CACHE_TTL });
      }
      return games || [];
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getGamesForSport' });
      return [];
    }
  }

  async getGameDetails(gameId) {
    if (!gameId) return null;
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
        await redis.set(cacheKey, JSON.stringify(game), { EX: CACHE_TTL * 2 });
      }
      return game;
    } catch (error) {
      sentryService.captureError(error, { component: 'games_service', operation: 'getGameDetails' });
      return null;
    }
  }
}

export default new GamesService();
