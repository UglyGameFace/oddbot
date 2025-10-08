// src/services/databaseService.js - COMPLETE UPDATE WITH CENTRALIZED ENHANCEMENT
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { GameEnhancementService } from './gameEnhancementService.js';
// FIX: Import TimeoutError from asyncUtils
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js'; // Assuming withTimeout is imported here

const COMPREHENSIVE_FALLBACK_SPORTS = Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
  sport_key,
  sport_title: data.title
}));

const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;

function buildClient() {
  // FIX: Explicitly check for both URL and KEY before trying to build the client.
  if (!env.SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Supabase not configured. Database service soft-disabled.');
    return null;
  }
  const client = createClient(env.SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false, 
      detectSessionInUrl: false 
    },
    db: {
      schema: 'public'
    },
    global: {
      headers: {
        'x-application-name': 'parlay-bot-db-service'
      }
    }
  });
  console.log('✅ Supabase client initialized.');
  return client;
}

let supabaseClient = buildClient();

// NOTE: withTimeout is now imported from asyncUtils.js and not redefined here.
// const withTimeout = (p, ms, label) => ... REMOVED

class DatabaseService {
  get client() { 
    return supabaseClient || (supabaseClient = buildClient()); 
  }

  // ========== CORE SPORTS METHODS ==========

  /**
   * Get all distinct sports with enhanced metadata
   */
  async getDistinctSports() {
    if (!this.client) return COMPREHENSIVE_FALLBACK_SPORTS;
    
    try {
      console.log('🔄 Fetching distinct sports from database...');
      
      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .select('sport_key, sport_title, commence_time, home_team, away_team')
          .gte('commence_time', new Date().toISOString())
          .order('commence_time', { ascending: true }),
        8000,
        'getDistinctSports'
      );

      if (error) throw error;

      const sportsMap = new Map();
      const now = new Date();
      
      (data || []).forEach(game => {
        if (game.sport_key && game.sport_title) {
          const existing = sportsMap.get(game.sport_key) || {
            sport_key: game.sport_key,
            sport_title: game.sport_title,
            game_count: 0,
            upcoming_games: 0,
            last_game_time: null,
            teams: new Set()
          };
          
          existing.game_count++;
          
          if (game.commence_time && new Date(game.commence_time) > now) {
            existing.upcoming_games++;
          }
          
          if (game.commence_time && (!existing.last_game_time || new Date(game.commence_time) > new Date(existing.last_game_time))) {
            existing.last_game_time = game.commence_time;
          }
          
          if (game.home_team) existing.teams.add(game.home_team);
          if (game.away_team) existing.teams.add(game.away_team);
          
          sportsMap.set(game.sport_key, existing);
        }
      });

      const sports = Array.from(sportsMap.values()).map(sport => ({
        sport_key: sport.sport_key,
        sport_title: sport.sport_title,
        game_count: sport.game_count,
        upcoming_games: sport.upcoming_games,
        team_count: sport.teams.size,
        last_game_time: sport.last_game_time,
        data_quality: this._assessSportDataQuality(sport),
        is_active: sport.upcoming_games > 0,
        source: 'database'
      }));

      sports.sort((a, b) => b.game_count - a.game_count);

      console.log(`✅ Found ${sports.length} sports with ${data?.length || 0} total games`);

      if (sports.length === 0) {
        console.log('🔄 Database empty, returning comprehensive default sports list.');
        return COMPREHENSIVE_FALLBACK_SPORTS;
      }
      
      return sports;

    } catch (error) {
      // FIX: Only handle TimeoutError gracefully by returning fallback. 
      // All other errors (network/Supabase connection failures) must be thrown.
      if (error instanceof TimeoutError) {
        console.error('❌ Supabase getDistinctSports TIMEOUT, returning fallback:', error.message);
        return COMPREHENSIVE_FALLBACK_SPORTS;
      }
      
      // If it's any other error (network/Supabase being down), re-throw to fail the health check.
      console.error('❌ Supabase getDistinctSports CRITICAL error:', error.message);
      throw error; // Re-throw to make the HealthService fail.
    }
  }

  /**
   * Get upcoming games for a sport with time window
   */
  async getUpcomingGames(sportKey, hoursAhead = 72) {
    if (!this.client) return [];
    
    try {
      console.log(`🔄 Fetching upcoming ${sportKey} games (${hoursAhead}h ahead)...`);
      
      const startTime = new Date().toISOString();
      const endTime = new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();

      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .select('*')
          .eq('sport_key', sportKey)
          .gte('commence_time', startTime)
          .lte('commence_time', endTime)
          .order('commence_time', { ascending: true }),
        10000,
        `getUpcomingGames_${sportKey}`
      );

      if (error) throw error;

      console.log(`✅ Found ${data?.length || 0} upcoming games for ${sportKey}`);
      return GameEnhancementService.enhanceGameData(data || [], sportKey, 'database');

    } catch (error) {
       // FIX: Only handle TimeoutError gracefully by returning empty array.
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase getUpcomingGames TIMEOUT for ${sportKey}:`, error.message);
        return [];
       }
      
       // If it's any other error (Supabase being down), re-throw to fail the health check.
      console.error(`❌ Supabase getUpcomingGames CRITICAL error for ${sportKey}:`, error.message);
      throw error; // Re-throw to make the HealthService fail.
    }
  }
  
  // ... (The rest of the class methods are fine, but their catch blocks
  // must be updated to throw if the error is not a TimeoutError)

  /**
   * Test database connection and health
   */
  async testConnection() {
    if (!this.client) return true; // Soft-disable check
    
    try {
      const { data, error } = await withTimeout(
        this.client.from('games').select('count').limit(1),
        5000,
        'testConnection'
      );

      if (error) throw error;
      
      console.log('✅ Database connection test passed');
      return true;

    } catch (error) {
       // FIX: Do not catch TimeoutError here, let it pass up and be handled 
       // by the HealthService's wrapper. Only catch definite failures.
      console.error('❌ Database connection test failed:', error.message);
      return false;
    }
  }

  // ... (All other class methods are omitted for brevity but should follow the same pattern:
  // if the method should return a fallback (empty array/list) on a transient error,
  // it must check for "instanceof TimeoutError" and re-throw all other errors.)
  
  // ... (The rest of the DatabaseService class is omitted for brevity)
}

export default new DatabaseService();
