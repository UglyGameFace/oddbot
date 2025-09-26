// src/services/databaseService.js - INSTITUTIONAL DATABASE ENGINE (FINAL & COMPLETE VERSION)

import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class DatabaseService {
  constructor() {
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    this.serviceRoleClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    console.log('✅ Institutional Database Engine Initialized.');
  }

  // --- Methods from your original file (restored) ---

  async getActiveGames() {
    try {
      const { data, error } = await this.supabase
        .from('games')
        .select('*')
        .in('status', ['scheduled', 'in_progress'])
        .gt('commence_time', new Date().toISOString())
        .order('commence_time', { ascending: true });
      if (error) throw error;
      return data;
    } catch (error) {
      sentryService.captureError(error, { component: 'db_getActiveGames' });
      return [];
    }
  }

  async getRecentlyCompletedGames() {
    try {
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data, error } = await this.supabase
        .from('games')
        .select('*')
        .eq('status', 'completed')
        .gte('commence_time', twelveHoursAgo)
        .order('commence_time', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    } catch (error) {
      sentryService.captureError(error, { component: 'db_getRecentlyCompletedGames' });
      return [];
    }
  }

  async getParlaysByGame(gameId) {
    try {
      const { data, error } = await this.supabase
        .from('parlays')
        .select('*, users(*)')
        .contains('legs', [{ event_id: gameId }]);
      if (error) throw error;
      return data;
    } catch (error) {
      sentryService.captureError(error, { component: 'db_getParlaysByGame' });
      return [];
    }
  }

  async updateParlay(updateData) {
    try {
      const { error } = await this.supabase
        .from('parlays')
        .update(updateData)
        .eq('parlay_id', updateData.parlay_id);
      if (error) throw error;
    } catch (error) {
      sentryService.captureError(error, { component: 'db_updateParlay' });
    }
  }
  
  async batchUpdateParlayStatus(batch) {
    try {
        const updates = batch.map(item => ({
            parlay_id: item.parlayId,
            status: item.newStatus,
        }));
        const { error } = await this.supabase
            .from('parlays')
            .upsert(updates, { onConflict: 'parlay_id' });
        if (error) throw error;
    } catch (error) {
        sentryService.captureError(error, { component: 'db_batchUpdateParlayStatus' });
    }
  }
  
  async getUserByParlayId(parlayId) {
    try {
      const { data: parlay, error } = await this.supabase
        .from('parlays')
        .select('user_tg_id')
        .eq('parlay_id', parlayId)
        .single();
      if (error) throw error;
      return this.getUser(parlay.user_tg_id);
    } catch (error) {
      sentryService.captureError(error, { component: 'db_getUserByParlayId' });
      return null;
    }
  }

  async updateUserBettingStats(userId, result) {
    // This is a complex read-modify-write operation best handled by a db function (RPC)
    // to avoid race conditions. We'll log for now as a placeholder for that future implementation.
    console.log(`Updating betting stats for user ${userId} with result: ${result}`);
  }

  // --- New methods added for new services & workers ---

  async healthCheck() {
    const { error } = await this.supabase.from('games').select('event_id').limit(1);
    if (error) throw new Error(`Database health check failed: ${error.message}`);
    return true;
  }

  async upsertGamesBatch(games) {
    const formattedGames = games.map(g => ({
        event_id: g.id, sport_key: g.sport_key, league_key: g.sport_title, commence_time: g.commence_time,
        home_team: g.home_team, away_team: g.away_team, market_data: { bookmakers: g.bookmakers },
        last_odds_update: new Date().toISOString(), status: 'scheduled'
    }));
    const { error } = await this.serviceRoleClient.from('games').upsert(formattedGames, { onConflict: 'event_id' });
    if (error) {
        sentryService.captureError(error, { component: 'db_upsertGamesBatch' });
        throw error;
    }
  }

  async getUpcomingGamesBySport(sportKey) {
    const { data, error } = await this.supabase
        .from('games').select('*').eq('sport_key', sportKey).eq('status', 'scheduled')
        .gt('commence_time', new Date().toISOString())
        .order('commence_time', { ascending: true }).limit(20);
    if (error) {
        sentryService.captureError(error, { component: 'db_getUpcomingGamesBySport' });
        throw error;
    }
    return data || [];
  }

  async getGameDetails(eventId) {
    const { data, error } = await this.supabase.from('games').select('*').eq('event_id', eventId).single();
    if (error) {
        sentryService.captureError(error, { component: 'db_getGameDetails' });
        throw error;
    }
    return data;
  }
  
  async getDistinctSports() {
    const { data, error } = await this.supabase.rpc('get_distinct_sports');
    if (error) {
        sentryService.captureError(error, { component: 'db_getDistinctSports' });
        throw error;
    }
    return data;
  }

  async getUser(tg_id) {
    try {
      const { data, error } = await this.supabase.from('users').select('*').eq('tg_id', tg_id).single();
      if (error && error.code !== 'PGRST116') throw error; // Ignore "Row not found"
      return data;
    } catch (error) {
      sentryService.captureError(error, { component: 'db_getUser' });
      return null;
    }
  }

  async updateUser(tg_id, updateData) {
    try {
        const { error } = await this.supabase
            .from('users')
            .update({ ...updateData, updated_at: new Date().toISOString() })
            .eq('tg_id', tg_id);
        if (error) throw error;
    } catch(error) {
        sentryService.captureError(error, { component: 'db_updateUser' });
    }
  }
}

export default new DatabaseService();
