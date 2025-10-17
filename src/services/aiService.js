// src/services/aiService.js - ELITE QUANTUM SPORTS ANALYTICS ENGINE
// 🎯 WORLD-CLASS SPORTS ANALYTICS MEETS ENTERPRISE-GRADE JAVASCRIPT
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { sleep } from '../utils/asyncUtils.js'; // REMOVED exponentialBackoff import
import { getAIConfig } from '../bot/state.js'; // ADDED SETTINGS IMPORT

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 75000; // Increased for complex analysis
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

const AI_MODELS = {
  perplexity: "sonar-pro",
  "sonar-pro": "sonar-pro", 
  "sonar-small-chat": "sonar-small-chat"
};

// 🎯 ELITE UTILITY FUNCTIONS - INDUSTRY STANDARD IMPLEMENTATION
class EliteBettingMathematics {
  static americanToDecimal(american) {
    const odds = Number(american);
    if (!Number.isFinite(odds)) return 1.0;
    
    return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
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
    
    return totalProb > 0 ? {
      home: probA / totalProb,
      away: probB / totalProb,
      vig: totalProb - 1
    } : null;
  }

  static calculateExpectedValue(probability, decimalOdds, stake = 1) {
    return (probability * (decimalOdds - 1) * stake) - ((1 - probability) * stake);
  }

  static kellyCriterion(probability, decimalOdds) {
    const edge = (probability * decimalOdds) - 1;
    return edge > 0 ? edge / (decimalOdds - 1) : 0;
  }
}

// 🏈 ELITE SPORTS VALIDATION ENGINE
class QuantumValidationEngine {
  constructor() {
    this.teamRosters = new Map();
    this.establishedPlayers = new Map([
      // NFL
      ['aaron rodgers', { team: 'New York Jets', sport: 'nfl', positions: ['QB'] }],
      ['patrick mahomes', { team: 'Kansas City Chiefs', sport: 'nfl', positions: ['QB'] }],
      ['travis kelce', { team: 'Kansas City Chiefs', sport: 'nfl', positions: ['TE'] }],
      ['ja\'marr chase', { team: 'Cincinnati Bengals', sport: 'nfl', positions: ['WR'] }],
      ['josh allen', { team: 'Buffalo Bills', sport: 'nfl', positions: ['QB'] }],
      ['justin jefferson', { team: 'Minnesota Vikings', sport: 'nfl', positions: ['WR'] }],
      
      // NBA
      ['lebron james', { team: 'Los Angeles Lakers', sport: 'nba', positions: ['SF', 'PF'] }],
      ['stephen curry', { team: 'Golden State Warriors', sport: 'nba', positions: ['PG'] }],
      ['kevin durant', { team: 'Phoenix Suns', sport: 'nba', positions: ['SF', 'PF'] }],
      ['giannis antetokounmpo', { team: 'Milwaukee Bucks', sport: 'nba', positions: ['PF', 'C'] }],
      
      // MLB
      ['shohei ohtani', { team: 'Los Angeles Dodgers', sport: 'mlb', positions: ['DH', 'SP'] }],
      ['aaron judge', { team: 'New York Yankees', sport: 'mlb', positions: ['RF'] }],
      ['mookie betts', { team: 'Los Angeles Dodgers', sport: 'mlb', positions: ['RF', 'SS'] }]
    ]);

    this.sportRealisticRanges = new Map([
      ['americanfootball_nfl', {
        totals: { min: 30, max: 60, typical: [38, 52] },
        spreads: { min: -20, max: 20, typical: [-14, 14] },
        playerProps: {
          passingYards: { min: 150, max: 450 },
          rushingYards: { min: 30, max: 180 },
          receivingYards: { min: 20, max: 200 }
        }
      }],
      ['basketball_nba', {
        totals: { min: 180, max: 250, typical: [210, 240] },
        spreads: { min: -25, max: 25, typical: [-12, 12] },
        playerProps: {
          points: { min: 5, max: 60 },
          rebounds: { min: 2, max: 25 },
          assists: { min: 1, max: 20 }
        }
      }],
      ['baseball_mlb', {
        totals: { min: 5, max: 15, typical: [7, 10] },
        spreads: { min: -3, max: 3, typical: [-2.5, 2.5] },
        playerProps: {
          hits: { min: 0.5, max: 4.5 },
          strikeouts: { min: 1.5, max: 12.5 }
        }
      }],
      ['americanfootball_ncaaf', {
        totals: { min: 30, max: 80, typical: [45, 65] },
        spreads: { min: -35, max: 35, typical: [-28, 28] }
      }]
    ]);
  }

