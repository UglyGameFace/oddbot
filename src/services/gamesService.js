// src/services/gamesService.js - INTELLIGENT DATA HUB (FINAL VERSION)
// Prioritizes fetching data from Supabase to respect API rate limits.

import DatabaseService from './databaseService.js';
import OddsService from './oddsService.js';
import sentryService from './sentryService.js';

const STALE_ODDS_THRESHOLD_MINUTES = 5;

class GamesDataService {
  constructor() {
    console.log('✅ Intelligent Games Data Service Initialized.');
  }

  /**
   * Gets a list of sports with upcoming games directly from the database.
   */
  async getAvailableSports() {
    try {
      return await DatabaseService.getDistinctSports();
    } catch (error) {
      sentryService.captureError(error, { component: 'gamesService_getAvailableSports' });
      return [];
    }
  }

  /**
   * Gets games for a sport, prioritizing the database and falling back to the live API.
   */
  async getGamesForSport(sportKey) {
    try {
      const dbGames = await DatabaseService.getUpcomingGamesBySport(sportKey);
      
      if (dbGames.length > 0) {
        const firstGameUpdate = new Date(dbGames[0].last_odds_update);
        const threshold = new Date(Date.now() - STALE_ODDS_THRESHOLD_MINUTES * 60 * 1000);
        if (firstGameUpdate > threshold) {
          console.log(`⚡️ Using fresh game data from Supabase for ${sportKey}.`);
          return this.formatGamesFromDB(dbGames);
        }
      }

      console.log(`⚠️ DB data for ${sportKey} is stale. Fetching live from Odds Service.`);
      const liveGames = await OddsService.getSportOdds(sportKey);
      
      if (liveGames.length > 0) {
        DatabaseService.upsertGamesBatch(liveGames).catch(err => sentryService.captureError(err));
      }
      return liveGames;

    } catch (error) {
      sentryService.captureError(error, { component: 'gamesService_getGamesForSport' });
      return await OddsService.getSportOdds(sportKey);
    }
  }

  /**
   * Fetches the full details of a single game from the database.
   */
  async getGameDetails(eventId) {
      const dbGame = await DatabaseService.getGameDetails(eventId);
      return this.formatGamesFromDB([dbGame])[0];
  }

  /**
   * Formats database game records into a consistent object structure.
   */
  formatGamesFromDB(dbGames) {
      return dbGames.map(game => ({
          id: game.event_id, sport_key: game.sport_key, sport_title: game.league_key,
          home_team: game.home_team, away_team: game.away_team, commence_time: game.commence_time,
          bookmakers: game.market_data?.bookmakers || [],
      }));
  }
}

export default new GamesDataService();
