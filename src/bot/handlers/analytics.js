// src/bot/handlers/analytics.js - FIXED FOR RELIABLE MarkdownV2 AND ROBUSTNESS

import oddsService from '../../services/oddsService.js';
import gamesService from '../../services/gamesService.js';
import databaseService from '../../services/databaseService.js';
import healthService from '../../services/healthService.js';
import {
  analyzeQuantitative,
  psychometric,
  advancedOddsModel,
  escapeMarkdownV2
} from '../../utils/enterpriseUtilities.js';

// Analytics configuration
const ANALYTICS_CONFIG = {
  DEFAULT_SPORT: 'basketball_nba',
  MAX_GAMES_ANALYZED: 100,
  CACHE_TTL: 300, // 5 minutes for analytics cache
  TIMEOUT_MS: 30000 // 30 seconds timeout
};

// Small helpers for MarkdownV2-safe text
const mdv2 = (v) => escapeMarkdownV2(String(v ?? '')); // escape dynamic values only
const codeInline = (v) => '`' + String(v ?? '') + '`'; // content inside code is safe in MarkdownV2

/**
 * Enhanced analytics service with comprehensive insights
 */
class AnalyticsService {
  constructor() {
    this.analysisCache = new Map();
  }

  /**
   * Generate comprehensive analytics for a sport
   */
  async generateSportAnalytics(sportKey, options = {}) {
    const cacheKey = `analytics:${sportKey}:${JSON.stringify(options)}`;
    const cached = this.analysisCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < ANALYTICS_CONFIG.CACHE_TTL * 1000) {
      console.log(`📊 Using cached analytics for ${sportKey}`);
      return cached.data;
    }

    console.log(`📊 Generating analytics for ${sportKey}...`);
    