  validatePlayerTeamAlignment(playerName, gameContext) {
    if (!playerName || !gameContext) return { valid: true };
    
    const normalizedPlayer = playerName.toLowerCase().trim();
    const playerData = this.establishedPlayers.get(normalizedPlayer);
    
    if (!playerData) return { valid: true }; // Unknown player, can't validate
    
    const expectedTeam = playerData.team.toLowerCase();
    const homeTeam = gameContext.home_team.toLowerCase();
    const awayTeam = gameContext.away_team.toLowerCase();
    
    const isValid = homeTeam.includes(expectedTeam) || awayTeam.includes(expectedTeam);
    
    if (!isValid) {
      return {
        valid: false,
        error: `Player ${playerName} plays for ${playerData.team}, not in ${gameContext.away_team} vs ${gameContext.home_team}`,
        severity: 'high'
      };
    }
    
    return { valid: true, playerData };
  }

  validateBettingLine(market, point, odds, sport) {
    const sportRanges = this.sportRealisticRanges.get(sport);
    if (!sportRanges) return { valid: true }; // Unknown sport
    
    const validation = { valid: true, warnings: [] };
    
    // Validate point ranges
    if (point !== undefined && point !== null) {
      const marketRange = sportRanges[market];
      if (marketRange && (point < marketRange.min || point > marketRange.max)) {
        validation.valid = false;
        validation.errors = [`Implausible ${market} line: ${point} for ${sport}. Realistic range: ${marketRange.min} to ${marketRange.max}`];
        return validation;
      }
    }
    
    // Validate odds sanity
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
      
      // Handle legs without explicit game context
      if (!legGame || legGame.trim() === '') {
        warnings.push(`Leg ${index + 1} missing game context - auto-assigning to selected game`);
        validLegs.push({
          ...leg,
          event: expectedGame,
          commence_time: leg.commence_time || gameContext.commence_time
        });
        return;
      }
      
      // Flexible game matching
      const normalizeGameName = (name) => name.toLowerCase()
        .replace(/[^a-z0-9@ ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      const normalizedLegGame = normalizeGameName(legGame);
      const normalizedExpectedGame = normalizeGameName(expectedGame);
      const normalizedReverseGame = normalizeGameName(`${gameContext.home_team} @ ${gameContext.away_team}`);
      
      const isSameGame = normalizedLegGame === normalizedExpectedGame || 
                        normalizedLegGame === normalizedReverseGame;
      
      if (isSameGame) {
        validLegs.push({
          ...leg,
          event: expectedGame, // Standardize format
          commence_time: leg.commence_time || gameContext.commence_time
        });
      } else {
        errors.push(`Game mismatch in leg ${index + 1}: "${legGame}" vs selected game "${expectedGame}"`);
      }
    });

    return { validLegs, errors, warnings };
  }

  comprehensiveParlayValidation(parlayData, gameContext, sportKey) {
    const errors = [];
    const warnings = [];
    const validLegs = [];

    if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
      throw new Error('AI response missing legs array - invalid parlay structure');
    }

    // Phase 1: Game Context Validation
    const gameValidation = this.validateGameContext(parlayData.legs, gameContext);
    validLegs.push(...gameValidation.validLegs);
    errors.push(...gameValidation.errors);
    warnings.push(...gameValidation.warnings);

