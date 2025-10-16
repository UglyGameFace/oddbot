// src/services/databaseService.js - FINAL CORRECTED VERSION
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';
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

class DatabaseService {
  get client() { 
    return supabaseClient || (supabaseClient = buildClient()); 
  }

  // ========== DATA MANAGEMENT METHODS ==========

  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) {
      console.warn('❌ No client or games data for upsert');
      return { data: [], error: null };
    }
    
    try {
      console.log(`🔄 Upserting ${gamesData.length} games...`);
      
      // Updated VALID_GAME_COLUMNS to include league_key
      const VALID_GAME_COLUMNS = [
        'event_id',
        'sport_key',
        'sport_title',
        'commence_time',
        'home_team',
        'away_team',
        'bookmakers',
        'scores',
        'status',
        'league_key' // Added league_key to fix the null constraint error
      ];

      const gamesToUpsert = gamesData.map(game => {
        const cleanGame = {};
        VALID_GAME_COLUMNS.forEach(col => {
          if (game[col] !== undefined) {
            cleanGame[col] = game[col];
          }
        });
        
        // CRITICAL FIX: Ensure league_key always has a value
        // Use sport_key as fallback for league_key if not provided
        if (!cleanGame.league_key) {
          cleanGame.league_key = cleanGame.sport_key || 'unknown_league';
        }
        
        return cleanGame;
      });

      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .upsert(gamesToUpsert, {
            onConflict: 'event_id',
            ignoreDuplicates: false
          })
          .select(),
        15000,
        `upsertGames_${gamesToUpsert.length}`
      );

      if (error) throw error;

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

  // ========== CORE SPORTS METHODS ==========

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
      if (error instanceof TimeoutError) {
        console.error('❌ Supabase getDistinctSports TIMEOUT, returning fallback:', error.message);
        return COMPREHENSIVE_FALLBACK_SPORTS;
      }
      
      console.error('❌ Supabase getDistinctSports CRITICAL error:', error.message);
      throw error;
    }
  }

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
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase getUpcomingGames TIMEOUT for ${sportKey}:`, error.message);
        return [];
       }
      
      console.error(`❌ Supabase getUpcomingGames CRITICAL error for ${sportKey}:`, error.message);
      throw error;
    }
  }

  async getVerifiedRealGames(sportKey, hours = 72) {
    if (!this.client) return [];
    
    try {
      console.log(`🔍 Getting VERIFIED real games for ${sportKey} from database...`);
      
      const startTime = new Date().toISOString();
      const endTime = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await this.client
        .from('games')
        .select('*')
        .eq('sport_key', sportKey)
        .gte('commence_time', startTime)
        .lte('commence_time', endTime)
        .order('commence_time', { ascending: true });

      if (error) throw error;

      const verifiedGames = (data || []).map(game => ({
        event_id: game.event_id,
        commence_time: game.commence_time,
        away_team: game.away_team,
        home_team: game.home_team,
        sport_key: game.sport_key,
        sport_title: game.sport_title,
        real: true,
        source: 'database_verified'
      }));

      console.log(`✅ Database: ${verifiedGames.length} verified real games for ${sportKey}`);
      return verifiedGames;

    } catch (error) {
      console.error(`❌ Database verified games fetch failed for ${sportKey}:`, error.message);
      throw error;
    }
  }

  async getGamesBySport(sportKey) {
    return this.getUpcomingGames(sportKey, 168);
  }

  async hasGamesForSport(sportKey, hoursAhead = 72) {
    try {
      const games = await this.getUpcomingGames(sportKey, hoursAhead);
      return games.length > 0;
    } catch (error) {
      console.error(`Error checking games for ${sportKey}:`, error);
      throw error;
    }
  }

  async getUpcomingGameCount(sportKey, hoursAhead = 72) {
    try {
      const games = await this.getUpcomingGames(sportKey, hoursAhead);
      return games.length;
    } catch (error) {
      console.error(`Error counting games for ${sportKey}:`, error);
      throw error;
    }
  }

  async getGameById(eventId) {
    if (!this.client) return null;
    
    try {
      const { data, error } = await withTimeout(
        this.client
          .from('games')
          .select('*')
          .eq('event_id', eventId)
          .single(),
        5000,
        `getGameById_${eventId}`
      );

      if (error && error.code !== 'PGRST116') throw error;
      
      if (data) {
        console.log(`✅ Found game: ${data.home_team} vs ${data.away_team}`);
        return GameEnhancementService.enhanceSingleGame(data, data.sport_key, 'database');
      }
      
      return null;

    } catch (error) {
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase getGameById TIMEOUT for ${eventId}:`, error.message);
        return null;
       }

      console.error(`❌ Supabase getGameById CRITICAL error for ${eventId}:`, error.message);
      throw error; 
    }
  }

  async searchGames(query, sportKey = null) {
    if (!this.client) return [];
    
    try {
      console.log(`🔍 Searching games for: "${query}"${sportKey ? ` in ${sportKey}` : ''}`);
      
      let queryBuilder = this.client
        .from('games')
        .select('*')
        .or(`home_team.ilike.%${query}%,away_team.ilike.%${query}%,tournament.ilike.%${query}%`)
        .gte('commence_time', new Date().toISOString())
        .order('commence_time', { ascending: true })
        .limit(50);

      if (sportKey) {
        queryBuilder = queryBuilder.eq('sport_key', sportKey);
      }

      const { data, error } = await withTimeout(
        queryBuilder,
        8000,
        `searchGames_${query}`
      );

      if (error) throw error;

      console.log(`✅ Search found ${data?.length || 0} games for "${query}"`);
      return GameEnhancementService.enhanceGameData(data || [], sportKey || 'mixed', 'database_search');

    } catch (error) {
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase searchGames TIMEOUT for "${query}":`, error.message);
        return [];
       }
       
      console.error(`❌ Supabase searchGames CRITICAL error for "${query}":`, error.message);
      throw error;
    }
  }

  async getActiveGames(sportKey = null) {
    if (!this.client) return [];
    
    try {
      let queryBuilder = this.client
        .from('games')
        .select('*')
        .in('status', ['scheduled', 'live', 'inprogress'])
        .gte('commence_time', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
        .order('commence_time', { ascending: true });

      if (sportKey) {
        queryBuilder = queryBuilder.eq('sport_key', sportKey);
      }

      const { data, error } = await withTimeout(
        queryBuilder,
        8000,
        `getActiveGames${sportKey ? '_' + sportKey : ''}`
      );

      if (error) throw error;

      console.log(`✅ Found ${data?.length || 0} active games${sportKey ? ` for ${sportKey}` : ''}`);
      return GameEnhancementService.enhanceGameData(data || [], sportKey || 'mixed', 'database');

    } catch (error) {
       if (error instanceof TimeoutError) {
        console.error('❌ getActiveGames TIMEOUT:', error.message);
        return [];
       }

      console.error('❌ getActiveGames CRITICAL error:', error.message);
      throw error;
    }
  }

  async getRecentlyCompletedGames(hoursBack = 24, sportKey = null) {
    if (!this.client) return [];
    
    try {
      const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
      
      let queryBuilder = this.client
        .from('games')
        .select('*')
        .eq('status', 'completed')
        .gte('commence_time', startTime)
        .order('commence_time', { ascending: false })
        .limit(100);

      if (sportKey) {
        queryBuilder = queryBuilder.eq('sport_key', sportKey);
      }

      const { data, error } = await withTimeout(
        queryBuilder,
        8000,
        `getRecentlyCompletedGames_${hoursBack}h`
      );

      if (error) throw error;

      console.log(`✅ Found ${data?.length || 0} recently completed games`);
      return data || [];

    } catch (error) {
       if (error instanceof TimeoutError) {
        console.error('❌ getRecentlyCompletedGames TIMEOUT:', error.message);
        return [];
       }

      console.error('❌ getRecentlyCompletedGames CRITICAL error:', error.message);
      throw error;
    }
  }

  async getOddsDateRange(sportKey = null) {
    if (!this.client) return { min_date: null, max_date: null, game_count: 0 };
    
    try {
      let queryBuilder = this.client.from('games').select('commence_time', { count: 'exact' });
      
      if (sportKey) {
        queryBuilder = queryBuilder.eq('sport_key', sportKey);
      }

      const [
        minDataPromise,
        maxDataPromise,
        countPromise
      ] = [
        queryBuilder.order('commence_time', { ascending: true }).limit(1),
        queryBuilder.order('commence_time', { ascending: false }).limit(1),
        queryBuilder
      ];
      
      const results = await withTimeout(
          Promise.all([
            minDataPromise,
            maxDataPromise,
            countPromise
          ]),
          10000,
          'getOddsDateRange'
      );
      
      const [
        { data: minData, error: minError },
        { data: maxData, error: maxError },
        { count, error: countError }
      ] = results;

      if (minError || maxError || countError) throw minError || maxError || countError;

      return {
        min_date: minData?.[0]?.commence_time || null,
        max_date: maxData?.[0]?.commence_time || null,
        game_count: count || 0,
        last_updated: new Date().toISOString()
      };

    } catch (error) {
       if (error instanceof TimeoutError) {
         console.error('❌ Supabase getOddsDateRange TIMEOUT:', error.message);
         return { min_date: null, max_date: null, game_count: 0 };
       }

      console.error('❌ Supabase getOddsDateRange CRITICAL error:', error.message);
      throw error;
    }
  }

  async getSportGameCounts() {
    if (!this.client) return [];
    
    try {
      const { data, error } = await this.client
        .from('games')
        .select('sport_key, sport_title, commence_time, status')
        .gte('commence_time', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      if (error) throw error;

      const counts = (data || []).reduce((acc, game) => {
        const sportKey = game.sport_key || 'unknown';
        const sportTitle = game.sport_title || sportKey;
        
        if (!acc[sportKey]) {
          acc[sportKey] = {
            sport_key: sportKey,
            sport_title: sportTitle,
            total_games: 0,
            upcoming_games: 0,
            completed_games: 0,
            last_activity: game.commence_time
          };
        }
        
        acc[sportKey].total_games++;
        
        const gameTime = new Date(game.commence_time);
        const now = new Date();
        
        if (gameTime > now) {
          acc[sportKey].upcoming_games++;
        } else if (game.status === 'completed') {
          acc[sportKey].completed_games++;
        }
        
        if (gameTime > new Date(acc[sportKey].last_activity)) {
          acc[sportKey].last_activity = game.commence_time;
        }
        
        return acc;
      }, {});

      return Object.values(counts).sort((a, b) => b.total_games - a.total_games);

    } catch (error) {
      console.error('❌ Supabase getSportGameCounts CRITICAL error:', error.message);
      throw error;
    }
  }

  _assessSportDataQuality(sport) {
    return {
      has_upcoming_games: sport.upcoming_games > 0,
      team_variety: sport.teams.size > 2,
      game_frequency: sport.game_count > 0,
      recent_data: sport.last_game_time && new Date(sport.last_game_time) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    };
  }
}

export default new DatabaseService();
