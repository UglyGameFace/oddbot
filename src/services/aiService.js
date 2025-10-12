// src/services/aiService.js - FINAL, COMPLETE, AND CORRECTED (Value-First Quant Engine)
import { GoogleGenerativeAI } from '@google-generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 30000;

const AI_MODELS = {
  gemini: "gemini-1.5-flash",
  gemini_fallback: "gemini-1.5-pro",
  perplexity: "sonar-large-32k-online"
};

function americanToDecimal(a) {
    const x = Number(a);
    if (!Number.isFinite(x)) return 1.0;
    return x > 0 ? 1 + x / 100 : 1 + 100 / Math.abs(x);
}

function decimalToAmerican(d) {
    const x = Number(d);
    if (!Number.isFinite(x) || x <= 1) return null;
    return x >= 2 ? Math.round((x - 1) * 100) : Math.round(-100 / (x - 1));
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

class AIService {

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

  async _callAIProvider(aiModel, prompt) {
      const { GOOGLE_GEMINI_API_KEY, PERPLEXITY_API_KEY } = env;
      let responseText;

      if (aiModel === 'perplexity' || !GOOGLE_GEMINI_API_KEY) {
          if (!PERPLEXITY_API_KEY) throw new Error('Perplexity API key is not configured.');
          console.log(`🔄 Calling AI Provider: Perplexity`);
          try {
              const response = await axios.post('https://api.perplexity.ai/chat/completions',
                  { model: AI_MODELS.perplexity, messages: [{ role: 'user', content: prompt }] },
                  { headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}` }, timeout: WEB_TIMEOUT_MS }
              );
              responseText = response?.data?.choices?.[0]?.message?.content || '';
          } catch (error) {
              if (error.response?.status === 401 || error.response?.status === 403) throw new Error('Perplexity API key invalid or expired');
              throw new Error(`Perplexity API error: ${error.message}`);
          }
      } else {
          console.log(`🔄 Calling AI Provider: Gemini`);
          let lastError = null;
          const modelsToTry = [AI_MODELS.gemini, AI_MODELS.gemini_fallback];
          for (const modelName of modelsToTry) {
              try {
                  console.log(`  - Trying Gemini model: ${modelName}`);
                  const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);
                  const model = genAI.getGenerativeModel({ model: modelName });
                  const result = await model.generateContent(prompt);
                  responseText = result.response.text();
                  console.log(`  ✅ Success with Gemini model: ${modelName}`);
                  break; 
              } catch (modelError) {
                  lastError = modelError;
                  console.warn(`  ❌ Gemini model ${modelName} failed:`, modelError.message);
                  if (modelError.message.includes('API key') || modelError.message.includes('not supported')) {
                      throw new Error(`Gemini API Error: ${modelError.message}`);
                  }
              }
          }
          if (!responseText) throw new Error(`All Gemini models failed. Last error: ${lastError?.message}`);
      }

      const parsedJson = extractJSON(responseText);
      if (!parsedJson) throw new Error('AI response did not contain valid JSON.');
      return parsedJson;
  }

  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options) {
      const requestId = `quantum_${sportKey}_${Date.now()}`;
      console.log(`🎯 Starting QUANTUM parlay generation for ${sportKey} in ${mode} mode...`);
      try {
          if (mode === 'web') {
              return await this._generateWebParlay(sportKey, numLegs, aiModel, betType, options);
          }
          return await this._generateContextParlay(sportKey, numLegs, mode, betType, options);
      } catch (error) {
          console.error(`❌ QUANTUM parlay generation failed for ${requestId}:`, error.message);
          try {
              return await this._generateFallbackParlay(sportKey, numLegs, betType);
          } catch (fallbackError) {
              console.error(`❌ QUANTUM fallback failed:`, fallbackError.message);
              throw new Error(`QUANTUM ANALYSIS UNAVAILABLE: ${error.message}`);
          }
      }
  }

  async _generateWebParlay(sportKey, numLegs, aiModel, betType, options) {
      const scheduleContext = await buildEliteScheduleContext(sportKey, options.horizonHours || 72);
      const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, { scheduleInfo: scheduleContext });
      const parlayData = await this._callAIProvider(aiModel, prompt);
      
      if (!parlayData.legs || !Array.isArray(parlayData.legs)) throw new Error('AI response lacked valid parlay structure');
      
      parlayData.legs = this._ensureLegsHaveOdds(parlayData.legs);
      const validatedLegs = await eliteGameValidation(sportKey, parlayData.legs, options.horizonHours || 72);
      parlayData.legs = validatedLegs.length > 0 ? validatedLegs.slice(0, numLegs) : parlayData.legs.slice(0, numLegs);
      
      parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
      parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);
      
      try {
        parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
      } catch (qError) {
        console.warn('Quantum quantitative analysis failed:', qError.message);
        parlayData.quantitative_analysis = { note: 'Advanced analysis temporarily limited', riskAssessment: { overallRisk: 'CALCULATED' } };
      }
      
      parlayData.research_metadata = { quantum_mode: true, real_games_validated: validatedLegs.length > 0, prompt_strategy: 'quantum_web' };
      return parlayData;
  }

  // --- NEW: VALUE-FIRST QUANTITATIVE ENGINE FOR DATABASE MODE ---
  async _findBestValuePlays(games) {
    const valuePlays = [];
    if (!games || games.length === 0) return valuePlays;

    for (const game of games) {
      const bookmaker = game.bookmakers?.[0]; // Use the first available bookmaker
      if (!bookmaker?.markets) continue;

      // --- Analyze Moneyline (h2h) Market ---
      const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h');
      if (h2hMarket?.outcomes?.length >= 2) {
        const home = h2hMarket.outcomes.find(o => o.name === game.home_team);
        const away = h2hMarket.outcomes.find(o => o.name === game.away_team);

        if (home && away) {
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

      // --- Analyze Totals (Over/Under) Market ---
      const totalsMarket = bookmaker.markets.find(m => m.key === 'totals');
      if (totalsMarket?.outcomes?.length === 2) {
          const over = totalsMarket.outcomes.find(o => o.name === 'Over');
          const under = totalsMarket.outcomes.find(o => o.name === 'Under');

          if (over && under) {
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

    // Sort by highest EV
    return valuePlays.sort((a, b) => b.ev - a.ev);
  }

  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`🤖 Generating parlay using local data from '${mode}' mode.`);
    try {
        const allGames = await gamesService.getGamesForSport(sportKey, {
            hoursAhead: options.horizonHours || 72,
            includeOdds: true,
            useCache: false
        });

        if (allGames.length < numLegs) {
            console.warn(`⚠️ Insufficient games in DB for ${sportKey}, using AI fallback.`);
            return await this._generateFallbackParlay(sportKey, numLegs, betType);
        }

        // --- NEW LOGIC START ---
        console.log(`🔍 Scanning ${allGames.length} games for +EV opportunities...`);
        const bestPlays = await this._findBestValuePlays(allGames);

        if (bestPlays.length < numLegs) {
            return {
                legs: [],
                portfolio_construction: {
                    overall_thesis: `No profitable (+EV) parlays could be constructed from the ${allGames.length} available games. A disciplined analyst would not force a bet in this market.`
                }
            };
        }

        console.log(`✅ Found ${bestPlays.length} +EV plays. Selecting the top ${numLegs}.`);
        const topPlays = bestPlays.slice(0, numLegs);
        
        const parlayLegs = topPlays.map(play => ({
            event: `${play.game.away_team} @ ${play.game.home_team}`,
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
        // --- NEW LOGIC END ---
        
        const parlayData = { legs: parlayLegs };
        parlayData.legs = this._ensureLegsHaveOdds(parlayData.legs);
        parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
        parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);
        parlayData.portfolio_construction = {
            overall_thesis: `This parlay was constructed by systematically identifying the ${numLegs} highest Expected Value (+EV) bets from all available games in the database. Each leg represents a statistically profitable wager based on a no-vig probability calculation.`
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
        return await this._generateFallbackParlay(sportKey, numLegs, betType);
    }
  }

  async _generateFallbackParlay(sportKey, numLegs, betType) {
      console.log(`🎯 Generating QUANTUM fallback for ${sportKey}`);
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType);
      const parlayData = await this._callAIProvider('perplexity', prompt);
      
      parlayData.legs = this._ensureLegsHaveOdds(parlayData.legs);
      
      parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
      parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);
      
      parlayData.research_metadata = {
          quantum_mode: true,
          fallback_used: true,
          prompt_strategy: 'quantum_fallback',
          note: 'Generated using fundamental analysis without real-time data'
      };
      
      return parlayData;
  }

  async handleFallbackSelection(sportKey, numLegs, mode, betType) {
    console.log(`🎯 QUANTUM fallback selection: ${mode} for ${sportKey}`);
    return this.generateParlay(sportKey, numLegs, mode, 'perplexity', betType, { horizonHours: 72 });
  }
}

export default new AIService();
