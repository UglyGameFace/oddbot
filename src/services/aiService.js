// src/services/aiService.js
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

// Safety settings (unchanged)
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Current, supported text models for v1 generateContent (fast → strong) [web:457][web:464]
const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-pro-latest',
];

// Small utility: call Models List and pick the first candidate that exists (supports generateContent) [web:461]
async function pickSupportedModel(apiKey, candidates = GEMINI_MODEL_CANDIDATES) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const names = new Set((data?.models || []).map(m => (m.name || '').replace(/^models\//, '')));
    for (const id of candidates) if (names.has(id)) return id;
  } catch {
    // If the list call fails, proceed with default ordering
  }
  return candidates[0];
}

// Robust JSON extractor: returns the first top-level JSON object if present
function extractFirstJsonObject(text = '') {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);

class AIService {
  async generateParlay(sportKey, numLegs = 2, mode = 'live', aiModel = 'gemini', betType = 'mixed') {
    if (mode === 'web') {
      if (aiModel === 'perplexity' && env.PERPLEXITY_API_KEY) {
        return this._generateWithPerplexity(sportKey, numLegs, betType);
      }
      return this._generateWithGemini(sportKey, numLegs, 'web', betType);
    }
    return this._generateWithGemini(sportKey, numLegs, mode, betType);
  }

  async _generateWithPerplexity(sportKey, numLegs, betType) {
    console.log(`AI Service: Using Perplexity Web Research mode for ${betType}.`);
    const betTypeInstruction = betType === 'props'
      ? 'Your parlay must consist exclusively of Player Prop bets (e.g., player points, assists, touchdowns, yards).'
      : 'Your parlay can be a mix of moneyline, spread, totals, or player props.';

    const prompt = `You are a precise, data-driven sports betting analyst. Your only task is to perform a web search to find the best ${numLegs}-leg parlay for ${sportKey}. ${betTypeInstruction} Focus on statistical mismatches, recent performance data, and confirmed player injuries. You must find real bets on major sportsbooks (DraftKings, FanDuel, BetMGM). Your final output must be ONLY a valid JSON object in the specified format, with no other text. JSON FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "sportsbook": "...", "justification": "..." } ], "confidence_score": 0.80 }`;

    try {
      const response = await axios.post(
        'https://api.perplexity.ai/chat/completions',
        {
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are a sports betting analyst.' },
            { role: 'user', content: prompt }
          ],
        },
        { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` } }
      );

      const text = response?.data?.choices?.[0]?.message?.content || '';
      const obj = extractFirstJsonObject(text);
      if (!obj) throw new Error('Perplexity did not return valid JSON.');
      return obj;
    } catch (error) {
      console.error('Perplexity API error:', error?.message || error);
      throw new Error('Failed to generate parlay with Perplexity.');
    }
  }

  async _generateWithGemini(sportKey, numLegs, mode, betType) {
    // Resolve a supported model at runtime to avoid 404s on retired IDs [web:461][web:457]
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: modelId,
      safetySettings,
      generationConfig: { maxOutputTokens: 4096 },
    });

    let finalPrompt;
    const betTypeInstruction = betType === 'props'
      ? 'Your parlay must consist exclusively of Player Prop bets (e.g., player points, assists, touchdowns, yards).'
      : 'The legs can be a mix of moneyline (h2h), spreads, totals, or player props.';

    if (mode === 'web') {
      console.log(`AI Service: Using Gemini Web Research mode for ${betType}.`);
      finalPrompt =
        `You are a world-class sports betting research analyst. Perform a deep, current web research to construct a compelling ${numLegs}-leg parlay for ${sportKey}. `
        + `CRITICAL: Use only up-to-date web sources, identify real bets on a major sportsbook (DraftKings, FanDuel, BetMGM). ${betTypeInstruction} `
        + `Provide evidence for each leg and respond ONLY with JSON in this shape: `
        + `{ "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "sportsbook": "...", "justification": "..." } ], "confidence_score": 0.82 }`;
    } else if (mode === 'db') {
      console.log('AI Service: Using database-only mode.');
      const gameData = await gamesService.getGamesForSport(sportKey);
      if (!gameData?.length) throw new Error('No games in the database for the specified sport.');
      finalPrompt =
        `You are an expert sports betting analyst. Construct a ${numLegs}-leg parlay using ONLY the provided game data. `
        + `Allow moneyline (h2h), spreads, or props per instruction. Provide justification per leg. `
        + `Return ONLY JSON: { "parlay_legs": [{"game": "...", "market": "...", "pick": "...", "justification": "..."}], "confidence_score": 0.75 } `
        + `Game Data:\n\`\`\`json\n${JSON.stringify(gameData.slice(0, 15), null, 2)}\n\`\`\``;
    } else {
      // 'live' mode
      console.log(`AI Service: Using live API mode for ${betType}.`);
      const liveGames = await oddsService.getSportOdds(sportKey);
      if (!liveGames?.length) throw new Error('Could not fetch live odds.');

      const enrichedGames = await Promise.all(
        liveGames.slice(0, 10).map(async (g) => ({
          ...g,
          player_props: await oddsService.getPlayerPropsForGame(sportKey, g.event_id || g.id || g.game_id)
        }))
      );

      finalPrompt =
        `You are an expert sports betting analyst. Build a ${numLegs}-leg parlay from the provided live odds and props. ${betTypeInstruction} `
        + `Provide detailed justification for each leg and respond ONLY with JSON: `
        + `{ "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "justification": "..." } ], "confidence_score": 0.85 } `
        + `Live Data:\n\`\`\`json\n${JSON.stringify(enrichedGames, null, 2)}\n\`\`\``;
    }

    try {
      const result = await model.generateContent(finalPrompt);
      const text = result?.response?.text?.() ?? '';
      const obj = extractFirstJsonObject(text);
      if (!obj) throw new Error('AI response did not contain a valid JSON object.');
      return obj;
    } catch (error) {
      console.error(`Gemini parlay generation error in ${mode} mode (model=${modelId}):`, error?.message || error);
      // Fallback across remaining candidates if the chosen model fails [web:457][web:464]
      for (const fallback of GEMINI_MODEL_CANDIDATES.filter(m => m !== modelId)) {
        try {
          const alt = genAI.getGenerativeModel({
            model: fallback,
            safetySettings,
            generationConfig: { maxOutputTokens: 4096 },
          });
          const altResp = await alt.generateContent(finalPrompt);
          const text = altResp?.response?.text?.() ?? '';
          const obj = extractFirstJsonObject(text);
          if (obj) return obj;
        } catch {}
      }
      throw new Error(`Failed to generate AI parlay using Gemini in ${mode} mode.`);
    }
  }

  async validateOdds(oddsData) {
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: modelId, safetySettings });
    const prompt = `Validate this JSON odds structure; respond ONLY with {"valid": true|false}. Data: ${JSON.stringify(oddsData)}`;
    try {
      const result = await model.generateContent(prompt);
      const text = result?.response?.text?.() ?? '';
      const obj = extractFirstJsonObject(text);
      if (!obj || typeof obj.valid !== 'boolean') return { valid: false };
      return obj;
    } catch (error) {
      console.error('AI validation error:', error?.message || error);
      return { valid: false };
    }
  }
}

export default new AIService();
