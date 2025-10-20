// src/services/aiService.js - ELITE QUANTUM SPORTS ANALYTICS ENGINE (with strict JSON + schema)
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { sleep } from '../utils/asyncUtils.js';
import { getAIConfig } from '../bot/state.js';
import { strictExtractJSONObject } from '../utils/strictJson.js';
import { isValidParlay } from '../schemas/parlaySchema.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 75000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

const AI_MODELS = {
  perplexity: 'sonar-pro',
  'sonar-pro': 'sonar-pro',
  'sonar-small-chat': 'sonar-small-chat',
};

// Utility math preserved
class EliteBettingMathematics {
  static americanToDecimal(american) {
    const odds = Number(american);
    if (!Number.isFinite(odds)) return 1.0;
    return odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
  }
  static decimalToAmerican(decimal) {
    const odds = Number(decimal);
    if (!Number.isFinite(odds) || odds <= 1) return null;
    return odds >= 2 ? Math.round((odds - 1) * 100) : Math.round(-100 / (odds - 1));
  }
  static calculateImpliedProbability(americanOdds) {
    const decimal = this.americanToDecimal(americanOdds);
    return 1 / decimal;
  }
  static calculateNoVigProbability(oddsA, oddsB) {
    const probA = this.calculateImpliedProbability(oddsA);
    const probB = this.calculateImpliedProbability(oddsB);
    const totalProb = probA + probB;
    return totalProb > 0
      ? { home: probA / totalProb, away: probB / totalProb, vig: totalProb - 1 }
      : null;
  }
  static calculateExpectedValue(probability, decimalOdds, stake = 1) {
    return probability * (decimalOdds - 1) * stake - (1 - probability) * stake;
  }
  static kellyCriterion(probability, decimalOdds) {
    const edge = probability * decimalOdds - 1;
    return edge > 0 ? edge / (decimalOdds - 1) : 0;
  }
}

// Existing validation engine preserved (truncated for brevity in this comment block; full original kept)
class QuantumValidationEngine {
  constructor() {
    this.teamRosters = new Map();
    this.establishedPlayers = new Map([
      ['aaron rodgers', { team: 'New York Jets', sport: 'nfl', positions: ['QB'] }],
      ['patrick mahomes', { team: 'Kansas City Chiefs', sport: 'nfl', positions: ['QB'] }],
      ['travis kelce', { team: 'Kansas City Chiefs', sport: 'nfl', positions: ['TE'] }],
      ["ja'marr chase", { team: 'Cincinnati Bengals', sport: 'nfl', positions: ['WR'] }],
      ['josh allen', { team: 'Buffalo Bills', sport: 'nfl', positions: ['QB'] }],
      ['justin jefferson', { team: 'Minnesota Vikings', sport: 'nfl', positions: ['WR'] }],
      ['lebron james', { team: 'Los Angeles Lakers', sport: 'nba', positions: ['SF', 'PF'] }],
      ['stephen curry', { team: 'Golden State Warriors', sport: 'nba', positions: ['PG'] }],
      ['kevin durant', { team: 'Phoenix Suns', sport: 'nba', positions: ['SF', 'PF'] }],
      ['giannis antetokounmpo', { team: 'Milwaukee Bucks', sport: 'nba', positions: ['PF', 'C'] }],
      ['shohei ohtani', { team: 'Los Angeles Dodgers', sport: 'mlb', positions: ['DH', 'SP'] }],
      ['aaron judge', { team: 'New York Yankees', sport: 'mlb', positions: ['RF'] }],
      ['mookie betts', { team: 'Los Angeles Dodgers', sport: 'mlb', positions: ['RF', 'SS'] }],
    ]);
    this.sportRealisticRanges = new Map([
      ['americanfootball_nfl', {
        totals: { min: 30, max: 60, typical: [40, 55] },
        spreads: { min: -20, max: 20, typical: [-14, 14] },
        playerProps: { passingYards: { min: 150, max: 450 }, rushingYards: { min: 30, max: 180 }, receivingYards: { min: 20, max: 200 } },
      }],
      ['basketball_nba', {
        totals: { min: 180, max: 250, typical: [210, 235] },
        spreads: { min: -25, max: 25, typical: [-12, 12] },
        playerProps: { points: { min: 5, max: 60 }, rebounds: { min: 2, max: 25 }, assists: { min: 1, max: 20 } },
      }],
      ['baseball_mlb', {
        totals: { min: 5, max: 15, typical: [6, 11] },
        spreads: { min: -3, max: 3, typical: [-2.5, 2.5] },
        playerProps: { hits: { min: 0.5, max: 4.5 }, strikeouts: { min: 1.5, max: 12.5 } },
      }],
      ['americanfootball_ncaaf', {
        totals: { min: 30, max: 80, typical: [45, 65] },
        spreads: { min: -35, max: 35, typical: [-28, 28] },
      }],
    ]);
  }

