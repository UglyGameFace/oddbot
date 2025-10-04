// src/services/aiService.js - RESTORED & FINALIZED
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import { getSportTitle, getVerifiedSources } from './sportsService.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js';
import { buildParlayPrompt } from './promptService.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 90000;
const GEMINI_MODELS = { gemini: "gemini-pro", perplexity: "sonar-pro" };

function americanToDecimal(a) {
    const x = Number(a);
    if (!Number.isFinite(x)) return null;
    return x > 0 ? 1 + x / 100 : 1 + 100 / Math.abs(x);
}

function decimalToAmerican(d) {
    const x = Number(d);
    if (!Number.isFinite(x) || x <= 1) return null;
    return x >= 2 ? Math.round((x - 1) * 100) : Math.round(-100 / (x - 1));
}

function parlayDecimal(legs) {
    return (legs || []).reduce((acc, l) => acc * (Number(l.price_decimal) || 1), 1);
}

function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
        try { return JSON.parse(match[1]); } catch (e) { /* Fallback */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { /* Fallback */ }
    }
    return null;
}

// ✅ RESTORED: This function builds the critical context for the AI prompt.
async function buildRealScheduleContext(sportKey, hours) {
    try {
        // Step 1: Get the actual list of games from the single source of truth.
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (realGames.length === 0) {
            return `\n\n🚨 CRITICAL SCHEDULE ALERT: There are NO VERIFIED ${sportKey.toUpperCase()} games in the next ${hours} hours according to official data providers. DO NOT CREATE ANY LEGS. Return an empty parlay.`;
        }

        // Step 2: Format the game list for the AI.
        const gameList = realGames.slice(0, 25).map((game, index) => {
            const timeStr = new Date(game.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
        }).join('\n');

        // Step 3: Get the list of verifiable source URLs.
        const verifiedSources = getVerifiedSources(sportKey);

        // Step 4: Combine into a powerful prompt directive.
        return `\n\n📅 VERIFIED REAL SCHEDULE FOR ${sportKey.toUpperCase()} (Next ${hours} hours):
${gameList}

🔒 VERIFIED SOURCES: ${verifiedSources.join(', ')}

🚫 STRICT REQUIREMENT: You MUST ONLY use games from the verified schedule above. Do not hallucinate games. Base your web research on these real matchups.`;

    } catch (error) {
        console.error(`Failed to build schedule context for ${sportKey}:`, error);
        return `\n\n⚠️ SCHEDULE UNAVAILABLE: Be extremely careful to only use real, current ${sportKey} matchups.`;
    }
}

async function validateAndFilterRealGames(sportKey, proposedLegs, hours) {
    const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
    if (realGames.length === 0) return [];

    const realGameMap = new Map();
    realGames.forEach(game => {
        const key = `${(game.away_team || '').toLowerCase().trim()} @ ${(game.home_team || '').toLowerCase().trim()}`;
        realGameMap.set(key, game);
    });
    
    return (proposedLegs || []).filter(leg => {
        const gameKey = (leg.event || '').toLowerCase().trim();
        return realGameMap.has(gameKey);
    });
}

class AIService {
  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      try {
          if (mode === 'live' || mode === 'db') {
              return this._generateContextBasedParlay(sportKey, numLegs, mode, options);
          }

          // ✅ CORRECTED: Build the schedule context before creating the main prompt.
          const scheduleContext = await buildRealScheduleContext(sportKey, options.horizonHours || 72);
          const userQuery = `Generate a ${numLegs}-leg parlay for ${getSportTitle(sportKey)}. Focus on ${betType} bets.`;
          const prompt = buildParlayPrompt(userQuery, { sportKey, numLegs }) + scheduleContext;
          
          const aiResponse = await this._callAIProvider(aiModel, prompt);
          if (!aiResponse?.output_json?.legs) {
              throw new Error('AI response lacked a valid parlay structure.');
          }

          const parlayData = aiResponse.output_json;
          const validatedLegs = await validateAndFilterRealGames(sportKey, parlayData.legs, options.horizonHours || 72);

          if (validatedLegs.length === 0) {
              throw new Error(`SCHEDULE MISMATCH: AI proposed games, but NONE matched the official ${sportKey} schedule.`);
          }
          
          parlayData.legs = validatedLegs.slice(0, numLegs);
          parlayData.parlay_price_decimal = parlayDecimal(parlayData.legs);
          parlayData.parlay_price_american = decimalToAmerican(parlayData.parlay_price_decimal);
          parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
          
          return { ...parlayData, research_metadata: { requestId, real_games_validated: true } };
      } catch (error) {
          console.error(`❌ Parlay generation failed for ${requestId}:`, error.message);
          const fallbackError = new Error(`Web research failed: ${error.message}`);
          fallbackError.fallbackAvailable = true;
          throw fallbackError;
      }
  }

  async _callAIProvider(aiModel, prompt) {
      const { GOOGLE_GEMINI_API_KEY, PERPLEXITY_API_KEY } = env;
      let responseText;

      if (aiModel === 'gemini' && GOOGLE_GEMINI_API_KEY) {
          const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: GEMINI_MODELS.gemini });
          const result = await model.generateContent(prompt);
          responseText = result.response.text();
      } else if (aiModel === 'perplexity' && PERPLEXITY_API_KEY) {
          const response = await axios.post('https://api.perplexity.ai/chat/completions',
              { model: GEMINI_MODELS.perplexity, messages: [{ role: 'user', content: prompt }] },
              { headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}` }, timeout: WEB_TIMEOUT_MS }
          );
          responseText = response?.data?.choices?.[0]?.message?.content || '';
      } else { throw new Error(`${aiModel} API key not configured.`); }

      const parsedJson = extractJSON(responseText);
      if (!parsedJson) { throw new Error('AI response did not contain valid JSON.'); }
      return parsedJson;
  }
  
  async _generateContextBasedParlay(sportKey, numLegs, mode, options) {
      const realGames = await gamesService.getVerifiedRealGames(sportKey, options.horizonHours || 72);
      if (realGames.length < numLegs) {
          throw new Error(`Insufficient REAL ${sportKey} games found. Needed ${numLegs}, found ${realGames.length}.`);
      }
      const legs = realGames.slice(0, numLegs).map(game => ({
          event: `${game.away_team} @ ${game.home_team}`,
          market: 'moneyline',
          selection: game.home_team,
          price_american: -110,
          price_decimal: americanToDecimal(-110),
          rationale: `Selected from verified ${mode} schedule.`,
      }));
      const parlay_price_decimal = parlayDecimal(legs);
      const parlay_price_american = decimalToAmerican(parlay_price_decimal);
      return { legs, parlay_price_american, parlay_price_decimal, quantitative_analysis: await quantitativeService.evaluateParlay(legs, parlay_price_decimal) };
  }

  async handleFallbackSelection(sportKey, numLegs, mode, betType) {
    return this.generateParlay(sportKey, numLegs, mode, 'gemini', betType, { horizonHours: 72 });
  }
}

export default new AIService();
