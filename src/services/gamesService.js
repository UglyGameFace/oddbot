// src/services/gamesService.js - INTELLIGENT DATA HUB (FINAL & COMPLETE VERSION)
// This service prioritizes fetching data from the Supabase DB to respect API rate limits.
// It falls back to the live oddsService only when data is stale or unavailable.

import DatabaseService from './databaseService.js';
import OddsService from './oddsService.js';
import sentryService from './sentryService.js';

const STALE_ODDS_THRESHOLD_MINUTES = 5; // How old can DB odds be before we require a live fetch?

class GamesDataService {
  constructor() {
    console.log('✅ Intelligent Games Data Service Initialized.');
  }

  /**
   * Gets a list of sports that have upcoming games, sourced directly from your database.
   * This is extremely fast and uses no API quota.
   */
  async getAvailableSports() {
    try {
      const sports = await DatabaseService.getDistinctSports();
      // Additional filtering to ensure we have a title to display
      return sports.filter(s => s.sport_title);
    } catch (error) {
      sentryService.captureError(error, { component: 'gamesService_getAvailableSports' });
      return [];
    }
  }

  /**
   * The core function. It gets upcoming games for a sport, prioritizing the database.
   * @param {string} sportKey - The key for the sport (e.g., 'americanfootball_nfl').
   * @returns {Promise<Array<object>>} A list of game objects.
   */
  async getGamesForSport(sportKey) {
    try {
      const dbGames = await DatabaseService.getUpcomingGamesBySport(sportKey);
      
      if (dbGames.length > 0 && dbGames[0].last_odds_update) {
        const firstGameUpdate = new Date(dbGames[0].last_odds_update);
        const threshold = new Date(Date.now() - STALE_ODDS_THRESHOLD_MINUTES * 60 * 1000);

        if (firstGameUpdate > threshold) {
          console.log(`⚡️ Using fresh game data from Supabase for ${sportKey}.`);
          return this.formatGamesFromDB(dbGames);
        }
      }

      console.log(`⚠️ DB data for ${sportKey} is stale or missing. Fetching live from Odds Service.`);
      const liveGames = await OddsService.getSportOdds(sportKey);
      
      // Asynchronously update our database with this new data for the next user.
      if (liveGames.length > 0) {
        DatabaseService.upsertGamesBatch(liveGames)
          .then(() => console.log(`✅ Updated stale DB records for ${sportKey}.`))
          .catch(err => sentryService.captureError(err, { component: 'gamesService_async_upsert' }));
      }
      
      return liveGames;

    } catch (error) {
      sentryService.captureError(error, { component: 'gamesService_getGamesForSport' });
      // Final fallback: if anything above fails, try the live API directly.
      return await OddsService.getSportOdds(sportKey);
    }
  }

  /**
   * Fetches the full details of a single game, prioritizing the database.
   * @param {string} eventId - The unique ID of the game.
   * @returns {Promise<object|null>} A single formatted game object.
   */
  async getGameDetails(eventId) {
    try {
        const dbGame = await DatabaseService.getGameDetails(eventId);
        if (dbGame) {
            return this.formatGamesFromDB([dbGame])[0];
        }
        return null; // Should ideally never be hit if the eventId comes from our lists
    } catch (error) {
        sentryService.captureError(error, { component: 'gamesService_getGameDetails' });
        return null;
    }
  }

  /**
   * Utility to ensure the game object structure is consistent, whether from DB or API.
   */
  formatGamesFromDB(dbGames) {
      if (!dbGames || !Array.isArray(dbGames)) return [];
      
      return dbGames.map(game => ({
          id: game.event_id,
          sport_key: game.sport_key,
          sport_title: game.league_key, // We use league_key as the display title
          home_team: game.home_team,
          away_team: game.away_team,
          commence_time: game.commence_time,
          // Extract the bookmaker data from the JSONB field, ensuring it's an array
          bookmakers: game.market_data?.bookmakers || [],
      }));
  }
}

export default new GamesDataService();