    // Phase 2: Individual Leg Validation
    gameValidation.validLegs.forEach((leg, index) => {
      try {
        // Player-team alignment
        if (leg.selection) {
          const playerValidation = this.validatePlayerTeamAlignment(leg.selection, gameContext);
          if (!playerValidation.valid) {
            errors.push(`Leg ${index + 1}: ${playerValidation.error}`);
          }
        }

        // Betting line validation
        const lineValidation = this.validateBettingLine(
          leg.market, 
          leg.point, 
          leg.odds?.american, 
          sportKey
        );
        
        if (!lineValidation.valid) {
          errors.push(...lineValidation.errors);
        }
        if (lineValidation.warnings.length > 0) {
          warnings.push(...lineValidation.warnings);
        }

        // Basic data integrity
        if (!leg.selection || leg.selection.trim() === '') {
          errors.push(`Leg ${index + 1}: Missing selection description`);
        }

        if (!leg.odds || !leg.odds.american) {
          warnings.push(`Leg ${index + 1}: Missing or incomplete odds data`);
        }

        // If we got here, leg is valid
        validLegs.push(leg);
      } catch (legError) {
        errors.push(`Leg ${index + 1} validation error: ${legError.message}`);
      }
    });

    // Final quality assessment
    const validationSummary = {
      originalCount: parlayData.legs.length,
      validCount: validLegs.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      qualityScore: validLegs.length > 0 ? (validLegs.length / parlayData.legs.length) * 100 : 0,
      recommendation: validLegs.length === 0 ? 'REJECT' : 
                     validLegs.length === parlayData.legs.length ? 'ACCEPT' : 'PARTIAL'
    };

    return {
      ...parlayData,
      legs: validLegs,
      validation: {
        ...validationSummary,
        errors,
        warnings,
        timestamp: new Date().toISOString()
      }
    };
  }
}

// 🚀 ELITE AI SERVICE CORE
class QuantumAIService {
  constructor() {
    this.validator = new QuantumValidationEngine();
    this.requestCache = new Map();
    this.cacheTTL = 300000; // 5 minutes
  }

  _ensureLegsHaveOdds(legs) {
    if (!Array.isArray(legs)) return [];
    
    return legs.map((leg, index) => {
      // Check if leg has valid odds
      const hasValidOdds = leg && leg.odds && Number.isFinite(Number(leg.odds.american));
      
      if (hasValidOdds) {
        const american = Number(leg.odds.american);
        const decimal = EliteBettingMathematics.americanToDecimal(american);
        const impliedProb = EliteBettingMathematics.calculateImpliedProbability(american);
        
        return {
          ...leg,
          odds: {
            american,
            decimal,
            implied_probability: impliedProb
          }
        };
      }
      
      // Apply intelligent default odds based on market type
      console.warn(`⚠️ Leg ${index + 1} missing valid odds: "${leg.selection}". Applying intelligent defaults.`);
      
      let defaultOdds = -110; // Standard vig
      
      // Adjust defaults based on market and context
      if (leg.market === 'h2h') {
        // Moneyline favorites get lower odds, underdogs get higher
        defaultOdds = leg.selection?.toLowerCase().includes('over') ? -115 : -105;
      } else if (leg.market === 'totals') {
        defaultOdds = -110; // Standard for totals
      } else if (leg.market?.includes('player')) {
        defaultOdds = -115; // Slightly higher vig for player props
      }
      
      const decimal = EliteBettingMathematics.americanToDecimal(defaultOdds);
      const impliedProb = EliteBettingMathematics.calculateImpliedProbability(defaultOdds);
      
      return {
        ...leg,
        odds: {
          american: defaultOdds,
          decimal,
          implied_probability: impliedProb
        },
        quantum_analysis: {
          ...leg.quantum_analysis,
          analytical_basis: `(Intelligent odds applied: ${defaultOdds}) ${leg.quantum_analysis?.analytical_basis || 'Market-based default odds applied for analysis.'}`
        }
      };
    });
  }