  validatePlayerTeamAlignment(playerName, gameContext) {
    if (!playerName || !gameContext) return { valid: true };
    const normalizedPlayer = playerName.toLowerCase().trim();
    const playerData = this.establishedPlayers.get(normalizedPlayer);
    if (!playerData) return { valid: true };
    const expectedTeam = playerData.team.toLowerCase();
    const homeTeam = (gameContext.home_team || '').toLowerCase();
    const awayTeam = (gameContext.away_team || '').toLowerCase();
    const isValid = homeTeam.includes(expectedTeam) || awayTeam.includes(expectedTeam);
    if (!isValid) {
      return {
        valid: false,
        error: `Player ${playerName} plays for ${playerData.team}, not in ${gameContext.away_team} vs ${gameContext.home_team}`,
        severity: 'high',
      };
    }
    return { valid: true, playerData };
  }

  validateBettingLine(market, point, odds, sport) {
    const sportRanges = this.sportRealisticRanges.get(sport);
    if (!sportRanges) return { valid: true };
    const validation = { valid: true, warnings: [] };
    if (point !== undefined && point !== null) {
      const marketRange = sportRanges[market];
      if (marketRange && (point < marketRange.min || point > marketRange.max)) {
        validation.valid = false;
        validation.errors = [
          `Implausible ${market} line: ${point} for ${sport}. Realistic range: ${marketRange.min} to ${marketRange.max}`,
        ];
        return validation;
      }
    }
    if (odds && Math.abs(odds) > 10000) {
      validation.warnings.push(`Extreme odds detected: ${odds}. Verify line accuracy.`);
    }
    return validation;
  }

