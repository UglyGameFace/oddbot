// src/services/aiService.js - FIXED WITH GAME CONTEXT VALIDATION
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { sleep } from '../utils/asyncUtils.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

const AI_MODELS = {
  perplexity: "sonar-pro"
};

// Enhanced validation services
class PlayerValidationService {
  constructor() {
    this.teamRosters = new Map();
    this.commonTypos = new Map([
      ['jat-mart chase', 'ja\'marr chase'],
      ['damell washington', 'darnell washington'],
      ['aaron rodgers', 'aaron rodgers'],
      ['dk metcalf', 'd.k. metcalf']
    ]);
    this.playerTeams = new Map([
      ['aaron rodgers', 'New York Jets'],
      ['ja\'marr chase', 'Cincinnati Bengals'], 
      ['darnell washington', 'Pittsburgh Steelers'],
      ['d.k. metcalf', 'Seattle Seahawks']
    ]);
  }

  correctTypos(name) {
    const lowerName = name.toLowerCase();
    return this.commonTypos.get(lowerName) || name;
  }

  validatePlayerForGame(playerName, game) {
    const correctedName = this.correctTypos(playerName);
    const expectedTeam = this.playerTeams.get(correctedName.toLowerCase());
    
    if (expectedTeam) {
      const isValid = game.away_team === expectedTeam || game.home_team === expectedTeam;
      if (!isValid) {
        throw new Error(`Player ${correctedName} plays for ${expectedTeam}, not in ${game.away_team} vs ${game.home_team}`);
      }
    }
    return correctedName;
  }
}

class BettingLineValidationService {
  getRealisticRanges(sport) {
    const ranges = {
      'americanfootball_nfl': {
        totals: { min: 30, max: 60 },
        spreads: { min: -20, max: 20 },
        h2h: { min: -1000, max: 1000 }
      },
      'basketball_nba': {
        totals: { min: 180, max: 250 },
        spreads: { min: -25, max: 25 },
        h2h: { min: -1000, max: 1000 }
      },
      'baseball_mlb': {
        totals: { min: 5, max: 15 },
        spreads: { min: -3, max: 3 },
        h2h: { min: -500, max: 500 }
      },
      'americanfootball_ncaaf': {
        totals: { min: 30, max: 80 },
        spreads: { min: -35, max: 35 },
        h2h: { min: -1000, max: 1000 }
      }
    };
    return ranges[sport] || ranges['americanfootball_nfl'];
  }

  validateBettingLine(market, point, sport) {
    const ranges = this.getRealisticRanges(sport);
    const marketRange = ranges[market];
    
    if (!marketRange) return true;
    
    if (point !== undefined && point !== null) {
      if (point < marketRange.min || point > marketRange.max) {
        throw new Error(`Implausible ${market} line: ${point} for ${sport}. Realistic range: ${marketRange.min} to ${marketRange.max}`);
      }
    }
    return true;
  }
}

// Core utility functions
function americanToDecimal(a) {
    const x = Number(a);
    if (!Number.isFinite(x)) return 1.0;
    return x > 0 ? 1 + x / 100 : 1 + 100 / Math.abs(x);
}

function decimalToAmerican(d) {
    const x = Number(d);
    if (!Number.isFinite(x) || x <= 1) return null;
    return x >= 2 ? Math.round((x - 1) * 100) : Math.round(-100 / (d - 1));
}

function parlayDecimal(legs) {
    return (legs || []).reduce((acc, l) => acc * (americanToDecimal(l.odds?.american) || 1), 1);
}

function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
        try { return JSON.parse(match[1]); } catch (e) { /* ignore */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { /* ignore */ }
    }
    return null;
}

// ENHANCED: Game context validation function
function validateGameContext(legs, gameContext) {
  if (!gameContext) return legs; // No context to validate against
  
  const expectedGame = `${gameContext.away_team} @ ${gameContext.home_team}`;
  const errors = [];
  const validLegs = [];

  for (const leg of legs) {
    const legGame = leg.event || '';
    
    // Normalize game names for comparison
    const normalizeGameName = (name) => name.toLowerCase().replace(/[^a-z0-9@ ]/g, '').trim();
    const normalizedLegGame = normalizeGameName(legGame);
    const normalizedExpectedGame = normalizeGameName(expectedGame);
    
    if (normalizedLegGame !== normalizedExpectedGame) {
      errors.push(`Game mismatch: "${legGame}" vs "${expectedGame}"`);
      continue;
    }
    
    validLegs.push(leg);
  }

  if (errors.length > 0) {
    console.warn('Game context validation errors:', errors);
  }

  return validLegs;
}

