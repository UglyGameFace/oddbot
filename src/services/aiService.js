// src/services/aiService.js - ELITE QUANTUM SPORTS ANALYTICS ENGINE (with strict JSON + schema)
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { sleep } from '../utils/asyncUtils.js';
import { getAIConfig } from '../bot/state.js';
import { strictExtractJSONObject } from '../utils/strictJson.js';
import { isValidParlayResponse } from '../schemas/parlaySchema.js'; // Renamed import
import { getSportTitle } from './sportsService.js'; // Added this import

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

// Existing validation engine preserved
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
      // Find the correct range key (e.g., 'totals', 'spreads', or specific player prop)
      let marketRangeKey = market?.toLowerCase();
      let rangeData = sportRanges[marketRangeKey];
      if (!rangeData && sportRanges.playerProps) {
           // Check if it's a known player prop market type
           if (marketRangeKey?.includes('passingyards')) rangeData = sportRanges.playerProps.passingYards;
           else if (marketRangeKey?.includes('rushingyards')) rangeData = sportRanges.playerProps.rushingYards;
           else if (marketRangeKey?.includes('receivingyards')) rangeData = sportRanges.playerProps.receivingYards;
           else if (marketRangeKey?.includes('points')) rangeData = sportRanges.playerProps.points;
           else if (marketRangeKey?.includes('rebounds')) rangeData = sportRanges.playerProps.rebounds;
           else if (marketRangeKey?.includes('assists')) rangeData = sportRanges.playerProps.assists;
           else if (marketRangeKey?.includes('hits')) rangeData = sportRanges.playerProps.hits;
           else if (marketRangeKey?.includes('strikeouts')) rangeData = sportRanges.playerProps.strikeouts;
      }

      if (rangeData && (point < rangeData.min || point > rangeData.max)) {
        validation.valid = false;
        // Provide clearer error message including the market
        validation.errors = [
          `Implausible line for ${market}: ${point}. Realistic range for ${sport}: ${rangeData.min} to ${rangeData.max}`,
        ];
        return validation; // Return early if implausible
      }
    }
    if (odds && Math.abs(odds) > 10000) {
      validation.warnings.push(`Extreme odds detected: ${odds}. Verify line accuracy.`);
    }
    return validation;
  }


  validateGameContext(legs, gameContext) {
    if (!gameContext) return { validLegs: legs || [], errors: [], warnings: [] }; // Pass warnings back
    const expectedGame = `${gameContext.away_team} @ ${gameContext.home_team}`;
    const errors = [];
    const validLegs = [];
    const warnings = [];
    if (!legs || !Array.isArray(legs) || legs.length === 0) {
      return { validLegs: [], errors: ['No legs provided for validation'], warnings: [] };
    }
    legs.forEach((leg, index) => {
      const legGame = leg.event || '';
      if (!legGame || legGame.trim() === '') {
        warnings.push(`Leg ${index + 1} missing game context - auto-assigning to selected game`);
        validLegs.push({
          ...leg,
          event: expectedGame,
          commence_time: leg.commence_time || gameContext.commence_time,
          game_id: leg.game_id || gameContext.event_id || gameContext.id // Attempt to add game_id
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
          event: expectedGame, // Standardize event name
          commence_time: leg.commence_time || gameContext.commence_time,
          game_id: leg.game_id || gameContext.event_id || gameContext.id // Attempt to add game_id
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
    let initialValidLegs = []; // Legs that pass game context check

    if (!parlayData || typeof parlayData !== 'object') {
       throw new Error('Invalid parlayData object received');
    }
     if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
        console.warn("AI response missing legs array, attempting recovery", parlayData);
        // Attempt recovery if possible, or throw
        if(typeof parlayData.legs === 'object' && parlayData.legs !== null) {
            // Maybe it's an object instead of array? Try to convert if structure allows
             try {
                 parlayData.legs = Object.values(parlayData.legs);
                 if(!Array.isArray(parlayData.legs)) throw new Error("Could not convert legs object to array");
             } catch(conversionError) {
                  throw new Error(`AI response legs format unusable: ${conversionError.message}`);
             }
        } else {
             throw new Error('AI response missing legs array - invalid parlay structure');
        }
     }


    const gameValidation = this.validateGameContext(parlayData.legs, gameContext);
    initialValidLegs.push(...gameValidation.validLegs); // Use the legs validated for game context
    errors.push(...gameValidation.errors);
    warnings.push(...gameValidation.warnings);

    const fullyValidatedLegs = []; // Final list of legs passing all checks

    initialValidLegs.forEach((leg, index) => { // Iterate over legs that passed game context check
      try {
        let isLegValid = true; // Assume valid initially for this leg

        // 1. Player Team Alignment Check
        if (leg.selection && typeof leg.selection === 'string') { // Check if selection exists and is string
          const playerValidation = this.validatePlayerTeamAlignment(leg.selection, gameContext);
          if (!playerValidation.valid) {
            errors.push(`Leg ${index + 1} (${leg.selection}): ${playerValidation.error}`);
            isLegValid = false;
          }
        }

        // 2. Betting Line Plausibility Check
        const lineValidation = this.validateBettingLine(
          leg.market,
          leg.point,
          leg.odds?.american,
          sportKey
        );
        if (!lineValidation.valid && lineValidation.errors) { // Check for errors property
          errors.push(...lineValidation.errors.map(e => `Leg ${index + 1}: ${e}`)); // Add leg context
          isLegValid = false;
        }
        if (lineValidation.warnings?.length) {
            warnings.push(...lineValidation.warnings.map(w => `Leg ${index + 1}: ${w}`)); // Add leg context
        }


        // 3. Essential Fields Check
        if (!leg.selection || String(leg.selection).trim() === '') {
          errors.push(`Leg ${index + 1}: Missing selection description`);
          isLegValid = false;
        }
        if (!leg.market || String(leg.market).trim() === '') {
           errors.push(`Leg ${index + 1}: Missing market description`);
           isLegValid = false;
        }
         if (!leg.event || String(leg.event).trim() === '') {
           warnings.push(`Leg ${index + 1}: Missing event description (may cause issues)`);
           // Not necessarily invalid if context assigns it, but worth warning
         }


        // 4. Odds Check (Warning only unless completely missing)
        if (!leg.odds || typeof leg.odds !== 'object' || !Number.isFinite(Number(leg.odds.american))) {
          warnings.push(`Leg ${index + 1} (${leg.selection}): Missing or invalid odds data. Default odds may be applied.`);
          // Don't mark as invalid here, allow _ensureLegsHaveOdds to handle it later if needed
        }

        // Add to final list if all checks passed for this leg
        if (isLegValid) {
          fullyValidatedLegs.push(leg);
        }

      } catch (legError) {
        errors.push(`Leg ${index + 1} validation CRASHED: ${legError.message}`);
        isLegValid = false; // Mark as invalid if the validation itself crashes
      }
    });

    // Calculate quality score based on *original* number of legs vs fully validated ones
    const originalLegCount = parlayData.legs.length;
    const qualityScore = originalLegCount > 0 ? (fullyValidatedLegs.length / originalLegCount) * 100 : 0;

    const validationSummary = {
      originalCount: originalLegCount,
      validCount: fullyValidatedLegs.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      qualityScore: Math.round(qualityScore), // Round for cleaner display
      recommendation:
        fullyValidatedLegs.length === 0 ? 'REJECT'
        : qualityScore === 100 ? 'ACCEPT'
        : 'PARTIAL',
    };

    return {
      ...parlayData,
      legs: fullyValidatedLegs, // Return only the legs that passed all checks
      validation: {
        ...validationSummary,
        errors,
        warnings,
        timestamp: new Date().toISOString(),
      },
    };
  }
} // ** <<< THIS WAS THE MISSING BRACE >>> **

class QuantumAIService {
  constructor() {
    this.validator = new QuantumValidationEngine();
    this.requestCache = new Map();
    this.cacheTTL = 300000; // 5 minutes cache
  }

  _ensureLegsHaveOdds(legs) {
    if (!Array.isArray(legs)) return [];
    return legs.map((leg, index) => {
      // Check if leg and odds object exist and american odds is a finite number
      const hasValidOdds = leg && leg.odds && typeof leg.odds === 'object' && Number.isFinite(Number(leg.odds.american));

      if (hasValidOdds) {
        const american = Number(leg.odds.american);
        // Ensure american odds are within a reasonable range to avoid extreme values
        if (american < -100000 || american > 100000) {
             console.warn(`⚠️ Leg ${index + 1} has extreme odds: ${american}. Applying defaults.`);
             // Fall through to default odds logic
        } else {
            const decimal = EliteBettingMathematics.americanToDecimal(american);
            const impliedProb = EliteBettingMathematics.calculateImpliedProbability(american);
            // Ensure impliedProb is valid
             if (isNaN(impliedProb) || impliedProb < 0 || impliedProb > 1) {
                 console.warn(`⚠️ Leg ${index + 1} calculated invalid implied probability from odds ${american}. Applying defaults.`);
                 // Fall through to default odds logic
             } else {
                 return { ...leg, odds: { american, decimal, implied_probability: impliedProb } };
             }
        }
      }

      // If odds are missing, invalid, or extreme, apply defaults
      const selectionText = leg?.selection || 'Unknown Selection';
      console.warn(`⚠️ Leg ${index + 1} missing/invalid odds: "${selectionText}". Applying intelligent defaults.`);
      let defaultOdds = -110; // General default
      const market = leg?.market?.toLowerCase() || '';

      if (market === 'h2h' || market === 'moneyline') defaultOdds = -110;
      else if (market === 'totals' || market === 'spreads' || market === 'handicap') defaultOdds = -110;
      else if (market.includes('player')) defaultOdds = -115; // Slightly different for props

      const decimal = EliteBettingMathematics.americanToDecimal(defaultOdds);
      const impliedProb = EliteBettingMathematics.calculateImpliedProbability(defaultOdds);

      // Add a note about applied odds if analysis exists
      const analysisNote = `(Intelligent odds applied: ${defaultOdds}) ${leg?.quantum_analysis?.analytical_basis || 'Market-based default odds applied.'}`;

      return {
        ...leg,
        odds: { american: defaultOdds, decimal, implied_probability: impliedProb },
        quantum_analysis: {
          ...(leg?.quantum_analysis || {}), // Preserve existing analysis if any
          analytical_basis: analysisNote,
        },
      };
    });
  }


  async _callAIProvider(prompt, context = {}) {
    const { PERPLEXITY_API_KEY } = env;
    if (!PERPLEXITY_API_KEY) throw new Error('Perplexity API key not configured - check environment variables');

    // Simple cache key based on prompt hash - reduces length issues
    const cacheKey = `ai_req_${require('crypto').createHash('sha256').update(prompt).digest('hex').substring(0, 16)}`;
    const cached = this.requestCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`🎯 AI Response cache HIT for key ${cacheKey}`);
      return cached.data;
    } else if (cached) {
         console.log(`⏱️ AI Response cache STALE for key ${cacheKey}`);
         this.requestCache.delete(cacheKey); // Remove stale entry
    } else {
         console.log(`🔍 AI Response cache MISS for key ${cacheKey}`);
    }


    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`🔄 AI Provider Request (Attempt ${attempt}/${MAX_RETRIES}) for ${context.sportKey || 'generic request'}`);
      try {
        const startTime = Date.now();
        const response = await axios.post(
          'https://api.perplexity.ai/chat/completions',
          {
            model: AI_MODELS.perplexity, // Use sonar-pro via alias
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1, // Low temp for consistency
            max_tokens: 4000,
          },
          {
            headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: WEB_TIMEOUT_MS, // Use defined timeout
          }
        );
        const responseTime = Date.now() - startTime;
        console.log(`✅ AI Response received in ${responseTime}ms`);

        // Safer access to response content
        const responseText = response?.data?.choices?.[0]?.message?.content || '';
        if (!responseText) throw new Error('Empty response from AI provider');

        // Strict JSON extraction
        const parsed = strictExtractJSONObject(responseText);

        // Schema validation (use the specific schema file)
         // Corrected validation call based on provided parlaySchema.js
         // Note: parlaySchema.js needs adjustment to match the AI output structure
         if (!isValidParlay(parsed, context.numLegs || 1)) {
              console.error("AI JSON failed schema validation:", JSON.stringify(parsed, null, 2));
              throw new Error('AI JSON failed schema validation - structure mismatch');
         }


        // Cache and return valid response
        this.requestCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
        // Clear old cache entries occasionally
         if (this.requestCache.size > 100) {
            const oldestKey = this.requestCache.keys().next().value;
            this.requestCache.delete(oldestKey);
         }
        return parsed;

      } catch (error) {
         const isTimeout = error.code === 'ECONNABORTED' || error instanceof axios.Cancel || (error.message && error.message.toLowerCase().includes('timeout'));
         const status = error.response?.status;

        console.error(`❌ AI Provider Error (Attempt ${attempt}):`, {
          message: error.message,
          status: status,
          isTimeout: isTimeout,
          data: error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) + '...' : undefined, // Log snippet of data
        });

        if (attempt === MAX_RETRIES) {
          if (status === 401 || status === 403) {
            throw new Error('Perplexity API authentication failed - check API key');
          } else if (status === 429) {
            throw new Error('AI provider rate limit exceeded - try again shortly');
          } else if (isTimeout) {
            throw new Error('AI provider request timeout - service may be overloaded');
          } else if (error.message.includes('schema validation')) {
               // Propagate schema validation error clearly
               throw new Error(`AI provider failed after ${MAX_RETRIES} attempts: ${error.message}`);
          }
          // Generic failure after retries
          throw new Error(`AI provider failed after ${MAX_RETRIES} attempts: ${error.message || 'Unknown error'}`);
        }

        // Exponential backoff
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
    // Should be unreachable due to throw in the loop
    throw new Error('AI provider call failed unexpectedly after retries.');
  }


  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options = {}) {
    // Fetch user config with defaults if needed
    const userAIConfig = await getAIConfig(options.chatId || 'default');
    const effectiveMode = mode || userAIConfig.mode || 'web';
    const effectiveBetType = betType || userAIConfig.betType || 'mixed';
    const effectiveHorizonHours = options.horizonHours || userAIConfig.horizonHours || 72;
    // Include proQuantMode from user settings or default to false
    const effectiveProQuantMode = options.proQuantMode ?? userAIConfig.proQuantMode ?? false;


    console.log(
      `🎯 Using settings - Mode: ${effectiveMode}, BetType: ${effectiveBetType}, Horizon: ${effectiveHorizonHours}h, QuantMode: ${effectiveProQuantMode}`
    );

    const requestId = `quantum_${sportKey}_${Date.now()}`;
    const startTime = Date.now();
    console.log('🎯 QUANTUM PARLAY GENERATION INITIATED', {
      requestId,
      sport: sportKey,
      legs: numLegs,
      mode: effectiveMode,
      betType: effectiveBetType,
      proQuantMode: effectiveProQuantMode, // Log quant mode
      gameContext: options.gameContext ? `${options.gameContext.away_team} @ ${options.gameContext.home_team}` : 'None',
    });

    try {
      let parlayData;
      // Pass the effective Pro Quant Mode down
      const generationOptions = {
          ...options,
          horizonHours: effectiveHorizonHours,
          proQuantMode: effectiveProQuantMode // Ensure quant mode is passed
      };

      if (effectiveMode === 'web' || effectiveMode === 'live') {
        parlayData = await this._generateWebParlay(sportKey, numLegs, effectiveBetType, generationOptions);
      } else {
        // Assuming 'db' or other modes use context parlay
        parlayData = await this._generateContextParlay(sportKey, numLegs, effectiveMode, effectiveBetType, generationOptions);
      }

      // Perform comprehensive validation AFTER generation
      const validatedParlay = this.validator.comprehensiveParlayValidation(
          parlayData,
          options.gameContext,
          sportKey
      );

      // Ensure odds are present AFTER validation (as validation might remove legs)
      validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);

       // Recalculate parlay price based on potentially modified legs/odds
       validatedParlay.parlay_price_decimal = this._calculateParlayDecimal(validatedParlay.legs);
       validatedParlay.parlay_price_american = EliteBettingMathematics.decimalToAmerican(validatedParlay.parlay_price_decimal);


      // Run quantitative analysis if feature enabled and enough valid legs exist
      if (env.FEATURE_QUANTITATIVE_ANALYTICS && validatedParlay.legs.length >= 2) {
          try {
              validatedParlay.quantitative_analysis = await quantitativeService.evaluateParlay(
                  validatedParlay.legs,
                  validatedParlay.parlay_price_decimal
              );
          } catch (qError) {
              console.warn('Quantitative analysis subsystem offline:', qError.message);
              validatedParlay.quantitative_analysis = {
                  note: 'Advanced quantitative analysis temporarily unavailable',
                  riskAssessment: { overallRisk: 'UNKNOWN' }, // Use UNKNOWN if calc failed
              };
          }
      } else {
            validatedParlay.quantitative_analysis = { note: 'Quantitative analysis skipped (feature disabled or insufficient legs)' };
      }


      // Add metadata AFTER all processing
      validatedParlay.research_metadata = {
          ...(validatedParlay.research_metadata || {}), // Preserve existing metadata if any
          quantum_mode: true,
          generation_strategy: parlayData.research_metadata?.generation_strategy || (effectiveMode === 'web' ? 'web_research' : 'database_quant'),
          game_context_used: !!options.gameContext,
          legs_requested: numLegs,
          legs_delivered: validatedParlay.legs.length, // Use count of *validated* legs
          validation_quality: validatedParlay.validation?.qualityScore, // Use score from validation object
          proQuantMode_used: effectiveProQuantMode, // Record if quant mode was used
          generated_at: new Date().toISOString(),
      };


      const generationTime = Date.now() - startTime;
      console.log('✅ QUANTUM PARLAY GENERATION COMPLETED', {
        requestId,
        generationTime: `${generationTime}ms`,
        legsGenerated: parlayData.legs?.length || 0, // Raw legs from AI
        legsValidated: validatedParlay.legs.length, // Legs after validation
        validationScore: validatedParlay.validation?.qualityScore || 'N/A',
      });

      return validatedParlay; // Return the fully processed and validated parlay

    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error('❌ QUANTUM PARLAY GENERATION FAILED', {
        requestId,
        error: error.message,
        duration: `${errorTime}ms`,
        sport: sportKey,
      });
      // Fallback strategy remains important
      return await this._generateIntelligentFallback(
        sportKey, numLegs, effectiveBetType,
        // Pass effective quant mode to fallback too
        { ...options, horizonHours: effectiveHorizonHours, proQuantMode: effectiveProQuantMode },
        error
      );
    }
  }

  async _generateWebParlay(sportKey, numLegs, betType, options) {
    console.log('🌐 GENERATING WEB-RESEARCH PARLAY');
    const scheduleContext = await this._buildScheduleContext(sportKey, options.horizonHours, options.gameContext);

    // Pass userConfig (including proQuantMode) to the prompt service
    const promptContext = {
         scheduleInfo: scheduleContext,
         gameContext: options.gameContext,
         userConfig: { proQuantMode: options.proQuantMode } // Include quant mode here
    };

    const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, promptContext);
    console.log('📝 AI Prompt prepared (Web Research)');

    // Context for AI call includes numLegs for schema validation
    const parlayData = await this._callAIProvider(prompt, { sportKey, numLegs, gameContext: options.gameContext });

    // Basic check before returning - validation happens in the main generateParlay function
    if (!parlayData || !Array.isArray(parlayData.legs)) {
      throw new Error('AI response invalid: structure mismatch (expected object with legs array)');
    }
    console.log(`🤖 AI generated ${parlayData.legs.length} raw legs (Web)`);

    // Add initial metadata before returning to main function
     parlayData.research_metadata = {
        generation_strategy: 'web_research',
     };


    // Return raw data for validation in generateParlay
    return parlayData;
  }


  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`💾 GENERATING DATABASE-DRIVEN PARLAY (${mode} mode)`);
    try {
      // Fetch games: Use gameContext if provided, otherwise fetch from gamesService
      const allGames = options.gameContext
        ? [options.gameContext] // Use the single game context
        : await gamesService.getGamesForSport(sportKey, {
            hoursAhead: options.horizonHours || 72,
            includeOdds: true, // Need odds for EV calculation
            useCache: false, // Ensure fresh data for DB mode
            chatId: options.chatId,
          });

      if (!allGames || allGames.length === 0) {
        throw new Error(`No games available for ${sportKey} in database context`);
      }

      console.log(`🔍 Analyzing ${allGames.length} games for +EV opportunities...`);
      // Find best value plays based on no-vig probability and market odds
      const bestPlays = await this._findBestValuePlays(allGames);

      if (bestPlays.length < numLegs) {
        console.warn(`Insufficient +EV plays (${bestPlays.length}) found for ${numLegs}-leg parlay in ${sportKey}.`);
        // Return a structured "PASS" recommendation
        return {
          legs: [], // No legs generated
          parlay_metadata: { sport: getSportTitle(sportKey), legs_count: numLegs, bet_type: betType, generated_at: new Date().toISOString() },
          portfolio_construction: {
            overall_thesis: `Market Analysis: Insufficient positive expected value (+EV) opportunities identified among ${allGames.length} analyzed games to construct a reliable ${numLegs}-leg parlay. Professional discipline advises passing when a quantifiable edge is not present.`,
          },
          research_metadata: {
            analysis_mode: 'database_quant',
            games_analyzed: allGames.length,
            ev_opportunities_found: bestPlays.length,
            legs_requested: numLegs,
            recommendation: 'PASS', // Explicit pass
            reason: 'Insufficient +EV edge',
          },
          validation: { qualityScore: 0, recommendation: 'REJECT'} // Add validation object
        };
      }

      // Select top plays up to numLegs
      const topPlays = bestPlays.slice(0, numLegs);

      // Construct parlay legs from the selected plays
      const parlayLegs = topPlays.map((play) => {
          const americanOdds = play.outcome.price;
          const decimalOdds = EliteBettingMathematics.americanToDecimal(americanOdds);
          const impliedProb = EliteBettingMathematics.calculateImpliedProbability(americanOdds);
          const noVigProb = play.noVigProb || 0.5; // Use calculated no-vig or default
          const kelly = EliteBettingMathematics.kellyCriterion(noVigProb, decimalOdds);

          return {
              game_id: play.game.event_id || play.game.id, // Use standardized ID
              event: `${play.game.away_team} @ ${play.game.home_team}`,
              commence_time: play.game.commence_time,
              market: play.market.key,
              selection: `${play.outcome.name} ${play.outcome.point != null ? play.outcome.point : ''}`.trim(),
              odds: {
                  american: americanOdds,
                  decimal: decimalOdds,
                  implied_probability: impliedProb,
              },
              // Add detailed quantum analysis based on EV calculation
              quantum_analysis: {
                  confidence_score: Math.min(95, Math.round(noVigProb * 100)), // Confidence based on no-vig
                  analytical_basis: `Quantitative Edge: Identified +${play.ev.toFixed(1)}% EV. Calculated no-vig probability (${(noVigProb * 100).toFixed(1)}%) exceeds market implied probability (${(impliedProb * 100).toFixed(1)}%).`,
                  key_factors: ['market_inefficiency', 'probability_discrepancy', 'quantitative_edge'],
                  expected_value: play.ev.toFixed(2), // Store EV
                  no_vig_probability: noVigProb.toFixed(4), // Store no-vig prob
                  kelly_fraction: kelly.toFixed(3), // Store Kelly fraction
              },
              // Mark as validated since it came from our DB/Odds sources
              real_game_validated: true,
          };
      });

      const parlayData = { legs: parlayLegs }; // Start building the final object
       parlayData.research_metadata = { // Add metadata early
           mode: mode,
           quantum_mode: true,
           generation_strategy: 'database_quant_selection',
           games_analyzed: allGames.length,
           ev_opportunities_found: bestPlays.length,
           average_ev_found: (bestPlays.reduce((sum, play) => sum + play.ev, 0) / (bestPlays.length || 1)).toFixed(1),
       };


      // Calculate parlay price AFTER legs are formed
      // Note: Validation and final quant analysis happens *after* this function returns

      console.log(`✅ Database parlay built: ${numLegs} legs with average EV +${parlayData.research_metadata.average_ev_found}%`);
      return parlayData; // Return raw data for validation in generateParlay

    } catch (error) {
      console.error(`❌ Database parlay generation failed for ${sportKey}:`, error.message);
      // Let the main generateParlay function handle the fallback
      throw error;
    }
  }


  async _generateIntelligentFallback(sportKey, numLegs, betType, options, originalError) {
    console.log(`🔄 ACTIVATING INTELLIGENT FALLBACK STRATEGY due to: ${originalError?.message || 'Unknown error'}`);
    try {
      const horizonHours = options.horizonHours || 168; // Wider horizon for fallback
      const scheduleContext = await this._buildScheduleContext(sportKey, horizonHours, options.gameContext);

       // Include proQuantMode in fallback prompt context if applicable
       const promptContext = {
           scheduleInfo: scheduleContext,
           gameContext: options.gameContext,
           originalError: originalError?.message,
           userConfig: { proQuantMode: options.proQuantMode } // Pass quant mode
       };

      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, promptContext);
      // Use numLegs in AI call context for schema validation
      const parlayData = await this._callAIProvider(prompt, { sportKey, numLegs });

      if (!parlayData || !Array.isArray(parlayData.legs)) {
        throw new Error('Fallback AI response invalid or missing legs');
      }

      // Perform validation on the fallback response
       // Validation happens in the main generateParlay, just add metadata here
       parlayData.research_metadata = {
            ...(parlayData.research_metadata || {}), // Keep existing if any
            quantum_mode: true,
            fallback_used: true,
            original_error_message: originalError?.message?.substring(0, 200), // Store snippet
            generation_strategy: 'intelligent_fallback',
            proQuantMode_used: options.proQuantMode, // Record if quant mode was used
       };


      console.log(`🆘 Fallback parlay delivered ${parlayData.legs.length} raw legs for validation.`);
      // Return raw data for validation in generateParlay
      return parlayData;

    } catch (fallbackError) {
      console.error('💥 CRITICAL: Fallback strategy also failed:', fallbackError.message);
      // Return a structured error object if even fallback fails completely
      return {
        legs: [],
         parlay_metadata: { sport: getSportTitle(sportKey), legs_count: numLegs, bet_type: betType, generated_at: new Date().toISOString() },
        portfolio_construction: {
          overall_thesis: 'SYSTEM UNAVAILABLE: All parlay generation strategies failed. Please check system status or try again later.',
        },
        research_metadata: {
          emergency_fallback: true,
          error: fallbackError.message.substring(0, 200),
          original_error_message: originalError?.message?.substring(0, 200),
          timestamp: new Date().toISOString(),
        },
        validation: { qualityScore: 0, recommendation: 'REJECT' } // Add validation object
      };
    }
  }

  // Calculate combined decimal odds for a list of legs
  _calculateParlayDecimal(legs) {
    if (!Array.isArray(legs) || legs.length === 0) return 1.0; // Neutral odds if no legs

    return legs.reduce((acc, leg) => {
      // Use the decimal odds if available and valid, otherwise fallback using American or default
      const legDecimal = (leg?.odds?.decimal > 1)
        ? leg.odds.decimal
        : EliteBettingMathematics.americanToDecimal(leg?.odds?.american || -110); // Default to -110 if missing
      return acc * legDecimal;
    }, 1.0); // Start accumulator at 1.0
  }


  // --- Helper for Database Parlay Generation ---
  async _findBestValuePlays(games) {
    const valuePlays = [];
    if (!games || !Array.isArray(games) || games.length === 0) return valuePlays;

    for (const game of games) {
      // Get the first available bookmaker's data
      const bookmaker = game.bookmakers?.[0];
      if (!bookmaker?.markets || !Array.isArray(bookmaker.markets)) continue;

      // --- H2H (Moneyline) Value ---
      const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h' || m.key === 'moneyline');
      if (h2hMarket?.outcomes?.length >= 2) {
        const home = h2hMarket.outcomes.find(o => o.name === game.home_team || o.name === 'Home'); // Allow 'Home'
        const away = h2hMarket.outcomes.find(o => o.name === game.away_team || o.name === 'Away'); // Allow 'Away'

        if (home?.price && away?.price) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(home.price, away.price);
          if (noVig) {
            const homeDecimal = EliteBettingMathematics.americanToDecimal(home.price);
            const awayDecimal = EliteBettingMathematics.americanToDecimal(away.price);
            const evHome = EliteBettingMathematics.calculateExpectedValue(noVig.home, homeDecimal) * 100;
            const evAway = EliteBettingMathematics.calculateExpectedValue(noVig.away, awayDecimal) * 100;

            if (evHome > 0) valuePlays.push({ game, market: h2hMarket, outcome: home, ev: evHome, noVigProb: noVig.home });
            if (evAway > 0) valuePlays.push({ game, market: h2hMarket, outcome: away, ev: evAway, noVigProb: noVig.away });
          }
        }
      }

      // --- Totals (Over/Under) Value ---
      const totalsMarket = bookmaker.markets.find(m => m.key === 'totals');
      if (totalsMarket?.outcomes?.length === 2) {
        const over = totalsMarket.outcomes.find(o => o.name === 'Over');
        const under = totalsMarket.outcomes.find(o => o.name === 'Under');

        // Ensure both outcomes have the same point value for fair comparison
        if (over?.price && under?.price && over.point === under.point) {
          const noVig = EliteBettingMathematics.calculateNoVigProbability(over.price, under.price);
          if (noVig) {
            const overDecimal = EliteBettingMathematics.americanToDecimal(over.price);
            const underDecimal = EliteBettingMathematics.americanToDecimal(under.price);
            // Assuming fair split for totals (noVig.home = over, noVig.away = under)
            const evOver = EliteBettingMathematics.calculateExpectedValue(noVig.home, overDecimal) * 100;
            const evUnder = EliteBettingMathematics.calculateExpectedValue(noVig.away, underDecimal) * 100;

            if (evOver > 0) valuePlays.push({ game, market: totalsMarket, outcome: over, ev: evOver, noVigProb: noVig.home });
            if (evUnder > 0) valuePlays.push({ game, market: totalsMarket, outcome: under, ev: evUnder, noVigProb: noVig.away });
          }
        }
      }

       // --- Spreads (Handicap) Value ---
       const spreadsMarket = bookmaker.markets.find(m => m.key === 'spreads' || m.key === 'handicap');
       if (spreadsMarket?.outcomes?.length === 2) {
           const outcome1 = spreadsMarket.outcomes[0];
           const outcome2 = spreadsMarket.outcomes[1];

           // Ensure point values are opposites (e.g., +3.5 and -3.5) and prices exist
           if (outcome1?.price && outcome2?.price && outcome1.point === -outcome2.point) {
               const noVig = EliteBettingMathematics.calculateNoVigProbability(outcome1.price, outcome2.price);
               if (noVig) {
                   const decimal1 = EliteBettingMathematics.americanToDecimal(outcome1.price);
                   const decimal2 = EliteBettingMathematics.americanToDecimal(outcome2.price);
                   // Assuming fair split (noVig.home = outcome1, noVig.away = outcome2)
                   const ev1 = EliteBettingMathematics.calculateExpectedValue(noVig.home, decimal1) * 100;
                   const ev2 = EliteBettingMathematics.calculateExpectedValue(noVig.away, decimal2) * 100;

                   if (ev1 > 0) valuePlays.push({ game, market: spreadsMarket, outcome: outcome1, ev: ev1, noVigProb: noVig.home });
                   if (ev2 > 0) valuePlays.push({ game, market: spreadsMarket, outcome: outcome2, ev: ev2, noVigProb: noVig.away });
               }
           }
       }


    }
    // Sort plays by highest Expected Value (EV) descending
    return valuePlays.sort((a, b) => b.ev - a.ev);
  }


  async _buildScheduleContext(sportKey, hours, gameContext = null) {
    try {
      // Use the specific function from gamesService
      const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);

      if (!Array.isArray(realGames) || realGames.length === 0) {
        return `\n\n🎯 ELITE ANALYST MODE: No real-time ${getSportTitle(sportKey)} game data available for the next ${hours} hours. Using fundamental analysis principles.`;
      }

      // Handle specific game context
      if (gameContext) {
        // Find the specific game in the verified list for accurate timing
        const focusedGame = realGames.find(
          (game) =>
            (game.id && game.id === gameContext.id) ||
            (game.event_id && game.event_id === gameContext.event_id) ||
            (game.home_team === gameContext.home_team && game.away_team === gameContext.away_team)
        );

        if (focusedGame) {
          const timeStr = new Date(focusedGame.commence_time).toLocaleString('en-US', {
            timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
          });
          return `\n\n🎯 FOCUS GAME ANALYSIS REQUIRED:\n${focusedGame.away_team} @ ${focusedGame.home_team} - ${timeStr} ${TZ}\n\nCRITICAL: All analysis MUST be based exclusively on this specific matchup.`;
        } else {
             // If context game not found in verified list, provide generic context but mention the focus
             console.warn(`Focus game ${gameContext.away_team}@${gameContext.home_team} not found in verified schedule for ${sportKey}`);
             return `\n\n🎯 FOCUS GAME ANALYSIS (Context Game Not Verified):\n${gameContext.away_team} @ ${gameContext.home_team}\n\nCRITICAL: Analysis MUST focus on this game, but verify details independently.`;
        }
      }

      // Build context for multiple games
      const gameList = realGames
        .slice(0, 15) // Limit context length
        .map((game, index) => {
          const timeStr = new Date(game.commence_time).toLocaleString('en-US', {
            timeZone: TZ, month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
          });
          // Include game ID if available
          const gameId = game.event_id || game.id || 'N/A';
          return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr} (ID: ${gameId})`;
        })
        .join('\n');

      return `\n\n📅 VERIFIED SCHEDULE (${getSportTitle(sportKey)} - Next ${hours} hours):\n${gameList}\n\nANALYTICAL MANDATE: Base all research exclusively on these verified matchups and times.`;

    } catch (error) {
      console.warn(`⚠️ Schedule context build failed for ${sportKey}:`, error.message);
      // Provide a generic fallback but mention the sport
      return `\n\n🎯 ELITE ANALYST MODE (${getSportTitle(sportKey)}): Live schedule data temporarily limited. Applying fundamental sports analysis methodologies.`;
    }
  }


  clearCache() {
    this.requestCache.clear();
    console.log('🧹 AI Service request cache cleared');
  }

  getCacheStats() {
    return {
         size: this.requestCache.size,
         keys: Array.from(this.requestCache.keys()).slice(0, 10), // Show first 10 keys
         ttl: `${this.cacheTTL / 1000}s`
     };
  }

   // New function for direct chat completion
   async genericChat(model, messages) {
       const { PERPLEXITY_API_KEY } = env;
       if (!PERPLEXITY_API_KEY) throw new Error('Perplexity API key not configured');

       const modelName = AI_MODELS[model] || AI_MODELS['sonar-small-chat']; // Default to small chat

       try {
           const response = await axios.post(
               'https://api.perplexity.ai/chat/completions',
               {
                   model: modelName,
                   messages: messages,
                   temperature: 0.7, // Slightly higher temp for chat
                   max_tokens: 1000, // Reasonable limit for chat
               },
               {
                   headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
                   timeout: 45000, // 45 second timeout for chat
               }
           );
           return response?.data?.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
       } catch (error) {
           console.error(`❌ Generic Chat Error (Model: ${modelName}):`, error.message);
            throw new Error(`AI chat failed: ${error.message}`); // Re-throw for handler
       }
   }

   // New function for odds validation (placeholder)
    async validateOdds(oddsData) {
        // Placeholder - replace with actual validation logic if needed
        console.log("Simulating AI odds validation...");
        await sleep(50); // Simulate network latency
        return { valid: true, issues: [] }; // Assume valid for now
    }


} // End of QuantumAIService class

// Instantiate and export the service
const quantumAIService = new QuantumAIService();
export default quantumAIService;
