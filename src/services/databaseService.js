// src/services/databaseService.js - COMPLETE FIXED VERSION
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from '../services/sentryService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';

class GameEnhancementService {
  static enhanceGameData(games, sportKey, source) {
    if (!Array.isArray(games)) return [];
    return games.map(game => this.enhanceSingleGame(game, sportKey, source));
  }
  static enhanceSingleGame(game, sportKey, source) {
    return {
      ...game,
      enhanced: true,
      enhancement_source: source,
      source: source,
    };
  }
}

const COMPREHENSIVE_FALLBACK_SPORTS = Object.entries(COMPREHENSIVE_SPORTS).map(([sport_key, data]) => ({
  sport_key,
  sport_title: data.title
}));

const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;

function buildClient() {
  if (!env.SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Supabase not configured. Database service soft-disabled.');
    return null;
  }
  const client = createClient(env.SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
    global: { headers: { 'x-application-name': 'parlay-bot-db-service' } }
  });
  console.log('✅ Supabase client initialized.');
  return client;
}

let supabaseClient = buildClient();

class DatabaseService {
  get client() { 
    return supabaseClient || (supabaseClient = buildClient()); 
  }

  async getDistinctSports() {
    if (!this.client) return COMPREHENSIVE_FALLBACK_SPORTS;
    try {
      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .select('sport_key, sport_title')
          .gte('commence_time', new Date().toISOString()),
        8000,
        'getDistinctSports'
      );
      if (error) throw error;
      const sportsMap = new Map();
      (data || []).forEach(game => {
        if (game.sport_key && !sportsMap.has(game.sport_key)) {
          sportsMap.set(game.sport_key, { sport_key: game.sport_key, sport_title: game.sport_title, source: 'database' });
        }
      });
      const sports = Array.from(sportsMap.values());
      return sports.length > 0 ? sports : COMPREHENSIVE_FALLBACK_SPORTS;
    } catch (error) {
      console.error('❌ Supabase getDistinctSports error:', error.message);
      return COMPREHENSIVE_FALLBACK_SPORTS;
    }
  }

  async getSportGameCounts() {
    if (!this.client) return [];
    try {
      const { data, error } = await withTimeout(
        this.client.rpc('get_sport_game_counts'),
        10000,
        'getSportGameCounts'
      );
      if (error) throw error;
      console.log(`✅ Sport game counts: ${data?.length || 0} sports with data`);
      return data || [];
    } catch (error) {
      console.error('❌ Supabase getSportGameCounts error:', error.message);
      return [];
    }
  }

  async getUpcomingGames(sportKey, hoursAhead = 72) {
    if (!this.client) return [];
    try {
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
      return GameEnhancementService.enhanceGameData(data || [], sportKey, 'database');
    } catch (error) {
      console.error(`❌ Supabase getUpcomingGames error for ${sportKey}:`, error.message);
      throw error;
    }
  }

  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) {
      console.warn('❌ No client or games data for upsert');
      return { data: [], error: null };
    }
    
    try {
      console.log(`🔄 Upserting ${gamesData.length} games...`);
      
      const gamesWithMetadata = gamesData.map(game => {
        const safeGame = { ...game };
        
        delete safeGame.data_quality;
        delete safeGame.enhanced;
        delete safeGame.enhancement_source;
        delete safeGame.last_enhanced;
        delete safeGame.market_data;
        
        return {
          ...safeGame,
          last_updated: new Date().toISOString(),
          data_source: game.source || 'odds_api_ingestion'
        };
      });

      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .upsert(gamesWithMetadata, { 
            onConflict: 'event_id',
            ignoreDuplicates: false
          })
          .select(),
        15000,
        `upsertGames_${gamesData.length}`
      );

      if (error) {
        if (error.message.includes('column') && error.message.includes('does not exist')) {
          console.warn('⚠️ Database schema mismatch, attempting fallback upsert...');
          return await this._fallbackUpsert(gamesWithMetadata);
        }
        throw error;
      }

      console.log(`✅ Successfully upserted ${data?.length || 0} games`);
      return { data, error: null };

    } catch (error) {
      if (error instanceof TimeoutError) {
         console.error('❌ Supabase upsert TIMEOUT:', error.message);
         return { data: null, error: new Error('Upsert Timeout') };
       }
       
      console.error('❌ Supabase upsert CRITICAL error:', error.message);
      sentryService.captureError(error, { 
        component: 'database_service', 
        operation: 'upsertGames',
        game_count: gamesData.length
      });
      throw error;
    }
  }
  
  async _fallbackUpsert(gamesData) {
    try {
      console.log('🔄 Using fallback upsert with minimal fields...');
      
      const minimalGames = gamesData.map(game => ({
        event_id: game.event_id,
        sport_key: game.sport_key,
        commence_time: game.commence_time,
        home_team: game.home_team,
        away_team: game.away_team,
        last_updated: game.last_updated,
        data_source: game.data_source
      }));

      const { data, error } = await this.client
        .from('games')
        .upsert(minimalGames, { onConflict: 'event_id' })
        .select();

      if (error) throw error;
      
      console.log(`✅ Fallback upsert completed: ${data?.length || 0} games`);
      return { data, error: null };
    } catch (fallbackError) {
      console.error('❌ Fallback upsert also failed:', fallbackError.message);
      return { data: null, error: fallbackError };
    }
  }
  
  async findOrCreateUser(telegramId, firstName = '', username = '') {
    if (!this.client) return null;
    try {
      let { data: user, error } = await this.client.from('users').select('*').eq('tg_id', telegramId).single();
      if (error && error.code === 'PGRST116') {
        const { data: newUser, error: insertError } = await this.client.from('users').insert({ tg_id: telegramId, first_name: firstName, username: username, preferences: {} }).select().single();
        if (insertError) throw insertError;
        user = newUser;
      } else if (error) {
        throw error;
      }
      return user;
    } catch (error) {
      console.error(`❌ Supabase findOrCreateUser error for ${telegramId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'findOrCreateUser' });
      throw error;
    }
  }

  async getUserSettings(telegramId) {
    const user = await this.findOrCreateUser(telegramId);
    return user?.preferences || {};
  }

  async updateUserSettings(telegramId, newSettings) {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client.from('users').update({ preferences: newSettings }).eq('tg_id', telegramId).select().single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error(`❌ Supabase updateUserSettings error for ${telegramId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'updateUserSettings' });
      throw error;
    }
  }

  async testConnection() {
      if (!this.client) return false;
      try {
          const { error } = await withTimeout(this.client.from('games').select('id', { count: 'exact', head: true }).limit(1), 5000, 'testConnection');
          if (error) throw error;
          console.log('✅ Database connection test passed');
          return true;
      } catch (error) {
          console.error('❌ Database connection test FAILED:', error.message);
          return false;
      }
  }
  
    async getDatabaseStats() {
    if (!this.client) return null;
    try {
        const [gamesCount, usersCount] = await Promise.all([
            this.client.from('games').select('*', { count: 'exact', head: true }),
            this.client.from('users').select('*', { count: 'exact', head: true })
        ]);
        return {
            total_games: gamesCount.count || 0,
            total_users: usersCount.count || 0,
            status: 'healthy'
        };
    } catch (error) {
        return { status: 'error', error: error.message };
    }
  }
}

export default new DatabaseService();
