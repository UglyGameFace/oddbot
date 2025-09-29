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
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  console.log('✅ Supabase client initialized.');
  return client;
}

let supabaseClient = buildClient();

/**
 * Cancellable timeout wrapper that aborts the underlying HTTP request.
 * Pass a builder factory that receives an AbortSignal and returns a Supabase promise.
 */
async function withAbortTimeout(buildRequest, ms, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const { data, error } = await buildRequest(ac.signal);
    if (error) throw error;
    return data ?? null;
  } catch (err) {
    // Normalize aborted errors into a clean timeout message
    if (String(err?.message || err).toLowerCase().includes('aborted')) {
      throw new Error(`Timeout ${ms}ms: ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class DatabaseService {
  get client() {
    return supabaseClient || (supabaseClient = buildClient());
  }

  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) return { data: [], error: null };
    try {
      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .upsert(gamesData, { onConflict: 'event_id' })
            .abortSignal(signal)
            .select(),
        5000,
        'upsertGames'
      );
      return { data, error: null };
    } catch (error) {
      console.error('Supabase upsert error:', error?.message || error);
      try { sentryService?.captureError?.(error, { component: 'database_service', operation: 'upsertGames' }); } catch {}
      return { data: null, error };
    }
  }

  async getGamesBySport(sportKey) {
    if (!this.client) return [];
    try {
      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('*')
            .eq('sport_key', sportKey)
            .gte('commence_time', new Date().toISOString())
            .order('commence_time', { ascending: true })
            .abortSignal(signal),
        5000,
        'getGamesBySport'
      );
      return data ?? [];
    } catch (error) {
      console.error(`Supabase getGamesBySport error for ${sportKey}:`, error?.message || error);
      return [];
    }
  }

  async getGameById(eventId) {
    if (!this.client) return null;
    try {
      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('*')
            .eq('event_id', eventId)
            .maybeSingle()
            .abortSignal(signal),
        4000,
        'getGameById'
      );
      return data ?? null;
    } catch (error) {
      console.error(`Supabase getGameById error for ${eventId}:`, error?.message || error);
      return null;
    }
  }

  async getOddsDateRange() {
    if (!this.client) return { min_date: null, max_date: null };
    try {
      const minData = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('commence_time')
            .order('commence_time', { ascending: true })
            .limit(1)
            .abortSignal(signal),
        3000,
        'getOddsDateRange:min'
      );
      const maxData = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('commence_time')
            .order('commence_time', { ascending: false })
            .limit(1)
            .abortSignal(signal),
        3000,
        'getOddsDateRange:max'
      );
      return {
        min_date: minData?.[0]?.commence_time || null,
        max_date: maxData?.[0]?.commence_time || null,
      };
    } catch (error) {
      console.error('Supabase getOddsDateRange error:', error?.message || error);
      return { min_date: null, max_date: null };
    }
  }

  async findOrCreateUser(telegramId, firstName = '', username = '') {
    if (!this.client) return null;
    try {
      // maybeSingle avoids PGRST116 when no rows
      let user = await withAbortTimeout(
        (signal) =>
          this.client
            .from('users')
            .select('*')
            .eq('tg_id', telegramId)
            .maybeSingle()
            .abortSignal(signal),
        4000,
        'findOrCreateUser:select'
      );

      if (!user) {
        user = await withAbortTimeout(
          (signal) =>
            this.client
              .from('users')
              .insert({
                tg_id: telegramId,
                first_name: firstName,
                username: username,
              })
              .abortSignal(signal)
              .select()
              .maybeSingle(),
          4000,
          'findOrCreateUser:insert'
        );
      }

      return user ?? null;
    } catch (error) {
      console.error(`Supabase findOrCreateUser error for ${telegramId}:`, error?.message || error);
      return null;
    }
  }

  async getUserSettings(telegramId) {
    const user = await this.findOrCreateUser(telegramId);
    return user?.preferences || {};
  }

  async updateUserSettings(telegramId, newSettings) {
    if (!this.client) return null;
    try {
      // Ensure the user exists
      await this.findOrCreateUser(telegramId);

      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('users')
            .update({
              preferences: newSettings,
              updated_at: new Date().toISOString(),
            })
            .eq('tg_id', telegramId)
            .abortSignal(signal)
            .select()
            .maybeSingle(),
        4000,
        'updateUserSettings'
      );
      return data ?? null;
    } catch (error) {
      console.error(`Supabase updateUserSettings error for ${telegramId}:`, error?.message || error);
      return null;
    }
  }

  async getDistinctSports() {
    if (!this.client) return [];
    try {
      // Pull relevant columns and de-duplicate in code
      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('sport_key, sport_title')
            .abortSignal(signal),
        4000,
        'getDistinctSports'
      );

      const unique = new Map();
      (data || []).forEach((row) => {
        if (row?.sport_key && row?.sport_title && !unique.has(row.sport_key)) {
          unique.set(row.sport_key, {
            sport_key: row.sport_key,
            sport_title: row.sport_title,
          });
        }
      });
      return Array.from(unique.values());
    } catch (error) {
      console.error('Supabase getDistinctSports error:', error?.message || error);
      return [];
    }
  }

  async getSportGameCounts() {
    if (!this.client) return [];
    try {
      const data = await withAbortTimeout(
        (signal) =>
          this.client
            .from('games')
            .select('sport_title')
            .abortSignal(signal),
        4000,
        'getSportGameCounts'
      );

      const counts = (data || []).reduce((acc, { sport_title }) => {
        const title = sport_title || 'Unknown/Other';
        acc[title] = (acc[title] || 0) + 1;
        return acc;
      }, {});

      return Object.entries(counts).map(([sport_title, game_count]) => ({
        sport_title,
        game_count,
      }));
    } catch (error) {
      console.error('Supabase getSportGameCounts error:', error?.message || error);
      return [];
    }
  }
}

export default new DatabaseService();
