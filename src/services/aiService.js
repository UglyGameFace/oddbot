// src/services/aiService.js - COMPLETE WITH CENTRALIZED SCHEDULE VALIDATION & PROMPTING
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import { getSportTitle } from './sportsService.js';
import gamesService from './gamesService.js';
import { rateLimitService } from './rateLimitService.js';
import { sentryService } from './sentryService.js';
import quantitativeService from './quantitativeService.js';
import { buildParlayPrompt } from './promptService.js';

const WEB_TIMEOUT_MS = 90000;
const GEMINI_MODELS = {
    gemini: "gemini-pro",
    perplexity: "sonar-pro" // Placeholder for logic
};

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
  return (legs || []).reduce((acc, l) => acc * (Number(l.price_decimal || l.odds_decimal) || 1), 1);
}

function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
        try { return JSON.parse(match[1]); } catch (e) { console.warn('Failed to parse JSON from fenced block'); }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { console.warn('Failed to parse JSON from substring'); }
    }
    return null;
}

async function validateAndFilterRealGames(sportKey, proposedLegs, hours = 72) {
  try {
    const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
    if (realGames.length === 0) {
      console.warn(`❌ No real games found for ${sportKey} to validate against.`);
      return [];
    }
    const realGameMap = new Map();
    realGames.forEach(game => {
      const key = `${(game.away_team || '').toLowerCase().trim()} @ ${(game.home_team || '').toLowerCase().trim()}`;
      realGameMap.set(key, game);
    });
    
    const validLegs = [];
    (proposedLegs || []).forEach(leg => {
      const gameKey = (leg.event || leg.game || '').toLowerCase().trim();
      const realGame = realGameMap.get(gameKey);
      if (realGame) {
        leg.event_id = realGame.event_id;
        leg.game_date_utc = realGame.commence_time;
        leg.real_game_validated = true;
        validLegs.push(leg);
      } else {
        console.warn(`❌ REJECTED (Not in schedule): "${leg.event || leg.game}"`);
      }
    });
    console.log(`🎯 VALIDATION: ${validLegs.length}/${(proposedLegs || []).length} legs are real.`);
    return validLegs;
  } catch (error) {
    console.error('❌ Schedule validation failed:', error);
    return [];
  }
}

class AIService {
  constructor() { this.generationStats = {}; }

  async generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'gemini', betType = 'mixed', options = {}) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      const startTime = Date.now();
      try {
          const userQuery = `Generate a ${numLegs}-leg parlay for ${getSportTitle(sportKey)}. Focus on ${betType} bets. Include player props: ${options.includeProps ? 'Yes' : 'No'}.`;
          const prompt = buildParlayPrompt(userQuery, { sportKey, numLegs, ...options });
          
          let aiResponse;
          if (mode === 'web') {
              aiResponse = await this._callAIProvider(aiModel, prompt);
          } else {
              aiResponse = await this._generateContextBasedParlay(sportKey, numLegs, betType, options);
          }

          if (!aiResponse || !aiResponse.output_json || aiResponse.output_json.mode !== 'BETS') {
              throw new Error('AI response did not conform to the required BETS schema.');
          }
          
          const parlayData = aiResponse.output_json;
          const validatedLegs = await validateAndFilterRealGames(sportKey, parlayData.legs, options.horizonHours || 72);

          if (validatedLegs.length === 0) {
              throw new Error(`SCHEDULE MISMATCH: AI proposed games, but NONE matched the official ${sportKey} schedule.`);
          }
          
          parlayData.legs = validatedLegs.slice(0, numLegs);
          parlayData.quantitative_analysis = await quantitativeService.evaluateParlay(parlayData.legs, parlayData.parlay_price_decimal);
          
          return {
              ...parlayData,
              research_metadata: { requestId, processing_time_ms: Date.now() - startTime, real_games_validated: true }
          };
      } catch (error) {
        console.error(`❌ Parlay generation failed for ${requestId}:`, error.message);
        const fallbackError = new Error(`Web research failed: ${error.message}`);
        fallbackError.fallbackAvailable = true;
        fallbackError.originalError = error.message;
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
          const response = await axios.post(
              'https://api.perplexity.ai/chat/completions',
              { model: GEMINI_MODELS.perplexity, messages: [{ role: 'user', content: prompt }] },
              { headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}` }, timeout: WEB_TIMEOUT_MS }
          );
          responseText = response?.data?.choices?.[0]?.message?.content || '';
      } else {
          throw new Error(`${aiModel} API key not configured or model is unsupported.`);
      }

      const parsedJson = extractJSON(responseText);
      if (!parsedJson) { throw new Error('AI response did not contain a valid JSON block.'); }
      return parsedJson;
  }
  
  async _generateContextBasedParlay(sportKey, numLegs, betType, options) {
      const realGames = await gamesService.getVerifiedRealGames(sportKey, options.horizonHours || 72);
      if (!realGames || realGames.length < numLegs) {
          throw new Error(`Insufficient REAL ${sportKey} games found. Needed ${numLegs}, found ${realGames?.length || 0}.`);
      }

      const legs = realGames.slice(0, numLegs).map(game => ({
          event: `${game.away_team} @ ${game.home_team}`,
          market: 'moneyline',
          selection: game.home_team,
          price_american: -110,
          price_decimal: americanToDecimal(-110),
          rationale: `Selected from verified live schedule.`,
          implied_prob: 0.5,
          real_game_validated: true,
      }));
      
      const parlay_price_decimal = parlayDecimal(legs);
      const parlay_price_american = decimalToAmerican(parlay_price_decimal);

      return {
          output_json: {
              mode: 'BETS', sport: sportKey, legs, parlay_price_american, parlay_price_decimal,
              est_win_prob: Math.pow(0.5, numLegs), est_ev_pct: -0.05,
          }
      };
  }

  async handleFallbackSelection(sportKey, numLegs, mode, betType) {
    return this.generateParlay(sportKey, numLegs, mode, 'gemini', betType, { horizonHours: 72 });
  }
}

export default new AIService();
