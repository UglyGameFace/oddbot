// src/services/gamesService.js

import databaseService from './databaseService.js';
import oddsService from './oddsService.js';
import redisClient from './redisService.js';
import { sentryService } from './sentryService.js';
import env from '../config/env.js';

const CACHE_TTL = env.CACHE_TTL_DEFAULT || 300; // 5 minutes default

class GamesService {

  /**
   * Gets a list of all currently available sports.
   * Strategy: Redis -> Database -> Live API Fallback
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
      // 1. Primary Source: Database
      let sports = await databaseService.getDistinctSports();

      // 2. Fallback Source: Live Odds API
      if (!sports || sports.length === 0) {
        console.warn('No sports found in DB, attempting live API fallback...');
        // This is a simplified version; a real implementation might need to fetch all sports from the API
        const liveGames = await oddsService.getSportOdds('upcoming'); 
        if (liveGames && liveGames.length > 0) {
            const sportSet = new Map();
            liveGames.forEach(g => sportSet.set(g.sport_key, g.sport_title));
            sports = Array.from(sportSet, ([sport_key, sport_title]) => ({ sport_key, sport_title }));
        }
      }

      if (sports && sports.length > 0) {
        await redis.set(cacheKey, JSON.stringify(sports), 'EX', CACHE_TTL);
      }
      
      return sports || [];
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
      // 1. Primary Source: Database
      let games = await databaseService.getGamesBySport(sportKey);

      // 2. Fallback Source: Live Odds API
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

  /**
   * Gets the full details for a single game by its ID.
   * Strategy: Redis -> Database (No API fallback for specific ID lookups)
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
      // For specific ID lookups, the database is the only source of truth.
      const game = await databaseService.getGameById(gameId);

      if (game) {
        await redis.set(cacheKey, JSON.stringify(game), 'EX', CACHE_TTL * 2); // Cache details for longer
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
