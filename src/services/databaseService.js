// src/services/databaseService.js - HIGH-FREQUENCY TRADING DATABASE ENGINE
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class InstitutionalDatabaseEngine {
  constructor() {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false }
    });
    console.log('✅ Institutional Database Engine Initialized.');
  }

  // --- Core Methods ---
  async healthCheck() {
    const { error } = await this.client.from('users').select('tg_id', { count: 'exact', head: true });
    if (error) throw new Error(`Database health check failed: ${error.message}`);
  }

  async createOrUpdateUser(telegramUser) {
    const userData = {
      tg_id: telegramUser.id,
      username: telegramUser.username,
      first_name: telegramUser.first_name,
      last_name: telegramUser.last_name,
      last_seen: new Date().toISOString(),
    };
    const { data, error } = await this.client
      .from('users')
      .upsert(userData, { onConflict: 'tg_id' })
      .select()
      .single();
    if (error) {
      sentryService.captureError(error, { component: 'db_user_management' });
      throw new Error('Could not create or update user.');
    }
    return data;
  }
  
  async getMockUserBehavioralData(tgId) {
      return {
          totalBets: 50 + Math.floor(Math.random() * 100),
          betsOnFavoriteTeams: 10 + Math.floor(Math.random() * 20),
          totalOpportunities: 100 + Math.floor(Math.random() * 100),
          ignoredRivalOpportunities: 5 + Math.floor(Math.random() * 15),
          betsWithAdapatedStrategy: 5 + Math.floor(Math.random() * 10),
          betsOnHotStreaks: 10 + Math.floor(Math.random() * 10),
          avgValueOfStreakBets: -0.05 + (Math.random() * 0.1),
          betsOnLosingStreaks: 5 + Math.floor(Math.random() * 10),
      };
  }

  async getHistoricalMatchupData(teamNames) {
    if (!teamNames || teamNames.length === 0) return [];
    
    const { data, error } = await this.client
      .from('games')
      .select('home_team, away_team, bookmakers')
      .or(`home_team.in.(${teamNames.map(t => `"${t}"`).join(',')}),away_team.in.(${teamNames.map(t => `"${t}"`).join(',')})`)
      .lt('commence_time', new Date().toISOString())
      .limit(50);

    if (error) {
        sentryService.captureError(error, { component: 'db_correlation_data' });
        console.error('Error fetching historical matchup data:', error.message);
        return [];
    }
    return data;
  }

  async upsertGamesBatch(gamesBatch) {
    if (!gamesBatch || gamesBatch.length === 0) return;
    const { error } = await this.client.from('games').upsert(gamesBatch, { onConflict: 'game_id' });
    if (error) {
      sentryService.captureError(error, {
        component: 'db_odds_ingestion',
        context: { batchSize: gamesBatch.length },
      });
      console.error('Failed to upsert games batch:', error.message);
    }
  }
}

export default new InstitutionalDatabaseEngine();