    try {
      // Always fetch fresh, detailed odds data for analytics
      const oddsData = await oddsService.getSportOdds(sportKey, { useCache: false, includeLive: true, hoursAhead: 72 });
      // Optionally fetch games data via gamesService if needed later
      const gamesData = oddsData;

      const [dbStats, healthStatus] = await Promise.all([
        databaseService.getSportGameCounts(),
        healthService.getHealth?.(true) ?? healthService.getQuickHealth?.()
      ]);

      // Generate comprehensive analytics
      const analytics = {
        sport: sportKey,
        timestamp: new Date().toISOString(),
        data_quality: this._assessAnalyticsDataQuality(oddsData, gamesData),
        quantitative: this._generateQuantitativeAnalysis(oddsData, gamesData),
        behavioral: options.quick ? { note: 'Quick mode enabled' } : await this._generateBehavioralAnalysis(),
        predictive: this._generatePredictiveAnalysis(oddsData, options),
        market_insights: this._generateMarketInsights(oddsData),
        system_health: this._extractRelevantHealth(healthStatus ?? {}, sportKey),
        recommendations: this._generateRecommendations(oddsData, gamesData, dbStats ?? {})
      };

      // Cache the results
      this.analysisCache.set(cacheKey, {
        data: analytics,
        timestamp: Date.now()
      });

      // Clean up old cache entries
      this._cleanupCache();

      return analytics;

    } catch (error) {
      console.error(`❌ Analytics generation failed for ${sportKey}:`, error);
      throw new Error(`Analytics generation failed: ${error.message}`);
    }
  }

  /**
   * Generate user-specific analytics
   */
  async generateUserAnalytics(chatId, sportKey = null) {
    try {
      const [sportAnalytics, userProfile, systemHealth] = await Promise.all([
        this.generateSportAnalytics(sportKey || ANALYTICS_CONFIG.DEFAULT_SPORT),
        psychometric.profileUser(chatId),
        healthService.getQuickHealth()
      ]);

      return {
        user_id: chatId,
        timestamp: new Date().toISOString(),
        user_profile: userProfile,
        sport_analytics: sportAnalytics,
        system_status: systemHealth,
        personalized_insights: this._generatePersonalizedInsights(userProfile, sportAnalytics)
      };

    } catch (error) {
      console.error(`❌ User analytics generation failed for ${chatId}:`, error);
      throw new Error(`User analytics failed: ${error.message}`);
    }
  }

  /**
   * Compare multiple sports for betting opportunities
   */
  async compareSports(sportKeys) {
    try {
      const analyticsPromises = sportKeys.map(sportKey => 
        this.generateSportAnalytics(sportKey, { quick: true })
      );

      const allAnalytics = await Promise.all(analyticsPromises);
      
      return {
        comparison: {
          timestamp: new Date().toISOString(),
          sports_compared: sportKeys,
          summary: this._generateComparisonSummary(allAnalytics),
          opportunities: this._findCrossSportOpportunities(allAnalytics),
          risk_assessment: this._assessCrossSportRisk(allAnalytics)
        }
      };

    } catch (error) {
      console.error('❌ Sports comparison failed:', error);
      throw new Error(`Sports comparison failed: ${error.message}`);
    }
  }

  /**
   * Get analytics for live/upcoming games
   */
  async getLiveGameAnalytics(sportKey, hoursAhead = 24) {
    try {
      const liveGames = await oddsService.getLiveGames(sportKey, { 
        hoursAhead,
        maxGames: 20 
      });

      const analytics = liveGames.map(game => ({
        game_id: game.event_id,
        display_name: game.display_name,
        commence_time: game.commence_time,
        time_until: game.time_until,
        analytics: {
          implied_probabilities: advancedOddsModel.calculateImpliedProbabilities(game),
          game_features: advancedOddsModel.engineerGameFeatures(game),
          value_indicators: this._calculateValueIndicators(game),
          risk_factors: this._assessGameRisk(game)
        },
        betting_metrics: {
          market_variety: game.market_variety,
          odds_available: game.odds_available,
          data_quality: game.data_quality
        }
      }));

      return {
        sport: sportKey,
        timestamp: new Date().toISOString(),
        total_live_games: liveGames.length,
        games: analytics,
        summary: this._generateLiveGamesSummary(analytics)
      };

    } catch (error) {
      console.error(`❌ Live game analytics failed for ${sportKey}:`, error);
      throw new Error(`Live game analytics failed: ${error.message}`);
    }
  }

  // ========== PRIVATE METHODS ==========

  async _fetchOddsData(sportKey, options) {
    try {
      return await oddsService.getSportOdds(sportKey, {
        useCache: true,
        includeLive: true,
        hoursAhead: options.hoursAhead || 72,
        ...options
      });
    } catch (error) {
      console.error(`❌ Failed to fetch odds data for ${sportKey}:`, error);
      return [];
    }
  }

  async _fetchGamesData(sportKey, options) {
    try {
      return await gamesService.getGamesForSport(sportKey, {
        useCache: true,
        hoursAhead: options.hoursAhead || 72,
        ...options
      });
    } catch (error) {
      console.error(`❌ Failed to fetch games data for ${sportKey}:`, error);
      return [];
    }
  }

  _assessAnalyticsDataQuality(oddsData, gamesData) {
    const oddsQuality = oddsData.length > 0 ? 'high' : 'low';
    const gamesQuality = gamesData.length > 0 ? 'high' : 'low';
    const overallQuality = oddsData.length > 0 && gamesData.length > 0 ? 'high' : 
                         oddsData.length > 0 || gamesData.length > 0 ? 'medium' : 'low';

    return {
      overall: overallQuality,
      odds_data: {
        quality: oddsQuality,
        games_count: oddsData.length,
        has_live_odds: oddsData.some(game => game.bookmakers && game.bookmakers.length > 0)
      },
      games_data: {
        quality: gamesQuality,
        games_count: gamesData.length,
        has_upcoming_games: gamesData.some(game => {
          const gameTime = new Date(game.commence_time);
          return gameTime > new Date();
        })
      },
      confidence: overallQuality === 'high' ? 'high' : 'medium'
    };
  }

  _generateQuantitativeAnalysis(oddsData, gamesData) {
    const quantReport = analyzeQuantitative(oddsData);
    
    // Enhanced quantitative analysis
    const gameTimes = gamesData
      .map(game => new Date(game.commence_time))
      .filter(time => !isNaN(time.getTime()));
    
    const now = new Date();
    const upcomingGames = gameTimes.filter(time => time > now);
    const timeUntilGames = upcomingGames.map(time => time - now);
    
    return {
      ...quantReport,
      games_analysis: {
        total_games: gamesData.length,
        upcoming_games: upcomingGames.length,
        average_time_until: timeUntilGames.length > 0 ? 
          Math.round(timeUntilGames.reduce((a, b) => a + b, 0) / timeUntilGames.length / (1000 * 60 * 60)) : 0,
        next_game: upcomingGames.length > 0 ? 
          new Date(Math.min(...upcomingGames)).toISOString() : null
      },
      market_analysis: {
        total_markets: this._countTotalMarkets(oddsData),
        average_books_per_game: this._calculateAverageBooks(oddsData),
        market_variety: this._assessMarketVariety(oddsData)
      }
    };
  }

  async _generateBehavioralAnalysis() {
    // This would typically use historical user data
    // For now, we'll use the psychometric profile
    return {
      note: "Behavioral analytics based on risk profile and historical patterns",
      common_patterns: [
        "Users tend to prefer parlays with 3-5 legs",
        "Higher risk tolerance correlates with player props",
        "Live betting peaks during primetime games"
      ],
      risk_guidance: "Consider diversifying across multiple sports and bet types"
    };
  }

  _generatePredictiveAnalysis(oddsData, options = {}) {
    if (oddsData.length === 0) {
      return { note: "Insufficient data for predictive analysis" };
    }
    const limit = Math.min(
      options.quick ? 20 : ANALYTICS_CONFIG.MAX_GAMES_ANALYZED,
      oddsData.length
    );

    const gamesWithAnalysis = oddsData.slice(0, limit).map(game => ({
      game_id: game.event_id,
      home_team: game.home_team,
      away_team: game.away_team,
      features: advancedOddsModel.engineerGameFeatures(game),
      value_indicators: this._calculateValueIndicators(game)
    }));

    return {
      total_games_analyzed: gamesWithAnalysis.length,
      clear_favorites: gamesWithAnalysis.filter(g => g.features.isClearFavorite).length,
      close_games: gamesWithAnalysis.filter(g => g.features.isCloseGame).length,
      high_value_opportunities: gamesWithAnalysis.filter(g => 
        g.value_indicators.overall_value > 0.7
      ).length,
      sample_analysis: gamesWithAnalysis.slice(0, 3)
    };
  }

  _generateMarketInsights(oddsData) {
    const books = new Set();
    const markets = new Set();
    
    oddsData.forEach(game => {
      game.bookmakers?.forEach(bookmaker => {
        books.add(bookmaker.title);
        bookmaker.markets?.forEach(market => {
          markets.add(market.key);
        });
      });
    });

    return {
      total_books: books.size,
      total_markets: markets.size,
      book_coverage: Array.from(books),
      market_coverage: Array.from(markets),
      liquidity_indicator: books.size >= 3 ? 'high' : books.size >= 2 ? 'medium' : 'low'
    };
  }

  _extractRelevantHealth(healthStatus, sportKey) {
    return {
      overall: healthStatus?.overall?.status ?? 'unknown',
      odds_service: healthStatus?.services?.odds?.healthy ?? false,
      games_service: healthStatus?.services?.games?.healthy ?? false,
      data_freshness: healthStatus?.services?.odds?.metrics?.data_freshness ?? null,
      last_updated: new Date().toISOString()
    };
  }

  _generateRecommendations(oddsData, gamesData, dbStats) {
    const recommendations = [];
    
    if (oddsData.length === 0) {
      recommendations.push({
        type: 'data_quality',
        priority: 'high',
        message: 'No odds data available Consider running cache refresh',
        action: 'Use /cache_refresh to update odds data'
      });
    }

    if (gamesData.length === 0) {
      recommendations.push({
        type: 'data_quality', 
        priority: 'high',
        message: 'No games data available Check games service',
        action: 'Verify games service connectivity'
      });
    }

    if (oddsData.length > 0 && gamesData.length > 0) {
      const liveGames = gamesData.filter(game => {
        const gameTime = new Date(game.commence_time);
        const hoursUntil = (gameTime - new Date()) / (1000 * 60 * 60);
        return hoursUntil <= 24 && hoursUntil > 0;
      });

      if (liveGames.length > 5) {
        recommendations.push({
          type: 'betting_opportunity',
          priority: 'medium',
          message: `Found ${liveGames.length} games in next 24 hours with good data quality`,
          action: 'Consider building parlays with upcoming games'
        });
      }
    }

    return recommendations;
  }

  _generatePersonalizedInsights(userProfile, sportAnalytics) {
    const riskTolerance = parseFloat(userProfile.riskAppetite);
    
    return {
      risk_based_advice: riskTolerance > 0.6 ? 
        "Your high risk tolerance suggests player props and parlays may be suitable" :
        "Consider moneyline and spread bets for more conservative approach",
      recommended_legs: riskTolerance > 0.6 ? '4-6' : '2-3',
      sport_suitability: this._assessSportSuitability(userProfile, sportAnalytics)
    };
  }

  _assessSportSuitability(userProfile, sportAnalytics) {
    // Simple heuristic based on sport volatility and user risk profile
    const riskTolerance = parseFloat(userProfile.riskAppetite);
    
    const sportVolatility = {
      'basketball_nba': 'medium',
      'americanfootball_nfl': 'high', 
      'baseball_mlb': 'low',
      'icehockey_nhl': 'high',
      'soccer_england_premier_league': 'medium'
    };

    const currentSportVolatility = sportVolatility[sportAnalytics.sport] || 'medium';
    
    return {
      match: (riskTolerance > 0.6 && currentSportVolatility === 'high') ||
             (riskTolerance > 0.3 && currentSportVolatility === 'medium') ||
             (riskTolerance <= 0.3 && currentSportVolatility === 'low'),
      volatility: currentSportVolatility,
      recommendation: riskTolerance > 0.6 ? 
        "High volatility sport matches your risk profile" :
        "Consider the sport's volatility relative to your risk tolerance"
    };
  }

  _generateComparisonSummary(analyticsArray) {
    const summary = analyticsArray.map(analytics => ({
      sport: analytics.sport,
      games_count: analytics.quantitative.games_analysis.total_games,
      data_quality: analytics.data_quality.overall,
      market_coverage: analytics.market_insights.total_books,
      value_opportunities: analytics.predictive.high_value_opportunities
    }));

    return summary.sort((a, b) => b.value_opportunities - a.value_opportunities);
  }

  _findCrossSportOpportunities(analyticsArray) {
    const opportunities = [];
    
    analyticsArray.forEach(analytics => {
      if (analytics.predictive.high_value_opportunities > 0) {
        opportunities.push({
          sport: analytics.sport,
          opportunities: analytics.predictive.high_value_opportunities,
          data_quality: analytics.data_quality.overall
        });
      }
    });

    return opportunities.sort((a, b) => b.opportunities - a.opportunities);
  }

  _assessCrossSportRisk(analyticsArray) {
    const poorDataSports = analyticsArray.filter(a => 
      a.data_quality.overall === 'low'
    ).length;

    return {
      overall_risk: poorDataSports > 0 ? 'elevated' : 'normal',
      concerns: poorDataSports > 0 ? 
        `${poorDataSports} sports have poor data quality` : 
        'All sports have adequate data quality',
      recommendation: poorDataSports > 0 ?
        'Focus on sports with high data quality' :
        'Diversification across sports is recommended'
    };
  }

  _calculateValueIndicators(game) {
    if (!game.bookmakers || game.bookmakers.length === 0) {
      return { overall_value: 0, factors: ['no_odds'] };
    }

    let valueScore = 0;
    const factors = [];

    // More bookmakers = better price discovery
    if (game.bookmakers.length >= 3) {
      valueScore += 0.3;
      factors.push('multiple_books');
    }

    // Market variety indicates depth
    const marketCount = this._countGameMarkets(game);
    if (marketCount >= 2) {
      valueScore += 0.2;
      factors.push('market_variety');
    }

    // Recent data is more valuable
    if (game.last_updated) {
      const dataAge = Date.now() - new Date(game.last_updated).getTime();
      if (dataAge < 30 * 60 * 1000) { // 30 minutes
        valueScore += 0.3;
        factors.push('fresh_data');
      }
    }

    // Game timing - closer games have more certainty
    if (game.commence_time) {
      const hoursUntil = (new Date(game.commence_time) - new Date()) / (1000 * 60 * 60);
      if (hoursUntil > 1 && hoursUntil < 24) {
        valueScore += 0.2;
        factors.push('optimal_timing');
      }
    }

    return {
      overall_value: Math.min(1, valueScore),
      factors,
      score_breakdown: {
        bookmaker_coverage: game.bookmakers.length >= 3 ? 0.3 : 0,
        market_variety: marketCount >= 2 ? 0.2 : 0,
        data_freshness: factors.includes('fresh_data') ? 0.3 : 0,
        timing: factors.includes('optimal_timing') ? 0.2 : 0
      }
    };
  }

  _assessGameRisk(game) {
    const risks = [];
    
    if (!game.bookmakers || game.bookmakers.length === 0) {
      risks.push('no_odds_available');
    }

    if (game.bookmakers && game.bookmakers.length < 2) {
      risks.push('limited_bookmaker_coverage');
    }

    if (game.data_quality?.rating === 'poor') {
      risks.push('poor_data_quality');
    }

    return {
      overall_risk: risks.length === 0 ? 'low' : risks.length === 1 ? 'medium' : 'high',
      specific_risks: risks,
      mitigation: risks.length > 0 ? 
        'Consider waiting for better data or more bookmaker coverage' :
        'Data quality supports confident analysis'
    };
  }

  _generateLiveGamesSummary(gamesAnalytics) {
    const totalGames = gamesAnalytics.length;
    const highValueGames = gamesAnalytics.filter(game => 
      game.analytics.value_indicators.overall_value > 0.7
    ).length;
    
    const lowRiskGames = gamesAnalytics.filter(game =>
      game.analytics.risk_factors.overall_risk === 'low'
    ).length;

    return {
      total_games: totalGames,
      high_value_opportunities: highValueGames,
      low_risk_games: lowRiskGames,
      opportunity_ratio: totalGames > 0 ? (highValueGames / totalGames).toFixed(2) : 0,
      recommendation: highValueGames > 0 ?
        `Focus on ${highValueGames} high-value games` :
        'Limited high-value opportunities found'
    };
  }

  _countTotalMarkets(oddsData) {
    const markets = new Set();
    oddsData.forEach(game => {
      game.bookmakers?.forEach(bookmaker => {
        bookmaker.markets?.forEach(market => {
          markets.add(market.key);
        });
      });
    });
    return markets.size;
  }

  _calculateAverageBooks(oddsData) {
    if (oddsData.length === 0) return 0;
    
    const totalBooks = oddsData.reduce((sum, game) => {
      return sum + (game.bookmakers?.length || 0);
    }, 0);
    
    return Number((totalBooks / oddsData.length).toFixed(1));
  }

  _assessMarketVariety(oddsData) {
    const marketCount = this._countTotalMarkets(oddsData);
    
    if (marketCount >= 5) return 'excellent';
    if (marketCount >= 3) return 'good';
    if (marketCount >= 2) return 'fair';
    return 'poor';
  }

  _countGameMarkets(game) {
    const markets = new Set();
    game.bookmakers?.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        markets.add(market.key);
      });
    });
    return markets.size;
  }

  _cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.analysisCache.entries()) {
      if (now - value.timestamp > ANALYTICS_CONFIG.CACHE_TTL * 1000) {
        this.analysisCache.delete(key);
      }
    }
  }
}

