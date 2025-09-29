// src/services/databaseService.js
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;

function buildClient() {
  if (!env.SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Supabase not configured. Database service soft-disabled.');
    return null;
  }
  const client = createClient(env.SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  console.log('✅ Supabase client initialized.');
  return client;
}

let supabaseClient = buildClient();
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms: ${label}`)), ms))]);

class DatabaseService {
  get client() { return supabaseClient || (supabaseClient = buildClient()); }

  // --- Game Functions (Corrected for your schema) ---
  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) return { data: [], error: null };
    try {
      // FIX: Your 'games' table uses 'event_id' as the primary key for conflicts.
      const { data, error } = await withTimeout(
        this.client.from('games').upsert(gamesData, { onConflict: 'event_id' }).select(),
        5000, 'upsertGames'
      );
      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error('Supabase upsert error:', error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'upsertGames' });
      return { data: null, error };
    }
  }

  async getGamesBySport(sportKey) {
    if (!this.client) return [];
    try {
        // FIX: Uses correct column names 'sport_key' and 'commence_time'.
        const { data, error } = await withTimeout(
            this.client.from('games').select('*').eq('sport_key', sportKey).gte('commence_time', new Date().toISOString()).order('commence_time', { ascending: true }),
            5000, 'getGamesBySport'
        );
        if (error) throw error;
        return data ?? [];
    } catch (error) {
        console.error(`Supabase getGamesBySport error for ${sportKey}:`, error.message);
        return [];
    }
  }
  
  async getGameById(eventId) {
    if (!this.client) return null;
    try {
      // FIX: Queries by 'event_id' as per your schema.
      const { data, error } = await withTimeout(
        this.client.from('games').select('*').eq('event_id', eventId).single(),
        4000, 'getGameById'
      );
      if (error && error.code !== 'PGRST116') throw error; // Ignore 'not found' errors
      return data ?? null;
    } catch (error) {
      console.error(`Supabase getGameById error for ${eventId}:`, error.message);
      return null;
    }
  }
  
  async getOddsDateRange() {
    if (!this.client) return { min_date: null, max_date: null };
    try {
      // FIX: This RPC should be configured to run: 
      // SELECT min(commence_time) as min_date, max(commence_time) as max_date FROM games;
      const { data, error } = await withTimeout(this.client.rpc('get_odds_date_range'), 5000, 'getOddsDateRange');
      if (error) throw error;
      return data?.[0] || { min_date: null, max_date: null };
    } catch (error) {
      console.error('Supabase getOddsDateRange error:', error.message);
      return { min_date: null, max_date: null };
    }
  }

  // --- User & Settings Functions (Corrected for your schema) ---
  async findOrCreateUser(telegramId, firstName = '', username = '') {
      if (!this.client) return null;
      try {
          // FIX: Your 'users' table primary key is 'tg_id'.
          let { data: user, error } = await this.client.from('users').select('*').eq('tg_id', telegramId).single();
          if (error && error.code === 'PGRST116') { // Not found
              const { data: newUser, error: insertError } = await this.client.from('users').insert({
                  tg_id: telegramId,
                  first_name: firstName,
                  username: username
              }).select().single();
              if (insertError) throw insertError;
              user = newUser;
          } else if (error) {
              throw error;
          }
          return user;
      } catch (error) {
          console.error(`Supabase findOrCreateUser error for ${telegramId}:`, error.message);
          return null;
      }
  }

  async getUserSettings(telegramId) {
    const user = await this.findOrCreateUser(telegramId);
    // FIX: Settings are stored in the 'preferences' column per your schema.
    return user?.preferences || {};
  }

  async updateUserSettings(telegramId, newSettings) {
      if (!this.client) return null;
      try {
          // FIX: Updates the 'preferences' and 'updated_at' columns.
          const { data, error } = await this.client.from('users')
              .update({ preferences: newSettings, updated_at: new Date().toISOString() })
              .eq('tg_id', telegramId)
              .select()
              .single();
          if (error) throw error;
          return data;
      } catch (error) {
          console.error(`Supabase updateUserSettings error for ${telegramId}:`, error.message);
          return null;
      }
  }

  // --- Utility Functions (Corrected) ---
  async getDistinctSports() {
      if (!this.client) return [];
      try {
          // FIX: This now correctly calls an RPC to get distinct sports from your 'games' table.
          // This RPC should be configured to run: SELECT DISTINCT sport_key, sport_title FROM games WHERE sport_title IS NOT NULL;
          const { data, error } = await this.client.rpc('get_distinct_sports');
          if (error) throw error;
          return data ?? [];
      } catch (error) {
          console.error('Supabase getDistinctSports error:', error.message);
          return [];
      }
  }

  async getSportGameCounts() {
    if (!this.client) return [];
    try {
      // This RPC should be configured to run: SELECT COALESCE(sport_title, 'Unknown/Other') as sport_title, count(*) as game_count FROM games GROUP BY sport_title;
      const { data, error } = await withTimeout(this.client.rpc('get_sport_game_counts'), 5000, 'getSportGameCounts');
      if (error) throw error;
      return data ?? [];
    } catch (error) {
      console.error('Supabase getSportGameCounts error:', error.message);
      return [];
    }
  }
}

export default new DatabaseService();