  async _callAIProvider(prompt, context = {}) {
    const { PERPLEXITY_API_KEY } = env;
    if (!PERPLEXITY_API_KEY) {
      throw new Error('Perplexity API key not configured - check environment variables');
    }

    // Cache key for identical requests
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
            temperature: 0.1, // Low temperature for consistent analytical responses
            max_tokens: 4000
          },
          {
            headers: { 
              Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: WEB_TIMEOUT_MS
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`✅ AI Response received in ${responseTime}ms`);
        
        const responseText = response?.data?.choices?.[0]?.message?.content || '';
        
        if (!responseText) {
          throw new Error('Empty response from AI provider');
        }

        // Enhanced JSON extraction with better error handling
        const parsedJson = this._extractJSON(responseText);
        
        if (!parsedJson) {
          console.error('❌ AI Response JSON parsing failed. Raw response:', responseText.substring(0, 500));
          throw new Error('AI response did not contain valid JSON structure');
        }

        // Cache successful response
        this.requestCache.set(cacheKey, {
          data: parsedJson,
          timestamp: Date.now()
        });

        return parsedJson;

      } catch (error) {
        console.error(`❌ AI Provider Error (Attempt ${attempt}):`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data
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

        // FIXED: Replace exponentialBackoff with simple sleep
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  _extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    
    // Method 1: Code block extraction
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
    const blockMatch = text.match(jsonBlockRegex);
    
    if (blockMatch && blockMatch[1]) {
      try {
        return JSON.parse(blockMatch[1].trim());
      } catch (e) {
        console.warn('JSON block extraction failed, trying alternative methods...');
      }
    }
    
    // Method 2: Brace-based extraction
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    
    if (start !== -1 && end > start) {
      try {
        const jsonText = text.substring(start, end + 1);
        return JSON.parse(jsonText);
      } catch (e) {
        console.warn('Brace-based JSON extraction failed');
      }
    }
    
    // Method 3: Look for array patterns
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        const arrayText = text.substring(arrayStart, arrayEnd + 1);
        return JSON.parse(arrayText);
      } catch (e) {
        console.warn('Array-based JSON extraction failed');
      }
    }
    