  validateGameContext(legs, gameContext) {
    if (!gameContext) return { validLegs: legs || [], errors: [] };
    const expectedGame = `${gameContext.away_team} @ ${gameContext.home_team}`;
    const errors = [];
    const validLegs = [];
    const warnings = [];
    if (!legs || !Array.isArray(legs) || legs.length === 0) {
      return { validLegs: [], errors: ['No legs provided for validation'] };
    }
    legs.forEach((leg, index) => {
      const legGame = leg.event || '';
      if (!legGame || legGame.trim() === '') {
        warnings.push(`Leg ${index + 1} missing game context - auto-assigning to selected game`);
        validLegs.push({
          ...leg,
          event: expectedGame,
          commence_time: leg.commence_time || gameContext.commence_time,
        });
        return;
      }
      const normalizeGameName = (name) =>
        (name || '')
          .toLowerCase()
          .replace(/[^a-z0-9@ ]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const normalizedLegGame = normalizeGameName(legGame);
      const normalizedExpectedGame = normalizeGameName(expectedGame);
      const normalizedReverseGame = normalizeGameName(`${gameContext.home_team} @ ${gameContext.away_team}`);
      const isSameGame =
        normalizedLegGame === normalizedExpectedGame || normalizedLegGame === normalizedReverseGame;
      if (isSameGame) {
        validLegs.push({
          ...leg,
          event: expectedGame,
          commence_time: leg.commence_time || gameContext.commence_time,
        });
      } else {
        errors.push(
          `Game mismatch in leg ${index + 1}: "${legGame}" vs selected game "${expectedGame}"`
        );
      }
    });
    return { validLegs, errors, warnings };
  }

  comprehensiveParlayValidation(parlayData, gameContext, sportKey) {
    const errors = [];
    const warnings = [];
    let validLegs = [];
    if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
      throw new Error('AI response missing legs array - invalid parlay structure');
    }
    const gameValidation = this.validateGameContext(parlayData.legs, gameContext);
    
    errors.push(...gameValidation.errors);
    warnings.push(...gameValidation.warnings);

    gameValidation.validLegs.forEach((leg, index) => {
      try {
        let isLegValid = true;
        if (leg.selection) {
          const playerValidation = this.validatePlayerTeamAlignment(leg.selection, gameContext);
          if (!playerValidation.valid) {
            errors.push(`Leg ${index + 1}: ${playerValidation.error}`);
            isLegValid = false;
          }
        }
        const lineValidation = this.validateBettingLine(
          leg.market,
          leg.point,
          leg.odds?.american,
          sportKey
        );
        if (!lineValidation.valid) {
          errors.push(...lineValidation.errors);
          isLegValid = false;
        }
        if (lineValidation.warnings?.length) warnings.push(...lineValidation.warnings);
        if (!leg.selection || leg.selection.trim() === '') {
          errors.push(`Leg ${index + 1}: Missing selection description`);
          isLegValid = false;
        }
        if (!leg.odds || !leg.odds.american) {
          warnings.push(`Leg ${index + 1}: Missing or incomplete odds data`);
        }
        if(isLegValid) {
          validLegs.push(leg);
        }
      } catch (legError) {
        errors.push(`Leg ${index + 1} validation error: ${legError.message}`);
      }
    });

    const validationSummary = {
      originalCount: parlayData.legs.length,
      validCount: validLegs.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      qualityScore: parlayData.legs.length > 0 ? (validLegs.length / parlayData.legs.length) * 100 : 0,
      recommendation:
        validLegs.length === 0 ? 'REJECT' : validLegs.length === parlayData.legs.length ? 'ACCEPT' : 'PARTIAL',
    };

    return {
      ...parlayData,
      legs: validLegs,
      validation: {
        ...validationSummary,
        errors,
        warnings,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

class QuantumAIService {
  constructor() {
    this.validator = new QuantumValidationEngine();
    this.requestCache = new Map();
    this.cacheTTL = 300000;
  }

  _ensureLegsHaveOdds(legs) {
    if (!Array.isArray(legs)) return [];
    return legs.map((leg, index) => {
      const hasValidOdds = leg && leg.odds && Number.isFinite(Number(leg.odds.american));
      if (hasValidOdds) {
        const american = Number(leg.odds.american);
        const decimal = EliteBettingMathematics.americanToDecimal(american);
        const impliedProb = EliteBettingMathematics.calculateImpliedProbability(american);
        return { ...leg, odds: { american, decimal, implied_probability: impliedProb } };
      }
      console.warn(`⚠️ Leg ${index + 1} missing valid odds: "${leg.selection}". Applying intelligent defaults.`);
      let defaultOdds = -110;
      if (leg.market === 'h2h') defaultOdds = -110;
      else if (leg.market === 'totals') defaultOdds = -110;
      else if (leg.market?.includes('player')) defaultOdds = -115;
      const decimal = EliteBettingMathematics.americanToDecimal(defaultOdds);
      const impliedProb = EliteBettingMathematics.calculateImpliedProbability(defaultOdds);
      return {
        ...leg,
        odds: { american: defaultOdds, decimal, implied_probability: impliedProb },
        quantum_analysis: {
          ...leg.quantum_analysis,
          analytical_basis: `(Intelligent odds applied: ${defaultOdds}) ${
            leg.quantum_analysis?.analytical_basis || 'Market-based default odds applied for analysis.'
          }`,
        },
      };
    });
  }

  async _callAIProvider(prompt, context = {}) {
    const { PERPLEXITY_API_KEY } = env;
    if (!PERPLEXITY_API_KEY) throw new Error('Perplexity API key not configured - check environment variables');

    const cacheKey = `ai_request_${Buffer.from(prompt).toString('base64').slice(0, 50)}`;
    const cached = this.requestCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log('🎯 AI Response cache HIT');
      return cached.data;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`🔄 AI Provider Request (Attempt ${attempt}/${MAX_RETRIES})`);
      try {
        const startTime = Date.now();
        const response = await axios.post(
          'https://api.perplexity.ai/chat/completions',
          {
            model: AI_MODELS.perplexity,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 4000,
          },
          {
            headers: {
              Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: WEB_TIMEOUT_MS,
          }
        );
        const responseTime = Date.now() - startTime;
        console.log(`✅ AI Response received in ${responseTime}ms`);
        const responseText = response?.data?.choices?.[0]?.message?.content || '';
        if (!responseText) throw new Error('Empty response from AI provider');

        // Strict extraction + schema validation
        const parsed = strictExtractJSONObject(responseText);
        if (!isValidParlay(parsed, context.numLegs || 1)) {
          throw new Error('AI JSON failed schema validation');
        }

        // Cache and return
        this.requestCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
        return parsed;
      } catch (error) {
        console.error(`❌ AI Provider Error (Attempt ${attempt}):`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
        });
        if (attempt === MAX_RETRIES) {
          if (error.response?.status === 401 || error.response?.status === 403) {
            throw new Error('Perplexity API authentication failed - check API key');
          } else if (error.response?.status === 429) {
            throw new Error('AI provider rate limit exceeded - try again shortly');
          } else if (error.code === 'ECONNABORTED') {
            throw new Error('AI provider request timeout - service may be overloaded');
          }
          throw new Error(`AI provider failed after ${MAX_RETRIES} attempts: ${error.message}`);
        }
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
    throw new Error('Unreachable');
  }

  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options = {}) {
    const userAIConfig = await getAIConfig(options.chatId || 'default');
    const effectiveMode = mode || userAIConfig.mode || 'web';
    const effectiveBetType = betType || userAIConfig.betType || 'mixed';
    const effectiveHorizonHours = options.horizonHours || userAIConfig.horizonHours || 72;
    console.log(
      `🎯 Using settings - Mode: ${effectiveMode}, BetType: ${effectiveBetType}, Horizon: ${effectiveHorizonHours}h`
    );

    const requestId = `quantum_${sportKey}_${Date.now()}`;
    const startTime = Date.now();
    console.log('🎯 QUANTUM PARLAY GENERATION INITIATED', {
      requestId,
      sport: sportKey,
      legs: numLegs,
      mode: effectiveMode,
      betType: effectiveBetType,
      gameContext: options.gameContext
        ? `${options.gameContext.away_team} @ ${options.gameContext.home_team}`
        : 'None',
    });

    try {
      let parlayData;
      if (effectiveMode === 'web' || effectiveMode === 'live') {
        parlayData = await this._generateWebParlay(sportKey, numLegs, effectiveBetType, {
          ...options,
          horizonHours: effectiveHorizonHours,
        });
      } else {
        parlayData = await this._generateContextParlay(
          sportKey,
          numLegs,
          effectiveMode,
          effectiveBetType,
          { ...options, horizonHours: effectiveHorizonHours }
        );
      }

      const generationTime = Date.now() - startTime;
      console.log('✅ QUANTUM PARLAY GENERATION COMPLETED', {
        requestId,
        generationTime: `${generationTime}ms`,
        legsGenerated: parlayData.legs?.length || 0,
        validationScore: parlayData.validation?.qualityScore || 'N/A',
      });
      return parlayData;
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error('❌ QUANTUM PARLAY GENERATION FAILED', {
        requestId,
        error: error.message,
        duration: `${errorTime}ms`,
        sport: sportKey,
      });
      return await this._generateIntelligentFallback(
        sportKey,
        numLegs,
        effectiveBetType,
        { ...options, horizonHours: effectiveHorizonHours },
        error
      );
    }
  }

  async _generateWebParlay(sportKey, numLegs, betType, options) {
    console.log('🌐 GENERATING WEB-RESEARCH PARLAY');
    const scheduleContext = await this._buildScheduleContext(
      sportKey,
      options.horizonHours || 72,
      options.gameContext
    );
    const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, {
      scheduleInfo: scheduleContext,
      gameContext: options.gameContext,
    });
    console.log('📝 AI Prompt prepared with game context validation');

    const parlayData = await this._callAIProvider(prompt, {
      sportKey,
      numLegs,
      gameContext: options.gameContext,
    });
    if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
      throw new Error('AI response invalid: missing legs array');
    }
    console.log(`🤖 AI generated ${parlayData.legs.length} raw legs`);

    const validatedParlay = this.validator.comprehensiveParlayValidation(
      parlayData,
      options.gameContext,
      sportKey
    );
    validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);
    validatedParlay.parlay_price_decimal = this._calculateParlayDecimal(validatedParlay.legs);
    validatedParlay.parlay_price_american =
      EliteBettingMathematics.decimalToAmerican(validatedParlay.parlay_price_decimal);

    try {
      validatedParlay.quantitative_analysis = await quantitativeService.evaluateParlay(
        validatedParlay.legs,
        validatedParlay.parlay_price_decimal
      );
    } catch (qError) {
      console.warn('Quantitative analysis subsystem offline:', qError.message);
      validatedParlay.quantitative_analysis = {
        note: 'Advanced analytics temporarily unavailable',
        riskAssessment: { overallRisk: 'CALCULATED' },
      };
    }

    validatedParlay.research_metadata = {
      quantum_mode: true,
      generation_strategy: 'web_research',
      game_context_used: !!options.gameContext,
      legs_requested: numLegs,
      legs_delivered: validatedParlay.legs.length,
      validation_quality: validatedParlay.validation.qualityScore,
      generated_at: new Date().toISOString(),
    };

    console.log(`🎉 Web parlay generation completed: ${validatedParlay.legs.length}/${numLegs} legs`);
    return validatedParlay;
  }

  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`💾 GENERATING DATABASE-DRIVEN PARLAY (${mode} mode)`);
    try {
      const allGames = options.gameContext
        ? [options.gameContext]
        : await gamesService.getGamesForSport(sportKey, {
            hoursAhead: options.horizonHours || 72,
            includeOdds: true,
            useCache: false,
            chatId: options.chatId,
          });
      if (!allGames || allGames.length === 0) {
        throw new Error(`No games available for ${sportKey} in database`);
      }

      console.log(`🔍 Analyzing ${allGames.length} games for +EV opportunities...`);
      const bestPlays = await this._findBestValuePlays(allGames);
      if (bestPlays.length < numLegs) {
        return {
          legs: [],
          portfolio_construction: {
            overall_thesis: `Market Analysis: Insufficient +EV opportunities found for ${numLegs}-leg parlay. Professional discipline requires passing when edge isn't present.`,
          },
          research_metadata: {
            analysis_mode: 'database_quant',
            games_analyzed: allGames.length,
            ev_opportunities: bestPlays.length,
            recommendation: 'PASS',
          },
        };
      }

      const topPlays = bestPlays.slice(0, numLegs);
      const parlayLegs = topPlays.map((play) => ({
        game_id: play.game.event_id || play.game.id, // normalize id
        event: `${play.game.away_team} @ ${play.game.home_team}`,
        commence_time: play.game.commence_time,
        market: play.market.key,
        selection: `${play.outcome.name} ${play.outcome.point || ''}`.trim(),
        odds: {
          american: play.outcome.price,
          decimal: EliteBettingMathematics.americanToDecimal(play.outcome.price),
          implied_probability: EliteBettingMathematics.calculateImpliedProbability(play.outcome.price),
        },
        quantum_analysis: {
          confidence_score: Math.min(95, (play.noVigProb || 0) * 100),
          analytical_basis: `Quantitative Edge: +${play.ev.toFixed(1)}% EV identified. No-vig probability ${((play.noVigProb || 0) * 100).toFixed(1)}% exceeds market implied.`,
          key_factors: ['market_inefficiency', 'probability_discrepancy', 'quantitative_edge'],
          kelly_fraction: EliteBettingMathematics.kellyCriterion(
            play.noVigProb || 0.5,
            EliteBettingMathematics.americanToDecimal(play.outcome.price)
          ).toFixed(3),
        },
      }));

      const parlayData = { legs: parlayLegs };
      parlayData.parlay_price_decimal = this._calculateParlayDecimal(parlayData.legs);
      parlayData.parlay_price_american = EliteBettingMathematics.decimalToAmerican(
        parlayData.parlay_price_decimal
      );

      try {
        parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(
          parlayData.legs,
          parlayData.parlay_price_decimal
        );
      } catch {
        parlayData.quantitative_analysis = { note: 'Advanced quantitative analysis unavailable' };
      }

      parlayData.research_metadata = {
        mode,
        quantum_mode: true,
        games_analyzed: allGames.length,
        ev_opportunities_found: bestPlays.length,
        average_ev: (
          bestPlays.reduce((sum, play) => sum + play.ev, 0) / bestPlays.length
        ).toFixed(1),
        generation_strategy: 'database_quant_selection',
      };

      console.log(
        `✅ Database parlay built: ${numLegs} legs with average EV +${parlayData.research_metadata.average_ev}%`
      );
      return parlayData;
    } catch (error) {
      console.error('❌ Database parlay generation failed:', error.message);
      throw error;
    }
  }

  async _generateIntelligentFallback(sportKey, numLegs, betType, options, originalError) {
    console.log('🔄 ACTIVATING INTELLIGENT FALLBACK STRATEGY');
    try {
      const horizonHours = options.horizonHours || 168;
      const scheduleContext = await this._buildScheduleContext(sportKey, horizonHours, options.gameContext);
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, {
        scheduleInfo: scheduleContext,
        gameContext: options.gameContext,
        originalError: originalError?.message,
      });
      const parlayData = await this._callAIProvider(prompt, { numLegs });
      if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
        throw new Error('Fallback AI response invalid');
      }
      const validatedParlay = this.validator.comprehensiveParlayValidation(
        parlayData,
        options.gameContext,
        sportKey
      );
      validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);
      validatedParlay.parlay_price_decimal = this._calculateParlayDecimal(validatedParlay.legs);
      validatedParlay.parlay_price_american = EliteBettingMathematics.decimalToAmerican(
        validatedParlay.parlay_price_decimal
      );
      validatedParlay.research_metadata = {
        quantum_mode: true,
        fallback_used: true,
        original_error: originalError?.message,
        generation_strategy: 'intelligent_fallback',
        legs_delivered: validatedParlay.legs.length,
        validation_quality: validatedParlay.validation.qualityScore,
        generated_at: new Date().toISOString(),
      };
      console.log(`🆘 Fallback parlay delivered: ${validatedParlay.legs.length} legs`);
      return validatedParlay;
    } catch (fallbackError) {
      console.error('💥 CRITICAL: All parlay generation strategies failed:', fallbackError.message);
      return {
        legs: [],
        portfolio_construction: {
          overall_thesis:
            'SYSTEM UNAVAILABLE: All parlay generation systems are currently offline. Please try again in 5-10 minutes.',
        },
        research_metadata: {
          emergency_fallback: true,
          error: fallbackError.message,
          original_error: originalError?.message,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  _calculateParlayDecimal(legs) {
    return (legs || []).reduce((acc, leg) => {
      const legDecimal = leg.odds?.decimal || EliteBettingMathematics.americanToDecimal(-110);
      return acc * legDecimal;
    }, 1);
  }

  _calculateLegIndependence(legs) {
    const uniqueGames = new Set(legs.map((leg) => leg.event));
    const uniqueMarkets = new Set(legs.map((leg) => leg.market));
    const gameDiversity = (uniqueGames.size / legs.length) * 50;
    const marketDiversity = (uniqueMarkets.size / legs.length) * 50;
    return Math.min(100, gameDiversity + marketDiversity);
  }

  _calculateBankrollAllocation(parlayDecimal, averageEV) {
    const baseAllocation = 2;
    const evBonus = Math.min(3, averageEV / 5);
    const oddsAdjustment = parlayDecimal > 10 ? -1 : 0;
    return Math.max(0.5, Math.min(5, baseAllocation + evBonus + oddsAdjustment));
  }

  async _findBestValuePlays(games) {
    const valuePlays = [];
    if (!games || games.length === 0) return valuePlays;
    for (const game of games) {
      const bookmaker = game.bookmakers?.[0];
      if (!bookmaker?.markets) continue;

      const h2hMarket = bookmaker.markets.find((m) => m.key === 'h2h');
      if (h2hMarket?.outcomes?.length >= 2) {
        const home = h2hMarket.outcomes.find((o) => o.name === game.home_team);
        const away = h2hMarket.outcomes.find((o) => o.name === game.away_team);
        if (home && away && home.price && away.price) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(home.price, away.price);
          if (noVig) {
            const evHome =
              EliteBettingMathematics.calculateExpectedValue(
                noVig.home,
                EliteBettingMathematics.americanToDecimal(home.price)
              ) * 100;
            const evAway =
              EliteBettingMathematics.calculateExpectedValue(
                noVig.away,
                EliteBettingMathematics.americanToDecimal(away.price)
              ) * 100;
            if (evHome > 0) valuePlays.push({ game, market: h2hMarket, outcome: home, ev: evHome, noVigProb: noVig.home });
            if (evAway > 0) valuePlays.push({ game, market: h2hMarket, outcome: away, ev: evAway, noVigProb: noVig.away });
          }
        }
      }

      const totalsMarket = bookmaker.markets.find((m) => m.key === 'totals');
      if (totalsMarket?.outcomes?.length === 2) {
        const over = totalsMarket.outcomes.find((o) => o.name === 'Over');
        const under = totalsMarket.outcomes.find((o) => o.name === 'Under');
        if (over && under && over.price && under.price) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(over.price, under.price);
          if (noVig) {
            const evOver =
              EliteBettingMathematics.calculateExpectedValue(
                noVig.home,
                EliteBettingMathematics.americanToDecimal(over.price)
              ) * 100;
            const evUnder =
              EliteBettingMathematics.calculateExpectedValue(
                noVig.away,
                EliteBettingMathematics.americanToDecimal(under.price)
              ) * 100;
            if (evOver > 0)
              valuePlays.push({ game, market: totalsMarket, outcome: over, ev: evOver, noVigProb: noVig.home });
            if (evUnder > 0)
              valuePlays.push({ game, market: totalsMarket, outcome: under, ev: evUnder, noVigProb: noVig.away });
          }
        }
      }
    }
    return valuePlays.sort((a, b) => b.ev - a.ev);
  }

  async _buildScheduleContext(sportKey, hours, gameContext = null) {
    try {
      const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
      if (realGames.length === 0) {
        return `\n\n🎯 ELITE ANALYST MODE: No real-time ${sportKey} data available. Using fundamental analysis principles.`;
      }
      if (gameContext) {
        const focusedGame = realGames.find(
          (game) =>
            game.id === gameContext.id ||
            game.event_id === gameContext.event_id ||
            `${game.away_team} @ ${game.home_team}` ===
              `${gameContext.away_team} @ ${gameContext.home_team}`
        );
        if (focusedGame) {
          const timeStr = new Date(focusedGame.commence_time).toLocaleString('en-US', {
            timeZone: TZ,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          return `\n\n🎯 FOCUS GAME ANALYSIS REQUIRED:\n${focusedGame.away_team} @ ${focusedGame.home_team} - ${timeStr} ${TZ}\n\nCRITICAL: All analysis MUST be based exclusively on this specific matchup.`;
        }
      }
      const gameList = realGames
        .slice(0, 15)
        .map((game, index) => {
          const timeStr = new Date(game.commence_time).toLocaleString('en-US', {
            timeZone: TZ,
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
        })
        .join('\n');
      return `\n\n📅 VERIFIED SCHEDULE (Next ${hours} hours):\n${gameList}\n\nANALYTICAL MANDATE: Base all research exclusively on these verified matchups.`;
    } catch (error) {
      console.warn('⚠️ Schedule context build failed:', error.message);
      return `\n\n🎯 ELITE ANALYST MODE: Live data temporarily limited. Applying fundamental sports analysis methodologies.`;
    }
  }

  clearCache() {
    this.requestCache.clear();
    console.log('🧹 AI Service cache cleared');
  }

  getCacheStats() {
    return { size: this.requestCache.size, keys: Array.from(this.requestCache.keys()) };
  }
}

const quantumAIService = new QuantumAIService();
export default quantumAIService;
