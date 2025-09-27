// src/services/databaseService.js

import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

let supabaseClient = null;

/**
 * Initializes and returns a singleton Supabase client instance.
 * This ensures we don't create multiple connections.
 */
function getSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }
  
  // Use the SUPABASE_ANON_KEY as it's the standard for client-side access.
  // The SERVICE_KEY should only be used in highly secure backend processes if needed.
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error('❌ Supabase URL or Anon Key is not configured. Database service will be disabled.');
    // Return a mock client that will always fail, preventing crashes elsewhere.
    return {
        from: () => ({
            select: () => ({ error: { message: 'Supabase not configured' } }),
            upsert: () => ({ error: { message: 'Supabase not configured' } }),
        })
    };
  }
  
  supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase client initialized.');
  return supabaseClient;
}


class DatabaseService {
  constructor() {
    this.supabase = getSupabaseClient();
  }

  /**
   * Performs an "upsert" operation on the 'games' table.
   * It inserts new games or updates existing ones based on their unique 'id'.
   * @param {Array<Object>} gamesData - An array of game objects from the odds service.
   * @returns {Object} An object containing the upserted data and any potential error.
   */
  async upsertGames(gamesData) {
    if (!gamesData || gamesData.length === 0) {
      return { data: [], error: null };
    }
    
    try {
      const { data, error } = await this.supabase
        .from('games')
        .upsert(gamesData, { onConflict: 'id' })
        .select();
        
      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error('Supabase upsert error:', error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'upsertGames' });
      return { data: null, error };
    }
  }

  /**
   * Fetches a list of all distinct sports available in the 'games' table.
   * @returns {Array<Object>} An array of objects, each with sport_key and sport_title.
   */
  async getDistinctSports() {
    try {
      // This RPC call is more efficient than a large SELECT DISTINCT query.
      // You need to create this function in your Supabase SQL editor.
      const { data, error } = await this.supabase.rpc('get_distinct_sports');
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Supabase getDistinctSports error:', error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'getDistinctSports' });
      return [];
    }
  }
  
  /**
   * Fetches all upcoming games for a specific sport key.
   * @param {string} sportKey - The sport key to filter by (e.g., 'basketball_nba').
   * @returns {Array<Object>} An array of game objects.
   */
  async getGamesBySport(sportKey) {
    try {
        const { data, error } = await this.supabase
            .from('games')
            .select('*')
            .eq('sport_key', sportKey)
            // Filter for games that haven't started yet
            .gte('commence_time', new Date().toISOString()) 
            .order('commence_time', { ascending: true });
        
        if (error) throw error;
        return data;
    } catch (error) {
        console.error(`Supabase getGamesBySport error for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'database_service', operation: 'getGamesBySport', sportKey });
        return [];
    }
  }
  
  /**
   * Fetches the detailed information for a single game by its ID.
   * @param {string} gameId - The unique ID of the game.
   * @returns {Object|null} A single game object or null if not found.
   */
  async getGameById(gameId) {
    try {
        const { data, error } = await this.supabase
            .from('games')
            .select('*')
            .eq('id', gameId)
            .single(); // .single() is efficient for fetching one row
        
        if (error && error.code !== 'PGRST116') throw error; // Ignore "range not found" errors
        return data;
    } catch (error) {
        console.error(`Supabase getGameById error for ${gameId}:`, error.message);
        sentryService.captureError(error, { component: 'database_service', operation: 'getGameById', gameId });
        return null;
    }
  }
  
  /**
   * Gets the count of games for each sport. Required for the /tools command.
   * @returns {Array<Object>} An array of objects with sport_title and game_count.
   */
  async getSportGameCounts() {
      try {
        const { data, error } = await this.supabase.rpc('get_sport_game_counts');
        if (error) throw error;
        return data;
      } catch (error) {
          console.error('Supabase getSportGameCounts error:', error.message);
          sentryService.captureError(error, { component: 'database_service', operation: 'getSportGameCounts' });
          return [];
      }
  }
}

// Export a single, memoized instance of the service
const databaseServiceInstance = new DatabaseService();
export default databaseServiceInstance;
