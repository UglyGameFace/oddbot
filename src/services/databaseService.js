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

  async getOddsDateRange() {
    if (!this.client) return { min: null, max: null };
    try {
      // This RPC should be configured to run: 
      // SELECT min(start_time) as min_date, max(start_time) as max_date FROM games;
      const { data, error } = await withTimeout(this.client.rpc('get_odds_date_range'), 5000, 'getOddsDateRange');
      if (error) throw error;
      return data?.[0] || { min_date: null, max_date: null };
    } catch (error) {
      console.error('Supabase getOddsDateRange error:', error.message);
      return { min_date: null, max_date: null };
    }
  }

  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) return { data: [], error: null };
    try {
      // FIX: Changed onConflict to use 'game_id_provider' which is the correct unique column from your schema.
      const { data, error } = await withTimeout(
        this.client.from('games').upsert(gamesData, { onConflict: 'game_id_provider' }).select(),
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
        // FIX: Changed 'sport_key' to 'sport' and 'commence_time' to 'start_time' to match your schema.
        const { data, error } = await withTimeout(
            this.client.from('games').select('*').eq('sport', sportKey).gte('start_time', new Date().toISOString()).order('start_time', { ascending: true }),
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
      // FIX: Changed lookup column from 'event_id' to 'game_id_provider' to match the schema.
      const { data, error } = await withTimeout(
        this.client.from('games').select('*').eq('game_id_provider', eventId).single(),
        4000, 'getGameById'
      );
      if (error && error.code !== 'PGRST116') throw error;
      return data ?? null;
    } catch (error) {
      console.error(`Supabase getGameById error for ${eventId}:`, error.message);
      return null;
    }
  }
  
  async findOrCreateUser(telegramId, firstName = '', username = '') {
      if (!this.client) return null;
      try {
          // FIX: Changed 'tg_id' to 'telegram_id' to match your 'users' table schema.
          let { data: user, error } = await this.client.from('users').select('*').eq('telegram_id', telegramId).single();
          if (error && error.code === 'PGRST116') {
              const { data: newUser, error: insertError } = await this.client.from('users').insert({
                  telegram_id: telegramId,
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
    // FIX: Changed 'preferences' to 'settings' to match your 'users' table schema.
    return user?.settings || {};
  }

  async updateUserSettings(telegramId, newSettings) {
      if (!this.client) return null;
      try {
          // FIX: Changed 'preferences' to 'settings' and 'tg_id' to 'telegram_id'.
          const { data, error } = await this.client.from('users')
              .update({ settings: newSettings, updated_at: new Date().toISOString() })
              .eq('telegram_id', telegramId)
              .select()
              .single();
          if (error) throw error;
          return data;
      } catch (error) {
          console.error(`Supabase updateUserSettings error for ${telegramId}:`, error.message);
          return null;
      }
  }

  async getDistinctSports() {
      if (!this.client) return [];
      try {
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
