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

  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) return { data: [], error: null };
    try {
      const { data, error } = await withTimeout(
        this.client.from('games').upsert(gamesData, { onConflict: 'id' }).select(),
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

  async getDistinctSports() {
    if (!this.client) return [];
    try {
      const { data, error } = await withTimeout(this.client.rpc('get_distinct_sports'), 4000, 'getDistinctSports');
      if (error) throw error;
      return data ?? [];
    } catch (error) {
      try {
        const { data: fbData, error: fbErr } = await withTimeout(
          this.client.from('games').select('sport_key,sport_title').neq('sport_key', null).neq('sport_title', null).order('sport_title', { ascending: true }),
          4000, 'getDistinctSports-fallback'
        );
        if (fbErr) throw fbErr;
        return fbData ?? [];
      } catch (fbError) {
        console.error('Supabase getDistinctSports error:', fbError.message);
        sentryService.captureError(fbError, { component: 'database_service', operation: 'getDistinctSports' });
        return [];
      }
    }
  }

  async getGamesBySport(sportKey) {
    if (!this.client) return [];
    try {
      const { data, error } = await withTimeout(
        this.client.from('games').select('*').eq('sport_key', sportKey).gte('commence_time', new Date().toISOString()).order('commence_time', { ascending: true }),
        5000, 'getGamesBySport'
      );
      if (error) throw error;
      return data ?? [];
    } catch (error) {
      console.error(`Supabase getGamesBySport error for ${sportKey}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'getGamesBySport', sportKey });
      return [];
    }
  }

  async getGameById(gameId) {
    if (!this.client) return null;
    try {
      const { data, error } = await withTimeout(
        this.client.from('games').select('*').eq('id', gameId).single(),
        4000, 'getGameById'
      );
      if (error && error.code !== 'PGRST116') throw error;
      return data ?? null;
    } catch (error) {
      console.error(`Supabase getGameById error for ${gameId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'getGameById', gameId });
      return null;
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
      sentryService.captureError(error, { component: 'database_service', operation: 'getSportGameCounts' });
      return [];
    }
  }
}

export default new DatabaseService();
