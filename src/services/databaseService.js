// src/services/databaseService.js - COMPLETE UPDATE WITH CENTRALIZED ENHANCEMENT
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
// NOTE: GameEnhancementService is defined locally below to ensure no import errors.
import { withTimeout, TimeoutError } from '../utils/asyncUtils.js';

// --- HELPER CLASS DEFINITION (Inserted to fix "is not defined" error) ---
// This is a simplified stand-in based on its usage in this file.
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
// -----------------------------------------------------------------------

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

// NOTE: withTimeout is imported from asyncUtils.js and not redefined here.

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

       // If it's any other error (Supabase being down), re-throw to make the HealthService fail.
      console.error(`❌ Supabase getUpcomingGames CRITICAL error for ${sportKey}:`, error.message);
      throw error; // Re-throw to make the HealthService fail.
    }
  }

  /**
   * Enhanced method to get verified real games for schedule validation
   */
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

  /**
   * Get games by sport (backward compatibility)
   */
  async getGamesBySport(sportKey) {
    return this.getUpcomingGames(sportKey, 168);
  }

  /**
   * Simple method to check if database has games for a sport
   */
  async hasGamesForSport(sportKey, hoursAhead = 72) {
    try {
      const games = await this.getUpcomingGames(sportKey, hoursAhead);
      return games.length > 0;
    } catch (error) {
      // NOTE: getUpcomingGames already handles TimeoutError, so only rethrow if
      // getUpcomingGames throws an unhandled critical error.
      console.error(`Error checking games for ${sportKey}:`, error);
      throw error;
    }
  }

  /**
   * Get the count of upcoming games for a sport
   */
  async getUpcomingGameCount(sportKey, hoursAhead = 72) {
    try {
      const games = await this.getUpcomingGames(sportKey, hoursAhead);
      return games.length;
    } catch (error) {
      // NOTE: getUpcomingGames already handles TimeoutError.
      console.error(`Error counting games for ${sportKey}:`, error);
      throw error;
    }
  }

  // ========== ENHANCED GAME METHODS ==========

  /**
   * Get game by ID with full details
   */
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
       // FIX: Only handle TimeoutError gracefully by returning null.
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase getGameById TIMEOUT for ${eventId}:`, error.message);
        return null;
       }

      console.error(`❌ Supabase getGameById CRITICAL error for ${eventId}:`, error.message);
      throw error;
    }
  }

  /**
   * Search games by query across all sports
   */
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
       // FIX: Only handle TimeoutError gracefully by returning empty array.
       if (error instanceof TimeoutError) {
        console.error(`❌ Supabase searchGames TIMEOUT for "${query}":`, error.message);
        return [];
       }

      console.error(`❌ Supabase searchGames CRITICAL error for "${query}":`, error.message);
      throw error;
    }
  }

  /**
   * Get active games (scheduled or live)
   */
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
       // FIX: Only handle TimeoutError gracefully by returning empty array.
       if (error instanceof TimeoutError) {
        console.error('❌ getActiveGames TIMEOUT:', error.message);
        return [];
       }

      console.error('❌ getActiveGames CRITICAL error:', error.message);
      throw error;
    }
  }

  /**
   * Get recently completed games for analysis
   */
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
       // FIX: Only handle TimeoutError gracefully by returning empty array.
       if (error instanceof TimeoutError) {
        console.error('❌ getRecentlyCompletedGames TIMEOUT:', error.message);
        return [];
       }

      console.error('❌ getRecentlyCompletedGames CRITICAL error:', error.message);
      throw error;
    }
  }

  // ========== DATA MANAGEMENT METHODS ==========

  /**
   * Enhanced upsert with better conflict handling
   */
  async upsertGames(gamesData) {
    if (!this.client || !gamesData?.length) {
      console.warn('❌ No client or games data for upsert');
      return { data: [], error: null };
    }

    try {
      console.log(`🔄 Upserting ${gamesData.length} games...`);

      const gamesWithMetadata = gamesData.map(game => ({
        ...game,
        last_updated: new Date().toISOString()
      }));

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

      if (error) throw error;

      console.log(`✅ Successfully upserted ${data?.length || 0} games`);
      return { data, error: null };

    } catch (error) {
       // FIX: Only handle TimeoutError gracefully.
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

  /**
   * Get data freshness and date ranges
   */
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

      // FIX: Apply withTimeout to Promise.all to prevent hang
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
       // FIX: Only handle TimeoutError gracefully.
       if (error instanceof TimeoutError) {
         console.error('❌ Supabase getOddsDateRange TIMEOUT:', error.message);
         return { min_date: null, max_date: null, game_count: 0 };
       }

      console.error('❌ Supabase getOddsDateRange CRITICAL error:', error.message);
      throw error;
    }
  }

  /**
   * Get sport statistics and game counts
   */
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

  // ========== USER MANAGEMENT METHODS ==========

  /**
   * Enhanced user management with better preferences
   */
  async findOrCreateUser(telegramId, firstName = '', username = '') {
    if (!this.client) return null;

    try {
      let { data: user, error } = await this.client
        .from('users')
        .select('*')
        .eq('tg_id', telegramId)
        .single();

      if (error && error.code === 'PGRST116') {
        const initialPreferences = {
            favorite_sports: [],
            bet_preferences: {
              max_legs: 5,
              include_props: true,
              preferred_mode: 'web',
              risk_tolerance: 'medium'
            },
            notifications: {
              ai_parlays: true,
              live_odds: false,
              results: true
            },
            created_at: new Date().toISOString(),
            last_active: new Date().toISOString()
        };

        const { data: newUser, error: insertError } = await this.client
          .from('users')
          .insert({
            tg_id: telegramId,
            first_name: firstName,
            username: username,
            preferences: initialPreferences
          })
          .select()
          .single();

        if (insertError) throw insertError;
        user = newUser;
        console.log(`✅ Created new user: ${firstName} (${telegramId})`);

      } else if (error) {
        throw error;
      } else {
        const updatedPreferences = {
            ...(user.preferences || {}),
            last_active: new Date().toISOString()
        };
        await this.client
          .from('users')
          .update({ preferences: updatedPreferences })
          .eq('tg_id', telegramId);
      }

      return user;

    } catch (error) {
      console.error(`❌ Supabase findOrCreateUser CRITICAL error for ${telegramId}:`, error.message);
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
      const updatedPreferences = {
          ...newSettings,
          updated_at: new Date().toISOString(),
          last_active: new Date().toISOString()
      };

      const { data, error } = await this.client
        .from('users')
        .update({
          preferences: updatedPreferences
        })
        .eq('tg_id', telegramId)
        .select()
        .single();

      if (error) throw error;

      console.log(`✅ Updated settings for user: ${telegramId}`);
      return data;

    } catch (error) {
      console.error(`❌ Supabase updateUserSettings CRITICAL error for ${telegramId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'updateUserSettings' });
      throw error;
    }
  }

  // ========== SERVICE MANAGEMENT METHODS ==========

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
      // FIX: Only treat non-TimeoutError as a critical failure.
      if (error instanceof TimeoutError) {
         console.error('❌ Database connection test TIMEOUT:', error.message);
         return false;
      }

      console.error('❌ Database connection test FAILED:', error.message);
      return false; // Return false for all other errors.
    }
  }

  /**
   * Get database statistics and health
   */
  async getDatabaseStats() {
    if (!this.client) return null;

    try {
      // FIX: Apply withTimeout to Promise.all to prevent hang
      const results = await withTimeout(
          Promise.all([
            this.client.from('games').select('*', { count: 'exact', head: true }),
            this.client.from('users').select('*', { count: 'exact', head: true }),
            this.client.from('games').select('sport_key', { count: 'exact', head: true }),
            this.getOddsDateRange()
          ]),
          10000,
          'getDatabaseStats'
      );

      const [
        gamesCount,
        usersCount,
        sportsCount,
        dateRange
      ] = results;

      return {
        total_games: gamesCount.count || 0,
        total_users: usersCount.count || 0,
        total_sports: sportsCount.count || 0,
        date_range: dateRange,
        last_updated: new Date().toISOString(),
        status: 'healthy'
      };

    } catch (error) {
      // FIX: Only handle TimeoutError gracefully.
      if (error instanceof TimeoutError) {
         console.error('❌ Database stats TIMEOUT:', error.message);
         return {
            total_games: 0,
            total_users: 0,
            total_sports: 0,
            date_range: { min_date: null, max_date: null, game_count: 0 },
            status: 'timeout',
            error: error.message
          };
      }

      console.error('❌ Database stats CRITICAL error:', error.message);
      return {
        total_games: 0,
        total_users: 0,
        total_sports: 0,
        date_range: { min_date: null, max_date: null, game_count: 0 },
        status: 'error',
        error: error.message
      };
    }
  }

  // ========== PRIVATE UTILITY METHODS ==========

  _assessSportDataQuality(sport) {
    const score = Math.min(100,
      (sport.upcoming_games > 0 ? 40 : 0) +
      (sport.game_count > 10 ? 30 : sport.game_count > 5 ? 20 : 10) +
      (sport.team_count > 5 ? 30 : sport.team_count > 2 ? 20 : 10)
    );

    return {
      score,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'
    };
  }

  _generateGameChecksum(game) {
    const str = `${game.event_id}|${game.home_team}|${game.away_team}|${game.commence_time}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
}

export default new DatabaseService();