// Create singleton instance
const analyticsService = new AnalyticsService();

/**
 * Register analytics commands with the bot
 */
export function registerAnalytics(bot) {
  // --- Main analytics command ---
  bot.onText(/^\/analytics(?:\s+([\w]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sportKey = match[1] || ANALYTICS_CONFIG.DEFAULT_SPORT;
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId, 
        `📊 Generating comprehensive analytics for ${mdv2(sportKey)}\n\nThis may take a few seconds`,
        { parse_mode: 'MarkdownV2' }
      );

      const analytics = await analyticsService.generateSportAnalytics(sportKey);
      const message = formatAnalyticsForTelegram(analytics);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Analytics command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId, 
        `❌ Analytics generation failed: ${codeInline(safeError)}\n\nTry a different sport or check system status with /health`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- User analytics command ---
  bot.onText(/^\/my_analytics(?:\s+([\w]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sportKey = match[1];
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId,
        '👤 Generating personalized analytics',
        { parse_mode: 'MarkdownV2' }
      );

      const userAnalytics = await analyticsService.generateUserAnalytics(chatId, sportKey);
      const message = formatUserAnalyticsForTelegram(userAnalytics);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('User analytics command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId,
        `❌ Personalized analytics failed: ${codeInline(safeError)}`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Live games analytics command ---
  bot.onText(/^\/live_analytics(?:\s+([\w]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sportKey = match[1] || ANALYTICS_CONFIG.DEFAULT_SPORT;
    
    try {
      const sentMsg = await bot.sendMessage(
        chatId,
        `🔴 Generating live game analytics for ${mdv2(sportKey)}`,
        { parse_mode: 'MarkdownV2' }
      );

      const liveAnalytics = await analyticsService.getLiveGameAnalytics(sportKey);
      const message = formatLiveAnalyticsForTelegram(liveAnalytics);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Live analytics command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId,
        `❌ Live analytics failed: ${codeInline(safeError)}`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // --- Sports comparison command ---
  bot.onText(/^\/compare_sports (.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sportKeys = match[1].split(',').map(s => s.trim()).filter(s => s);
    
    if (sportKeys.length < 2 || sportKeys.length > 5) {
      return bot.sendMessage(
        chatId,
        'Please provide 2\\-5 sports to compare separated by commas\nExample: /compare_sports nba, nfl, mlb',
        { parse_mode: 'MarkdownV2' }
      );
    }

    try {
      const sentMsg = await bot.sendMessage(
        chatId,
        `⚖️ Comparing ${mdv2(String(sportKeys.length))} sports`,
        { parse_mode: 'MarkdownV2' }
      );

      const comparison = await analyticsService.compareSports(sportKeys);
      const message = formatComparisonForTelegram(comparison);
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Sports comparison command failed:', error);
      const safeError = escapeMarkdownV2(error.message);
      await bot.sendMessage(
        chatId,
        `❌ Sports comparison failed: ${codeInline(safeError)}`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  });
}

// ========== FORMATTING FUNCTIONS ==========

function formatAnalyticsForTelegram(analytics) {
  const { sport, data_quality, quantitative, market_insights, recommendations, timestamp } = analytics;

  const header = `📊 *${mdv2(sport.toUpperCase())} Analytics*`;

  const dq = [
    `*Data Quality*`,
    `• Overall: ${mdv2(data_quality.overall.toUpperCase())}`,
    `• Odds Data: ${mdv2(data_quality.odds_data.games_count)}`,
    `• Games Data: ${mdv2(data_quality.games_data.games_count)}`,
    `• Confidence: ${mdv2(data_quality.confidence)}`
  ].join('\n');

  const qi = [
    `*Quantitative Insights*`,
    `• Total Games: ${mdv2(quantitative.totalGamesAnalyzed || quantitative.games_analysis.total_games)}`,
    `• Upcoming Games: ${mdv2(quantitative.games_analysis.upcoming_games)}`,
    `• Avg Books\\/Game: ${mdv2(quantitative.market_analysis.average_books_per_game)}`
  ].join('\n');

  const mi = [
    `*Market Coverage*`,
    `• Bookmakers: ${mdv2(market_insights.total_books)}`,
    `• Markets: ${mdv2(market_insights.total_markets)}`,
    `• Liquidity: ${mdv2(market_insights.liquidity_indicator.toUpperCase())}`
  ].join('\n');

  let rec = '';
  if (recommendations.length > 0) {
    const items = recommendations.slice(0, 3).map(rec => `• ${mdv2(rec.message)}`).join('\n');
    rec = `\n*Recommendations*\n${items}`;
  }

  const footer = `\n_Generated:_ ${codeInline(new Date(timestamp || Date.now()).toLocaleString())}`;

  return [header, '', dq, '', qi, '', mi, rec, footer].join('\n');
}

function formatUserAnalyticsForTelegram(userAnalytics) {
  const { user_profile, sport_analytics, personalized_insights } = userAnalytics;
  
  const header = `👤 *Personalized Analytics*`;

  const prof = [
    `*Profile*`,
    `• Risk Appetite: ${mdv2(user_profile.riskAppetite)}`,
    `• Strategy: ${mdv2(user_profile.preferredStrategy)}`
  ].join('\n');

  const pins = [
    `*Personalized Insights*`,
    `• ${mdv2(personalized_insights.risk_based_advice)}`,
    `• Recommended Legs: ${mdv2(personalized_insights.recommended_legs)}`,
    `• Sport Match: ${mdv2(personalized_insights.sport_suitability.match ? '✅' : '⚠️')}`
  ].join('\n');

  const sum = [
    `*Current Sport Analysis*`,
    `• Data Quality: ${mdv2(sport_analytics.data_quality.overall)}`,
    `• Games Available: ${mdv2(sport_analytics.quantitative.games_analysis.total_games)}`,
    `• Value Opportunities: ${mdv2(sport_analytics.predictive.high_value_opportunities)}`
  ].join('\n');

  return [header, '', prof, '', pins, '', sum].join('\n');
}

function formatLiveAnalyticsForTelegram(liveAnalytics) {
  const { sport, total_live_games, summary } = liveAnalytics;
  
  const header = `🔴 *Live ${mdv2(sport.toUpperCase())} Analytics*`;

  const sum = [
    `*Summary*`,
    `• Total Live Games: ${mdv2(total_live_games)}`,
    `• High Value Opportunities: ${mdv2(summary.high_value_opportunities)}`,
    `• Low Risk Games: ${mdv2(summary.low_risk_games)}`,
    `• Opportunity Ratio: ${mdv2(summary.opportunity_ratio)}`
  ].join('\n');

  const rec = [
    `*Recommendation*`,
    `${mdv2(summary.recommendation)}`
  ].join('\n');

  const hint = total_live_games > 0
    ? `\nUse /ai for specific parlay recommendations based on these insights`
    : '';

  return [header, '', sum, '', rec, hint].join('\n');
}

function formatComparisonForTelegram(comparison) {
  const { sports_compared, summary, opportunities, risk_assessment } = comparison.comparison;
  
  const header = `⚖️ *Sports Comparison*`;

  const listed = `*Sports Compared* ${mdv2(sports_compared.join(', '))}`;

  const rankedLines = summary.map((sport, index) => {
    const rank = `${index + 1}\\.`; // dot escaped for V2
    const line = `${rank} ${mdv2(sport.sport)}: ${mdv2(sport.value_opportunities)} value opportunities | data: ${mdv2(sport.data_quality)} | books: ${mdv2(sport.market_coverage)}`;
    return line;
  }).join('\n');

  const opp = opportunities.length > 0
    ? opportunities.slice(0, 3).map(opp => `• ${mdv2(opp.sport)}: ${mdv2(opp.opportunities)} value bets`).join('\n')
    : 'No clear cross\\-sport opportunities found';

  const risk = `*Risk Assessment* ${mdv2(risk_assessment.overall_risk.toUpperCase())}\n${mdv2(risk_assessment.recommendation)}`;

  return [header, '', listed, '', `*Ranked by Value Opportunities*`, rankedLines, '', `*Cross\\-Sport Opportunities*`, opp, '', risk].join('\n');
}

export default analyticsService;
