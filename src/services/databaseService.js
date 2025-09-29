// src/services/databaseService.js - FINAL VERSION
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';

const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;

// --- VERIFIED FIX: Comprehensive fallback sports list ---
const COMPREHENSIVE_FALLBACK_SPORTS = [
    { sport_key: 'americanfootball_nfl', sport_title: 'NFL' },
    { sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF' },
    { sport_key: 'basketball_nba', sport_title: 'NBA' },
    { sport_key: 'basketball_ncaab', sport_title: 'NCAAB' },
    { sport_key: 'baseball_mlb', sport_title: 'MLB' },
    { sport_key: 'icehockey_nhl', sport_title: 'NHL' },
    { sport_key: 'soccer_usa_mls', sport_title: 'MLS' },
    { sport_key: 'soccer_epl', sport_title: 'EPL' },
    { sport_key: 'soccer_uefa_champs_league', sport_title: 'Champions League' },
    { sport_key: 'mma_mixed_martial_arts', sport_title: 'MMA' },
    { sport_key: 'golf_pga_tour', sport_title: 'PGA Tour' },
    { sport_key: 'tennis_atp_wta', sport_title: 'Tennis' },
    { sport_key: 'basketball_wnba', sport_title: 'WNBA' },
];


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
      const { data, error } = await withTimeout(
        this.client.from('games').select('*').eq('event_id', eventId).single(),
        4000, 'getGameById'
      );
      if (error && error.code !== 'PGRST116') throw error;
      return data ?? null;
    } catch (error) {
      console.error(`Supabase getGameById error for ${eventId}:`, error.message);
      return null;
    }
  }
  
  async getOddsDateRange() {
    if (!this.client) return { min_date: null, max_date: null };
    try {
      const { data: minData, error: minError } = await this.client.from('games').select('commence_time').order('commence_time', { ascending: true }).limit(1);
      const { data: maxData, error: maxError } = await this.client.from('games').select('commence_time').order('commence_time', { ascending: false }).limit(1);
      if (minError || maxError) throw minError || maxError;
      return { min_date: minData?.[0]?.commence_time || null, max_date: maxData?.[0]?.commence_time || null };
    } catch (error) {
      console.error('Supabase getOddsDateRange error:', error.message);
      return { min_date: null, max_date: null };
    }
  }

  async findOrCreateUser(telegramId, firstName = '', username = '') {
      if (!this.client) return null;
      try {
          let { data: user, error } = await this.client.from('users').select('*').eq('tg_id', telegramId).single();
          if (error && error.code === 'PGRST116') {
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
    return user?.preferences || {};
  }

  async updateUserSettings(telegramId, newSettings) {
      if (!this.client) return null;
      try {
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

  async getDistinctSports() {
      if (!this.client) return COMPREHENSIVE_FALLBACK_SPORTS;
      try {
          const { data, error } = await this.client.from('games').select('sport_key, sport_title');
          if (error) throw error;
          const uniqueSportsMap = new Map();
          (data || []).forEach(game => {
            if (game.sport_key && game.sport_title) {
                uniqueSportsMap.set(game.sport_key, { 
                  sport_key: game.sport_key,
                  sport_title: game.sport_title 
                });
            }
          });
          
          if (uniqueSportsMap.size === 0) {
            console.log('🔄 Database empty, returning comprehensive default sports list.');
            return COMPREHENSIVE_FALLBACK_SPORTS;
          }
          
          return Array.from(uniqueSportsMap.values());
      } catch (error) {
          console.error('Supabase getDistinctSports error:', error.message);
          console.log('🔄 Error fetching from DB, returning comprehensive default sports list.');
          return COMPREHENSIVE_FALLBACK_SPORTS;
      }
  }

  async getSportGameCounts() {
    if (!this.client) return [];
    try {
      const { data, error } = await this.client.from('games').select('sport_title, commence_time');
      if (error) throw error;
      const counts = (data || []).reduce((acc, { sport_title }) => {
          const title = sport_title || 'Unknown/Other';
          acc[title] = (acc[title] || 0) + 1;
          return acc;
      }, {});
      return Object.entries(counts).map(([title, count]) => ({ sport_title: title, game_count: count }));
    } catch (error) {
      console.error('Supabase getSportGameCounts error:', error.message);
      return [];
    }
  }

  async getActiveGames() {
    if (!this.client) return [];
    try {
      const { data, error } = await this.client
        .from('games')
        .select('*')
        .in('status', ['scheduled', 'live'])
        .gte('commence_time', new Date().toISOString());
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('getActiveGames error:', error.message);
      return [];
    }
  }

  async getRecentlyCompletedGames() {
    if (!this.client) return [];
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await this.client
        .from('games')
        .select('*')
        .eq('status', 'completed')
        .gte('commence_time', twentyFourHoursAgo);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('getRecentlyCompletedGames error:', error.message);
      return [];
    }
  }
}

export default new DatabaseService();