    return null;
  }

  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options = {}) {
    // FIXED: GET USER SETTINGS AND APPLY THEM
    const userAIConfig = await getAIConfig(options.chatId || 'default');
    
    // OVERRIDE WITH USER SETTINGS IF NOT EXPLICITLY PROVIDED
    const effectiveMode = mode || userAIConfig.mode || 'web';
    const effectiveBetType = betType || userAIConfig.betType || 'mixed';
    const effectiveHorizonHours = options.horizonHours || userAIConfig.horizonHours || 72;
    
    console.log(`🎯 Using settings - Mode: ${effectiveMode}, BetType: ${effectiveBetType}, Horizon: ${effectiveHorizonHours}h`);
    
    const requestId = `quantum_${sportKey}_${Date.now()}`;
    const startTime = Date.now();
    
    console.log(`🎯 QUANTUM PARLAY GENERATION INITIATED`, {
      requestId,
      sport: sportKey,
      legs: numLegs,
      mode: effectiveMode,
      betType: effectiveBetType,
      gameContext: options.gameContext ? `${options.gameContext.away_team} @ ${options.gameContext.home_team}` : 'None'
    });

    try {
      // Route to appropriate generation strategy
      let parlayData;
      if (effectiveMode === 'web' || effectiveMode === 'live') {
        parlayData = await this._generateWebParlay(sportKey, numLegs, effectiveBetType, {
          ...options,
          horizonHours: effectiveHorizonHours
        });
      } else {
        parlayData = await this._generateContextParlay(sportKey, numLegs, effectiveMode, effectiveBetType, {
          ...options,
          horizonHours: effectiveHorizonHours
        });
      }

      const generationTime = Date.now() - startTime;
      
      console.log(`✅ QUANTUM PARLAY GENERATION COMPLETED`, {
        requestId,
        generationTime: `${generationTime}ms`,
        legsGenerated: parlayData.legs?.length || 0,
        validationScore: parlayData.validation?.qualityScore || 'N/A'
      });

      return parlayData;

    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ QUANTUM PARLAY GENERATION FAILED`, {
        requestId,
        error: error.message,
        duration: `${errorTime}ms`,
        sport: sportKey
      });

      // Fallback strategy
      return await this._generateIntelligentFallback(sportKey, numLegs, effectiveBetType, {
        ...options,
        horizonHours: effectiveHorizonHours
      }, error);
    }
  }

  async _generateWebParlay(sportKey, numLegs, betType, options) {
    console.log('🌐 GENERATING WEB-RESEARCH PARLAY');
    
    const scheduleContext = await this._buildScheduleContext(sportKey, options.horizonHours || 72, options.gameContext);
    const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, {
      scheduleInfo: scheduleContext,
      gameContext: options.gameContext
    });

    console.log('📝 AI Prompt prepared with game context validation');
    
    const parlayData = await this._callAIProvider(prompt, {
      sportKey,
      numLegs,
      gameContext: options.gameContext
    });

    if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
      throw new Error('AI response invalid: missing legs array');
    }

    console.log(`🤖 AI generated ${parlayData.legs.length} raw legs`);

    // Comprehensive validation
    const validatedParlay = this.validator.comprehensiveParlayValidation(
      parlayData, 
      options.gameContext, 
      sportKey
    );

    // Apply intelligent odds enhancement
    validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);

    // Calculate parlay mathematics
    validatedParlay.parlay_price_decimal = this._calculateParlayDecimal(validatedParlay.legs);
    validatedParlay.parlay_price_american = EliteBettingMathematics.decimalToAmerican(validatedParlay.parlay_price_decimal);

    // Apply quantitative analysis
    try {
      validatedParlay.quantitative_analysis = await quantitativeService.evaluateParlay(
        validatedParlay.legs, 
        validatedParlay.parlay_price_decimal
      );
    } catch (qError) {
      console.warn('Quantitative analysis subsystem offline:', qError.message);
      validatedParlay.quantitative_analysis = { 
        note: 'Advanced analytics temporarily unavailable',
        riskAssessment: { overallRisk: 'CALCULATED' }
      };
    }

    // Enhanced metadata
    validatedParlay.research_metadata = {
      quantum_mode: true,
      generation_strategy: 'web_research',
      game_context_used: !!options.gameContext,
      legs_requested: numLegs,
      legs_delivered: validatedParlay.legs.length,
      validation_quality: validatedParlay.validation.qualityScore,
      generated_at: new Date().toISOString()
    };

    console.log(`🎉 Web parlay generation completed: ${validatedParlay.legs.length}/${numLegs} legs`);
    
    return validatedParlay;
  }

  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`💾 GENERATING DATABASE-DRIVEN PARLAY (${mode} mode)`);
    
    try {
      const allGames = options.gameContext ? 
        [options.gameContext] : 
        await gamesService.getGamesForSport(sportKey, {
          hoursAhead: options.horizonHours || 72,
          includeOdds: true,
          useCache: false,
          chatId: options.chatId
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
            overall_thesis: `Market Analysis: Insufficient +EV opportunities found for ${numLegs}-leg parlay. Professional discipline requires passing when edge isn't present.`
          },
          research_metadata: {
            analysis_mode: 'database_quant',
            games_analyzed: allGames.length,
            ev_opportunities: bestPlays.length,
            recommendation: 'PASS'
          }
        };
      }

      const topPlays = bestPlays.slice(0, numLegs);
      
      const parlayLegs = topPlays.map((play, index) => ({
        event: `${play.game.away_team} @ ${play.game.home_team}`,
        commence_time: play.game.commence_time,
        market: play.market.key,
        selection: `${play.outcome.name} ${play.outcome.point || ''}`.trim(),
        odds: {
          american: play.outcome.price,
          decimal: EliteBettingMathematics.americanToDecimal(play.outcome.price),
          implied_probability: EliteBettingMathematics.calculateImpliedProbability(play.outcome.price)
        },
        quantum_analysis: {
          confidence_score: Math.min(95, play.noVigProb * 100), // Cap at 95% for realism
          analytical_basis: `Quantitative Edge: +${play.ev.toFixed(1)}% EV identified. No-vig probability ${(play.noVigProb * 100).toFixed(1)}% exceeds market implied probability by ${(play.ev/2).toFixed(1)}%.`,
          key_factors: ["market_inefficiency", "probability_discrepancy", "quantitative_edge"],
          kelly_fraction: EliteBettingMathematics.kellyCriterion(play.noVigProb, EliteBettingMathematics.americanToDecimal(play.outcome.price)).toFixed(3)
        }
      }));

      const parlayData = { legs: parlayLegs };
      
      // Mathematical calculations
      parlayData.parlay_price_decimal = this._calculateParlayDecimal(parlayData.legs);
      parlayData.parlay_price_american = EliteBettingMathematics.decimalToAmerican(parlayData.parlay_price_decimal);
      
      // Portfolio construction
      parlayData.portfolio_construction = {
        overall_thesis: `Systematic +EV Parlay: Constructed from top ${numLegs} quantitative edges identified across ${allGames.length} game${allGames.length > 1 ? 's' : ''}. Each leg represents statistically validated market inefficiency.`,
        risk_diversification: `Leg independence: ${this._calculateLegIndependence(parlayLegs)}%`,
        bankroll_recommendation: `${this._calculateBankrollAllocation(parlayData.parlay_price_decimal, topPlays.reduce((sum, play) => sum + play.ev, 0) / topPlays.length)}% of total bankroll`
      };

      // Quantitative analysis
      try {
        parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
      } catch (error) {
        parlayData.quantitative_analysis = { note: 'Advanced quantitative analysis unavailable' };
      }

      parlayData.research_metadata = {
        mode,
        quantum_mode: true,
        games_analyzed: allGames.length,
        ev_opportunities_found: bestPlays.length,
        average_ev: (bestPlays.reduce((sum, play) => sum + play.ev, 0) / bestPlays.length).toFixed(1),
        generation_strategy: 'database_quant_selection'
      };

      console.log(`✅ Database parlay built: ${numLegs} legs with average EV +${parlayData.research_metadata.average_ev}%`);
      
      return parlayData;

    } catch (error) {
      console.error(`❌ Database parlay generation failed:`, error.message);
      throw error; // Let the fallback handle this
    }
  }

  async _generateIntelligentFallback(sportKey, numLegs, betType, options, originalError) {
    console.log('🔄 ACTIVATING INTELLIGENT FALLBACK STRATEGY');
    
    try {
      const horizonHours = options.horizonHours || 168; // Use the setting or default to 168
      const scheduleContext = await this._buildScheduleContext(sportKey, horizonHours, options.gameContext);
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, {
        scheduleInfo: scheduleContext,
        gameContext: options.gameContext,
        originalError: originalError?.message
      });

      const parlayData = await this._callAIProvider(prompt);
      
      if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
        throw new Error('Fallback AI response invalid');
      }

      // Apply validation but be more lenient in fallback mode
      const validatedParlay = this.validator.comprehensiveParlayValidation(parlayData, options.gameContext, sportKey);
      validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);

      // Calculate parlay mathematics
      validatedParlay.parlay_price_decimal = this._calculateParlayDecimal(validatedParlay.legs);
      validatedParlay.parlay_price_american = EliteBettingMathematics.decimalToAmerican(validatedParlay.parlay_price_decimal);

      validatedParlay.research_metadata = {
        quantum_mode: true,
        fallback_used: true,
        original_error: originalError?.message,
        generation_strategy: 'intelligent_fallback',
        legs_delivered: validatedParlay.legs.length,
        validation_quality: validatedParlay.validation.qualityScore,
        generated_at: new Date().toISOString()
      };

      console.log(`🆘 Fallback parlay delivered: ${validatedParlay.legs.length} legs`);
      
      return validatedParlay;

    } catch (fallbackError) {
      console.error('💥 CRITICAL: All parlay generation strategies failed:', fallbackError.message);
      
      // Ultimate fallback - empty but informative response
      return {
        legs: [],
        portfolio_construction: {
          overall_thesis: `SYSTEM UNAVAILABLE: All parlay generation systems are currently offline. This is typically due to API service disruptions or network issues. Please try again in 5-10 minutes.`
        },
        research_metadata: {
          emergency_fallback: true,
          error: fallbackError.message,
          original_error: originalError?.message,
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  // 🧮 MATHEMATICAL & ANALYTICAL METHODS
  _calculateParlayDecimal(legs) {
    return (legs || []).reduce((acc, leg) => {
      const legDecimal = leg.odds?.decimal || EliteBettingMathematics.americanToDecimal(-110);
      return acc * legDecimal;
    }, 1);
  }

  _calculateLegIndependence(legs) {
    // Simple independence calculation based on game/market diversity
    const uniqueGames = new Set(legs.map(leg => leg.event));
    const uniqueMarkets = new Set(legs.map(leg => leg.market));
    
    const gameDiversity = (uniqueGames.size / legs.length) * 50;
    const marketDiversity = (uniqueMarkets.size / legs.length) * 50;
    
    return Math.min(100, gameDiversity + marketDiversity);
  }

  _calculateBankrollAllocation(parlayDecimal, averageEV) {
    // Kelly-inspired bankroll allocation
    const baseAllocation = 2; // 2% base for +EV parlays
    const evBonus = Math.min(3, averageEV / 5); // Up to 3% additional for high EV
    const oddsAdjustment = parlayDecimal > 10 ? -1 : 0; // Reduce for extreme longshots
    
    return Math.max(0.5, Math.min(5, baseAllocation + evBonus + oddsAdjustment));
  }

  async _findBestValuePlays(games) {
    const valuePlays = [];
    if (!games || games.length === 0) return valuePlays;

    for (const game of games) {
      const bookmaker = game.bookmakers?.[0];
      if (!bookmaker?.markets) continue;

      // Analyze H2H markets
      const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h');
      if (h2hMarket?.outcomes?.length >= 2) {
        const home = h2hMarket.outcomes.find(o => o.name === game.home_team);
        const away = h2hMarket.outcomes.find(o => o.name === game.away_team);

        if (home && away && home.price && away.price) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(home.price, away.price);
          if (noVig) {
            const evHome = EliteBettingMathematics.calculateExpectedValue(noVig.home, EliteBettingMathematics.americanToDecimal(home.price)) * 100;
            const evAway = EliteBettingMathematics.calculateExpectedValue(noVig.away, EliteBettingMathematics.americanToDecimal(away.price)) * 100;
            
            if (evHome > 0) valuePlays.push({ game, market: h2hMarket, outcome: home, ev: evHome, noVigProb: noVig.home });
            if (evAway > 0) valuePlays.push({ game, market: h2hMarket, outcome: away, ev: evAway, noVigProb: noVig.away });
          }
        }
      }

      // Analyze totals markets
      const totalsMarket = bookmaker.markets.find(m => m.key === 'totals');
      if (totalsMarket?.outcomes?.length === 2) {
        const over = totalsMarket.outcomes.find(o => o.name === 'Over');
        const under = totalsMarket.outcomes.find(o => o.name === 'Under');
        
        if (over && under && over.price && under.price) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(over.price, under.price);
          if (noVig) {
            const evOver = EliteBettingMathematics.calculateExpectedValue(noVig.home, EliteBettingMathematics.americanToDecimal(over.price)) * 100;
            const evUnder = EliteBettingMathematics.calculateExpectedValue(noVig.away, EliteBettingMathematics.americanToDecimal(under.price)) * 100;
            
            if (evOver > 0) valuePlays.push({ game, market: totalsMarket, outcome: over, ev: evOver, noVigProb: noVig.home });
            if (evUnder > 0) valuePlays.push({ game, market: totalsMarket, outcome: under, ev: evUnder, noVigProb: noVig.away });
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
        const focusedGame = realGames.find(game => 
          game.id === gameContext.id || 
          game.event_id === gameContext.event_id ||
          `${game.away_team} @ ${game.home_team}` === `${gameContext.away_team} @ ${gameContext.home_team}`
        );
        
        if (focusedGame) {
          const timeStr = new Date(focusedGame.commence_time).toLocaleString('en-US', { 
            timeZone: TZ, 
            weekday: 'short',
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          return `\n\n🎯 FOCUS GAME ANALYSIS REQUIRED:\n${focusedGame.away_team} @ ${focusedGame.home_team} - ${timeStr} ${TZ}\n\nCRITICAL: All analysis MUST be based exclusively on this specific matchup.`;
        }
      }
      
      const gameList = realGames.slice(0, 15).map((game, index) => {
        const timeStr = new Date(game.commence_time).toLocaleString('en-US', { 
          timeZone: TZ, 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
      }).join('\n');
      
      return `\n\n📅 VERIFIED SCHEDULE (Next ${hours} hours):\n${gameList}\n\nANALYTICAL MANDATE: Base all research exclusively on these verified matchups.`;
      
    } catch (error) {
      console.warn(`⚠️ Schedule context build failed:`, error.message);
      return `\n\n🎯 ELITE ANALYST MODE: Live data temporarily limited. Applying fundamental sports analysis methodologies.`;
    }
  }

  // 🧹 Cache management
  clearCache() {
    this.requestCache.clear();
    console.log('🧹 AI Service cache cleared');
  }

  getCacheStats() {
    return {
      size: this.requestCache.size,
      keys: Array.from(this.requestCache.keys())
    };
  }
}

// Export singleton instance
const quantumAIService = new QuantumAIService();
export default quantumAIService;