// ENHANCED: Main validation function with game context
function validateParlayResponse(parlayData, gameContext, sportKey) {
  const playerValidator = new PlayerValidationService();
  const lineValidator = new BettingLineValidationService();
  const errors = [];
  const validLegs = [];

  if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
    throw new Error('AI response missing legs array');
  }

  // FIRST: Validate game context matches
  const gameContextValidatedLegs = validateGameContext(parlayData.legs, gameContext);
  
  if (gameContextValidatedLegs.length === 0 && parlayData.legs.length > 0) {
    throw new Error(`All parlay legs failed game context validation. Expected game: ${gameContext.away_team} @ ${gameContext.home_team}`);
  }

  // SECOND: Validate individual legs
  for (const leg of gameContextValidatedLegs) {
    try {
      // Validate player names
      if (leg.selection && leg.selection.includes('Rodgers') && sportKey === 'americanfootball_nfl') {
        playerValidator.validatePlayerForGame('aaron rodgers', gameContext);
      }

      // Validate betting lines
      if (leg.point !== undefined && leg.point !== null) {
        lineValidator.validateBettingLine(leg.market, leg.point, sportKey);
      }

      // Check for obvious contradictions
      if (leg.market === 'totals') {
        const realisticRange = lineValidator.getRealisticRanges(sportKey).totals;
        if (leg.point < realisticRange.min || leg.point > realisticRange.max) {
          errors.push(`Implausible total points: ${leg.point} for ${sportKey}`);
          continue;
        }
      }

      validLegs.push(leg);
    } catch (error) {
      errors.push(`Leg validation failed: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    console.warn('Parlay validation warnings:', errors);
  }

  if (validLegs.length === 0 && parlayData.legs.length > 0) {
    throw new Error('All parlay legs failed validation due to factual errors');
  }

  return {
    ...parlayData,
    legs: validLegs,
    validation: {
      originalCount: parlayData.legs.length,
      validCount: validLegs.length,
      errors
    }
  };
}

async function buildEliteScheduleContext(sportKey, hours, gameContext = null) {
    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (realGames.length === 0) {
            return `\n\n🎯 ELITE ANALYST MODE: No real-time ${sportKey} data available. Using fundamental analysis of typical matchups.`;
        }
        
        // ENHANCED: If we have a specific game context, focus on that
        if (gameContext) {
            const focusedGame = realGames.find(game => 
                game.id === gameContext.id || 
                game.event_id === gameContext.event_id ||
                `${game.away_team} @ ${game.home_team}` === `${gameContext.away_team} @ ${gameContext.home_team}`
            );
            
            if (focusedGame) {
                const timeStr = new Date(focusedGame.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                return `\n\n🎯 FOCUS GAME ANALYSIS:\n${focusedGame.away_team} @ ${focusedGame.home_team} - ${timeStr}\n\nCRITICAL: You MUST base your analysis exclusively on this specific game. Do not analyze other games.`;
            }
        }
        
        const gameList = realGames.slice(0, 20).map((game, index) => {
            const timeStr = new Date(game.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
        }).join('\n');
        return `\n\n📅 VERIFIED SCHEDULE (Next ${hours} hours):\n${gameList}\n\nCRITICAL: You MUST base your analysis exclusively on these real matchups. Do not invent games.`;
    } catch (error) {
        console.warn(`⚠️ Schedule context failed for ${sportKey}, using elite mode:`, error.message);
        return `\n\n🎯 ELITE ANALYST MODE: System data temporarily limited. Generating parlay using fundamental sports analysis.`;
    }
}

async function eliteGameValidation(sportKey, proposedLegs, hours, gameContext = null) {
    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (realGames.length === 0) {
            console.warn(`⚠️ Elite validation skipped for ${sportKey}: No real games found.`);
            return proposedLegs || [];
        }
        
        // ENHANCED: If we have a game context, only validate against that specific game
        if (gameContext) {
            const focusedGame = realGames.find(game => 
                game.id === gameContext.id || 
                game.event_id === gameContext.event_id ||
                `${game.away_team} @ ${game.home_team}` === `${gameContext.away_team} @ ${gameContext.home_team}`
            );
            
            if (focusedGame) {
                const validated = (proposedLegs || []).map(leg => {
                    const legEvent = (leg.event || '').toLowerCase().trim();
                    const expectedEvent = `${focusedGame.away_team} @ ${focusedGame.home_team}`.toLowerCase().trim();
                    
                    if (legEvent === expectedEvent) {
                        return { ...leg, commence_time: focusedGame.commence_time };
                    }
                    console.warn(`[Validation] Discarding invalid game: ${leg.event} - expected ${expectedEvent}`);
                    return null;
                }).filter(Boolean);
                return validated;
            }
        }
        
        // Original validation for when no specific game context
        const realGameMap = new Map(realGames.map(game => [`${(game.away_team || '').toLowerCase().trim()} @ ${(game.home_team || '').toLowerCase().trim()}`, game]));

        const validated = (proposedLegs || []).map(leg => {
            const legEvent = (leg.event || '').toLowerCase().trim();
            const realGame = realGameMap.get(legEvent);
            if (realGame) {
                return { ...leg, commence_time: realGame.commence_time };
            }
            console.warn(`[Validation] Discarding invalid game: ${leg.event}`);
            return null;
        }).filter(Boolean);
        return validated;
    } catch (error) {
        console.warn(`⚠️ Elite validation failed for ${sportKey}, using raw AI proposals:`, error.message);
        return proposedLegs || [];
    }
}

class AIService {
  constructor() {
    this.playerValidator = new PlayerValidationService();
    this.lineValidator = new BettingLineValidationService();
  }

  _ensureLegsHaveOdds(legs) {
    if (!Array.isArray(legs)) return [];
    return legs.map(leg => {
      const hasPrice = leg && leg.odds && Number.isFinite(Number(leg.odds.american));
      if (hasPrice) {
        leg.odds.decimal = americanToDecimal(leg.odds.american);
        return leg;
      }
      console.warn(`⚠️ AI failed to provide odds for leg: "${leg.selection}". Defaulting to -110.`);
      return {
        ...leg,
        odds: { american: -110, decimal: americanToDecimal(-110), implied_probability: 0.524 },
        quantum_analysis: { ...leg.quantum_analysis, analytical_basis: `(Odds defaulted to -110) ${leg.quantum_analysis?.analytical_basis || 'No rationale provided.'}` }
      };
    });
  }

  async _callAIProvider(prompt) {
    const { PERPLEXITY_API_KEY } = env;
    if (!PERPLEXITY_API_KEY) {
      throw new Error('Perplexity API key is not configured.');
    }

    for (let i = 0; i <= MAX_RETRIES; i++) {
        console.log(`🔄 Calling AI Provider: Perplexity (Attempt ${i + 1}/${MAX_RETRIES + 1})`);
        try {
            const response = await axios.post('https://api.perplexity.ai/chat/completions',
                { model: AI_MODELS.perplexity, messages: [{ role: 'user', content: prompt }] },
                { headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}` }, timeout: WEB_TIMEOUT_MS }
            );
            const responseText = response?.data?.choices?.[0]?.message?.content || '';
            const parsedJson = extractJSON(responseText);
            if (!parsedJson) throw new Error('AI response did not contain valid JSON.');
            return parsedJson;
        } catch (error) {
            console.error(`❌ Perplexity API Error (Attempt ${i + 1}):`, error.message);
            if (i === MAX_RETRIES) {
                if (error.response?.status === 401 || error.response?.status === 403) {
                    throw new Error('Perplexity API key invalid or expired');
                }
                throw new Error(`Perplexity API error after ${MAX_RETRIES + 1} attempts: ${error.message}`);
            }
            await sleep(1000 * (i + 1));
        }
    }
  }

  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options) {
      const requestId = `quantum_${sportKey}_${Date.now()}`;
      console.log(`🎯 Starting QUANTUM parlay generation for ${sportKey} in ${mode} mode...`);
      try {
          if (mode === 'web' || mode === 'live') {
              return await this._generateWebParlay(sportKey, numLegs, betType, options);
          }
          return await this._generateContextParlay(sportKey, numLegs, mode, betType, options);
      } catch (error) {
          console.error(`❌ QUANTUM parlay generation failed for ${requestId}:`, error.message);
          return this._generateFallbackParlay(sportKey, numLegs, betType, options);
      }
  }

  async _generateWebParlay(sportKey, numLegs, betType, options) {
      // ENHANCED: Pass gameContext to schedule context builder
      const scheduleContext = await buildEliteScheduleContext(sportKey, options.horizonHours || 72, options.gameContext);
      const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, { 
          scheduleInfo: scheduleContext,
          gameContext: options.gameContext 
      });
      const parlayData = await this._callAIProvider(prompt);
      
      if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
        throw new Error('AI response lacked valid parlay structure');
      }
      
      // ENHANCED VALIDATION - FACT CHECKING WITH GAME CONTEXT
      const validatedParlay = validateParlayResponse(parlayData, options.gameContext, sportKey);
      
      if (validatedParlay.validation.errors.length > validatedParlay.legs.length) {
        throw new Error(`AI generated too many factual errors: ${validatedParlay.validation.errors.join(', ')}`);
      }

      validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);
      
      // ENHANCED: Pass gameContext to elite validation
      const gameValidatedLegs = await eliteGameValidation(sportKey, validatedParlay.legs, options.horizonHours || 72, options.gameContext);
      
      if (gameValidatedLegs.length < numLegs) {
        console.warn(`[Web Mode] Validation failed to find all requested legs. Found ${gameValidatedLegs.length}/${numLegs}.`);
      }

      validatedParlay.legs = gameValidatedLegs;
      
      if (validatedParlay.legs.length === 0 && numLegs > 0) {
        return validatedParlay; 
      }

      validatedParlay.parlay_price_decimal = parlayDecimal(validatedParlay.legs);
      validatedParlay.parlay_price_american = decimalToAmerican(validatedParlay.parlay_price_decimal);
      
      try {
        validatedParlay.quantitative_analysis = await quantitativeService.evaluateParlay(validatedParlay.legs, validatedParlay.parlay_price_decimal);
      } catch (qError) {
        console.warn('Quantum quantitative analysis failed:', qError.message);
        validatedParlay.quantitative_analysis = { note: 'Advanced analysis temporarily limited', riskAssessment: { overallRisk: 'CALCULATED' } };
      }
      
      validatedParlay.research_metadata = { 
        quantum_mode: true, 
        real_games_validated: gameValidatedLegs.length, 
        prompt_strategy: 'quantum_web',
        validation_errors: validatedParlay.validation.errors
      };
      return validatedParlay;
  }
  
  async _findBestValuePlays(games) {
    const valuePlays = [];
    if (!games || games.length === 0) return valuePlays;

    for (const game of games) {
      const bookmaker = game.bookmakers?.[0];
      if (!bookmaker?.markets) continue;

      const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h');
      if (h2hMarket?.outcomes?.length >= 2) {
        const home = h2hMarket.outcomes.find(o => o.name === game.home_team);
        const away = h2hMarket.outcomes.find(o => o.name === game.away_team);

        if (home && away && home.price && away.price) {
          const homeProb = 1 / americanToDecimal(home.price);
          const awayProb = 1 / americanToDecimal(away.price);
          const totalProb = homeProb + awayProb;
          if (totalProb > 0) {
            const noVigHome = homeProb / totalProb;
            const noVigAway = awayProb / totalProb;
            const evHome = (americanToDecimal(home.price) * noVigHome - 1) * 100;
            const evAway = (americanToDecimal(away.price) * noVigAway - 1) * 100;
            if (evHome > 0) valuePlays.push({ game, market: h2hMarket, outcome: home, ev: evHome, noVigProb: noVigHome });
            if (evAway > 0) valuePlays.push({ game, market: h2hMarket, outcome: away, ev: evAway, noVigProb: noVigAway });
          }
        }
      }

      const totalsMarket = bookmaker.markets.find(m => m.key === 'totals');
      if (totalsMarket?.outcomes?.length === 2) {
          const over = totalsMarket.outcomes.find(o => o.name === 'Over');
          const under = totalsMarket.outcomes.find(o => o.name === 'Under');
          if (over && under && over.price && under.price) {
              const overProb = 1 / americanToDecimal(over.price);
              const underProb = 1 / americanToDecimal(under.price);
              const totalProb = overProb + underProb;
              if (totalProb > 0) {
                  const noVigOver = overProb / totalProb;
                  const noVigUnder = underProb / totalProb;
                  const evOver = (americanToDecimal(over.price) * noVigOver - 1) * 100;
                  const evUnder = (americanToDecimal(under.price) * noVigUnder - 1) * 100;
                  if (evOver > 0) valuePlays.push({ game, market: totalsMarket, outcome: over, ev: evOver, noVigProb: noVigOver });
                  if (evUnder > 0) valuePlays.push({ game, market: totalsMarket, outcome: under, ev: evUnder, noVigProb: noVigUnder });
              }
          }
      }
    }
    return valuePlays.sort((a, b) => b.ev - a.ev);
  }

  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`🤖 Generating parlay using local data from '${mode}' mode.`);
    try {
        // ENHANCED: If we have a game context, only use that specific game
        const allGames = options.gameContext ? [options.gameContext] : await gamesService.getGamesForSport(sportKey, {
            hoursAhead: options.horizonHours || 72,
            includeOdds: true,
            useCache: false,
            chatId: options.chatId
        });

        if (allGames.length === 0) {
            console.warn(`⚠️ Insufficient games in DB for ${sportKey}, using AI fallback.`);
            return await this._generateFallbackParlay(sportKey, numLegs, betType, options);
        }

        console.log(`🔍 Scanning ${allGames.length} games for +EV opportunities...`);
        const bestPlays = await this._findBestValuePlays(allGames);

        if (bestPlays.length < numLegs) {
            return {
                legs: [],
                portfolio_construction: {
                    overall_thesis: `No profitable (+EV) parlays could be constructed from the available game(s). A disciplined analyst would not force a bet in this market.`
                }
            };
        }

        console.log(`✅ Found ${bestPlays.length} +EV plays. Selecting the top ${numLegs}.`);
        const topPlays = bestPlays.slice(0, numLegs);
        
        const parlayLegs = topPlays.map(play => ({
            event: `${play.game.away_team} @ ${play.game.home_team}`,
            commence_time: play.game.commence_time,
            market: play.market.key,
            selection: `${play.outcome.name} ${play.outcome.point || ''}`.trim(),
            odds: {
                american: play.outcome.price,
                decimal: americanToDecimal(play.outcome.price),
                implied_probability: 1 / americanToDecimal(play.outcome.price)
            },
            quantum_analysis: {
                confidence_score: play.noVigProb * 100,
                analytical_basis: `Positive EV of +${play.ev.toFixed(1)}% identified. Calculated no-vig win probability of ${(play.noVigProb * 100).toFixed(1)}% exceeds market implied probability.`,
                key_factors: ["quantitative_edge", "market_inefficiency"]
            }
        }));
        
        const parlayData = { legs: parlayLegs };
        parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
        parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);
        parlayData.portfolio_construction = {
            overall_thesis: `This parlay was constructed by systematically identifying the ${numLegs} highest Expected Value (+EV) bets from all available games. Each leg represents a statistically profitable wager.`
        };
        try {
            parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
        } catch (error) {
            parlayData.quantitative_analysis = { note: 'Quantitative analysis failed.' };
        }
        
        parlayData.research_metadata = { mode, quantum_mode: true, games_used: parlayData.legs.length, prompt_strategy: 'database_quant_selection' };
        console.log(`✅ Successfully built ${numLegs}-leg parlay from database.`);
        return parlayData;

    } catch (error) {
        console.error(`❌ Database context parlay failed for ${sportKey}:`, error.message);
        return await this._generateFallbackParlay(sportKey, numLegs, betType, options);
    }
  }

  async _generateFallbackParlay(sportKey, numLegs, betType, options) {
      console.log(`🎯 Generating QUANTUM fallback for ${sportKey}`);
      // ENHANCED: Pass gameContext to schedule context builder
      const scheduleContext = await buildEliteScheduleContext(sportKey, 168, options.gameContext);
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, { 
          scheduleInfo: scheduleContext,
          gameContext: options.gameContext
        });
      const parlayData = await this._callAIProvider(prompt);
      
      if (!parlayData.legs || !Array.isArray(parlayData.legs)) {
        throw new Error('AI response lacked valid parlay structure in fallback');
      }

      // ENHANCED VALIDATION FOR FALLBACK TOO
      const validatedParlay = validateParlayResponse(parlayData, options.gameContext, sportKey);
      validatedParlay.legs = this._ensureLegsHaveOdds(validatedParlay.legs);
      
      // ENHANCED: Pass gameContext to elite validation
      const gameValidatedLegs = await eliteGameValidation(sportKey, validatedParlay.legs, 168, options.gameContext);
      validatedParlay.legs = gameValidatedLegs.length > 0 ? gameValidatedLegs.slice(0, numLegs) : validatedParlay.legs.slice(0, numLegs);

      validatedParlay.parlay_price_decimal = parlayDecimal(validatedParlay.legs);
      validatedParlay.parlay_price_american = decimalToAmerican(validatedParlay.parlay_price_decimal);
      
      validatedParlay.research_metadata = {
          quantum_mode: true,
          fallback_used: true,
          prompt_strategy: 'quantum_fallback',
          note: 'Generated using fundamental analysis without real-time data',
          validation_errors: validatedParlay.validation?.errors || []
      };
      
      return validatedParlay;
  }
}

export default new AIService();
