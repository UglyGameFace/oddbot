// src/services/databaseService.js - COMPLETE UPDATE
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { sentryService } from './sentryService.js';
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';

// Use the single source of truth from sportDefinitions.js
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

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms: ${label}`)), ms))]);

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

      // Enhanced sports aggregation with game counts and recent activity
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
          
          // Count upcoming games
          if (game.commence_time && new Date(game.commence_time) > now) {
            existing.upcoming_games++;
          }
          
          // Track last game time
          if (game.commence_time && (!existing.last_game_time || new Date(game.commence_time) > new Date(existing.last_game_time))) {
            existing.last_game_time = game.commence_time;
          }
          
          // Track unique teams
          if (game.home_team) existing.teams.add(game.home_team);
          if (game.away_team) existing.teams.add(game.away_team);
          
          sportsMap.set(game.sport_key, existing);
        }
      });

      // Convert to array and enhance with additional data
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

      // Sort by game count (most active first)
      sports.sort((a, b) => b.game_count - a.game_count);

      console.log(`✅ Found ${sports.length} sports with ${data?.length || 0} total games`);

      if (sports.length === 0) {
        console.log('🔄 Database empty, returning comprehensive default sports list.');
        return COMPREHENSIVE_FALLBACK_SPORTS;
      }
      
      return sports;

    } catch (error) {
      console.error('❌ Supabase getDistinctSports error:', error.message);
      console.log('🔄 Error fetching from DB, returning comprehensive default sports list.');
      return COMPREHENSIVE_FALLBACK_SPORTS;
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
      return this._enhanceGameData(data || [], sportKey);

    } catch (error) {
      console.error(`❌ Supabase getUpcomingGames error for ${sportKey}:`, error.message);
      return [];
    }
  }

  /**
   * Get games by sport (backward compatibility)
   */
  async getGamesBySport(sportKey) {
    return this.getUpcomingGames(sportKey, 168); // 1 week for backward compatibility
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
        return this._enhanceSingleGame(data);
      }
      
      return null;

    } catch (error) {
      console.error(`❌ Supabase getGameById error for ${eventId}:`, error.message);
      return null;
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
      return this._enhanceGameData(data || [], sportKey || 'mixed');

    } catch (error) {
      console.error(`❌ Supabase searchGames error for "${query}":`, error.message);
      return [];
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
        .gte('commence_time', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()) // Include games from last 2 hours
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
      return this._enhanceGameData(data || [], sportKey || 'mixed');

    } catch (error) {
      console.error('❌ getActiveGames error:', error.message);
      return [];
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
      console.error('❌ getRecentlyCompletedGames error:', error.message);
      return [];
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
      
      // Enhanced conflict resolution
      const gamesWithMetadata = gamesData.map(game => ({
        ...game,
        last_updated: new Date().toISOString(),
        data_source: 'odds_api_ingestion',
        checksum: this._generateGameChecksum(game)
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
      console.error('❌ Supabase upsert error:', error.message);
      sentryService.captureError(error, { 
        component: 'database_service', 
        operation: 'upsertGames',
        game_count: gamesData.length
      });
      return { data: null, error };
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
        { data: minData, error: minError },
        { data: maxData, error: maxError },
        { count, error: countError }
      ] = await Promise.all([
        queryBuilder.order('commence_time', { ascending: true }).limit(1),
        queryBuilder.order('commence_time', { ascending: false }).limit(1),
        queryBuilder
      ]);

      if (minError || maxError || countError) throw minError || maxError || countError;

      return {
        min_date: minData?.[0]?.commence_time || null,
        max_date: maxData?.[0]?.commence_time || null,
        game_count: count || 0,
        last_updated: new Date().toISOString()
      };

    } catch (error) {
      console.error('❌ Supabase getOddsDateRange error:', error.message);
      return { min_date: null, max_date: null, game_count: 0 };
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
        .gte('commence_time', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // Last 7 days

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
      console.error('❌ Supabase getSportGameCounts error:', error.message);
      return [];
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
        // User doesn't exist, create with enhanced preferences
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
        // Update last active timestamp for existing user
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
      console.error(`❌ Supabase findOrCreateUser error for ${telegramId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'findOrCreateUser' });
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
      console.error(`❌ Supabase updateUserSettings error for ${telegramId}:`, error.message);
      sentryService.captureError(error, { component: 'database_service', operation: 'updateUserSettings' });
      return null;
    }
  }
  // ========== SERVICE MANAGEMENT METHODS ==========

  /**
   * Test database connection and health
   */
  async testConnection() {
    if (!this.client) return false;
    
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
      console.error('❌ Database connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get database statistics and health
   */
  async getDatabaseStats() {
    if (!this.client) return null;
    
    try {
      const [
        gamesCount,
        usersCount,
        sportsCount,
        dateRange
      ] = await Promise.all([
        this.client.from('games').select('*', { count: 'exact', head: true }),
        this.client.from('users').select('*', { count: 'exact', head: true }),
        this.client.from('games').select('sport_key', { count: 'exact', head: true }),
        this.getOddsDateRange()
      ]);

      return {
        total_games: gamesCount.count || 0,
        total_users: usersCount.count || 0,
        total_sports: sportsCount.count || 0,
        date_range: dateRange,
        last_updated: new Date().toISOString(),
        status: 'healthy'
      };

    } catch (error) {
      console.error('❌ Database stats error:', error.message);
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

  /**
   * Enhance game data with additional fields for AI processing
   */
  _enhanceGameData(games, sportKey) {
    if (!games || !Array.isArray(games)) return [];
    
    return games.map(game => this._enhanceSingleGame(game, sportKey));
  }

  _enhanceSingleGame(game, sportKey = null) {
    const enhanced = { ...game };
    
    // Add AI analysis fields
    enhanced.display_name = `${game.away_team} @ ${game.home_team}`;
    enhanced.time_until = this._calculateTimeUntil(game.commence_time);
    enhanced.data_quality = this._assessGameDataQuality(game);
    enhanced.analysis_ready = this._isGameReadyForAnalysis(game);
    
    // Add odds availability info
    enhanced.odds_available = !!(game.bookmakers && game.bookmakers.length > 0);
    enhanced.market_variety = this._countMarkets(game);
    
    // Add sport-specific enhancements
    if (sportKey) {
      enhanced.sport_key = sportKey;
    }
    
    return enhanced;
  }

  _calculateTimeUntil(commenceTime) {
    if (!commenceTime) return null;
    
    const now = new Date();
    const gameTime = new Date(commenceTime);
    const diffMs = gameTime - now;
    
    if (diffMs < 0) return 'started';
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
    if (diffHours > 0) return `${diffHours}h`;
    
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return `${diffMinutes}m`;
  }

  _assessGameDataQuality(game) {
    let score = 0;
    let factors = [];

    if (game.home_team && game.away_team) {
      score += 30;
      factors.push('teams_available');
    }

    if (game.commence_time) {
      score += 20;
      factors.push('start_time_available');
    }

    if (game.bookmakers && game.bookmakers.length > 0) {
      score += 30;
      factors.push(`odds_available_${game.bookmakers.length}_books`);
    }

    if (game.bookmakers && game.bookmakers.length >= 3) {
      score += 20;
      factors.push('multiple_books');
    }

    return {
      score: Math.min(100, score),
      factors,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'
    };
  }

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

  _isGameReadyForAnalysis(game) {
    return game.home_team && 
           game.away_team && 
           game.commence_time && 
           game.bookmakers && 
           game.bookmakers.length >= 2;
  }

  _countMarkets(game) {
    if (!game.bookmakers) return 0;
    
    const markets = new Set();
    game.bookmakers.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        markets.add(market.key);
      });
    });
    
    return markets.size;
  }

  _generateGameChecksum(game) {
    // Simple checksum for change detection
    const str = `${game.event_id}|${game.home_team}|${game.away_team}|${game.commence_time}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }
}

export default new DatabaseService();
