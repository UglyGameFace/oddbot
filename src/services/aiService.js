// src/services/aiService.js - FINAL, COMPLETE, AND CORRECTED
import { GoogleGenerativeAI } from '@google/generative-ai';
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
          // --- CHANGE START: All other modes now go to the context/DB generator ---
          return await this._generateContextParlay(sportKey, numLegs, mode, betType, options);
          // --- CHANGE END ---
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

  // --- THIS IS THE CORRECTED FUNCTION ---
  async _generateContextParlay(sportKey, numLegs, mode, betType, options) {
    console.log(`🤖 Generating parlay using local data from '${mode}' mode.`);
    try {
        // Step 1: Fetch games directly from our own service (which uses the database)
        const allGames = await gamesService.getGamesForSport(sportKey, {
            hoursAhead: options.horizonHours || 72,
            includeOdds: true, // Make sure we have odds to work with
            useCache: false    // Use fresh data for this request
        });

        if (allGames.length < numLegs) {
            console.warn(`⚠️ Insufficient games in DB for ${sportKey} (${allGames.length} found), using AI fallback.`);
            return await this._generateFallbackParlay(sportKey, numLegs, betType);
        }

        // Step 2: Randomly select games from the available list
        const selectedGames = allGames.sort(() => 0.5 - Math.random()).slice(0, numLegs);

        // Step 3: Build the parlay legs locally without calling an external AI
        const parlayLegs = selectedGames.map(game => {
            const market = game.bookmakers?.[0]?.markets.find(m => m.key === 'h2h'); // Default to moneyline
            const outcome = market?.outcomes?.[0]; // Default to the first outcome (e.g., home team)
            
            return {
                event: `${game.away_team} @ ${game.home_team}`,
                market: market?.key || 'moneyline',
                selection: outcome?.name || game.home_team,
                odds: {
                    american: outcome?.price || -110, // Default odds if none found
                    decimal: americanToDecimal(outcome?.price || -110)
                },
                quantum_analysis: {
                    confidence_score: 60, // Assign a neutral confidence
                    analytical_basis: 'Selected from available database games.'
                }
            };
        });
        
        const parlayData = { legs: parlayLegs };
        parlayData.legs = this._ensureLegsHaveOdds(parlayData.legs);
        parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
        parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);

        try {
            parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
        } catch (error) {
            parlayData.quantitative_analysis = { note: 'Quantitative analysis failed.' };
        }
        
        parlayData.research_metadata = { mode, quantum_mode: true, games_used: parlayData.legs.length, prompt_strategy: 'database_selection' };
        
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
      const parlayData = await this._callAIProvider('perplexity', prompt); // Use Perplexity for fallback
      
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
