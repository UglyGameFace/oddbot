// src/services/aiService.js

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

// --- Safety settings
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// --- Supported Gemini models (fast → strong)
const GEMINI_MODEL_CANDIDATES = ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-pro-latest'];

// --- Model resolution
async function pickSupportedModel(apiKey, candidates = GEMINI_MODEL_CANDIDATES) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const names = new Set((data?.models || []).map((m) => (m.name || '').replace(/^models\//, '')));
    for (const id of candidates) if (names.has(id)) return id;
  } catch {
    // ignore and fall back
  }
  return candidates[0];
}

/**
 * --- FIX: More robust JSON extraction ---
 * Extracts the first valid JSON object from a string, tolerating markdown code blocks and other text.
 * @param {string} text - The text from the AI response.
 * @returns {object|null} The parsed JSON object or null if not found.
 */
function extractFirstJsonObject(text = '') {
  // First, try to find a JSON markdown block
  let jsonString = '';
  const markdownMatch = String(text).match(/```json\s*([\s\S]*?)\s*```/);
  if (markdownMatch && markdownMatch[1]) {
    jsonString = markdownMatch[1];
  } else {
    // If no markdown block, fall back to finding the first '{' and last '}'
    const firstBrace = String(text).indexOf('{');
    const lastBrace = String(text).lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return null;
    }
    jsonString = text.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(jsonString);
  } catch {
    return null; // Return null if parsing fails
  }
}

// --- Timezone helpers
const TZ = env.TIMEZONE || 'America/New_York';
function formatLocal(isoUtc, tz = TZ) {
  try {
    if (!isoUtc) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoUtc));
  } catch {
    return '';
  }
}

// --- Fixtures helpers
async function getUpcomingFixtures(sportKey, hoursHorizon = 120) {
  const now = Date.now();
  const horizon = now + hoursHorizon * 3600_000;
  let games = await oddsService.getSportOdds(sportKey);
  if (!games?.length) games = await gamesService.getGamesForSport(sportKey);
  return (games || [])
    .filter((g) => {
      const t = Date.parse(g.commence_time);
      return Number.isFinite(t) && t >= now && t <= horizon;
    })
    .map((g) => ({
      event_id: g.event_id || g.id || g.game_id || null,
      away_team: g.away_team,
      home_team: g.home_team,
      commence_time: g.commence_time,
    }));
}

/**
 * --- FIX: Graceful leg matching ---
 * Binds AI-generated legs to real fixtures, but filters out any legs that can't be matched
 * instead of throwing an error. This makes the system resilient to AI hallucinations.
 * @param {Array} legs - The parlay legs from the AI.
 * @param {Array} fixtures - The list of real, available games.
 * @returns {Array} A list of valid, matched parlay legs.
 */
function bindLegsToFixtures(legs = [], fixtures = []) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const matchedLegs = [];

  for (const leg of legs) {
    const txt = String(leg.game || '').toLowerCase();
    const hit = fixtures.find((f) => txt.includes(norm(f.away_team)) && txt.includes(norm(f.home_team)));
    
    if (hit) {
      matchedLegs.push({
        ...leg,
        game: `${hit.away_team} @ ${hit.home_team}`,
        event_id: hit.event_id || leg.event_id || null,
        game_date_utc: hit.commence_time,
        game_date_local: formatLocal(hit.commence_time, TZ),
      });
    } else {
      console.warn(`[AI Hallucination] Unmatched leg discarded: ${leg.game}`);
    }
  }
  return matchedLegs;
}

// --- Gemini client
const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);

class AIService {
  // mode: 'web' | 'live' | 'db'; aiModel: 'perplexity' | 'gemini'
  async generateParlay(sportKey, numLegs = 2, mode = 'live', aiModel = 'gemini', betType = 'mixed', opts = {}) {
    const includeProps = !!opts.includeProps;

    if (mode === 'web') {
      if (aiModel === 'perplexity' && env.PERPLEXITY_API_KEY) {
        return this._generateWithPerplexity(sportKey, numLegs, betType);
      }
      return this._generateWithGemini(sportKey, numLegs, 'web', betType, { includeProps });
    }

    if (mode === 'db') {
      return this._generateWithGemini(sportKey, numLegs, 'db', betType, { includeProps });
    }

    // default: live
    return this._generateWithGemini(sportKey, numLegs, 'live', betType, { includeProps });
  }

  async _generateWithPerplexity(sportKey, numLegs, betType) {
    console.log(`AI Service: Using Perplexity Web Research mode for ${betType}.`);
    const betTypeInstruction =
      betType === 'props'
        ? 'Your parlay must consist exclusively of Player Prop bets (e.g., player points, assists, touchdowns, yards).'
        : 'Your parlay can be a mix of moneyline, spread, totals, or player props.';

    const prompt = `You are a precise, data-driven sports betting analyst. Your only task is to perform a web search to find the best ${numLegs}-leg parlay for ${sportKey}. ${betTypeInstruction} Focus on statistical mismatches, recent performance data, and confirmed player injuries. You must find real bets on major sportsbooks (DraftKings, FanDuel, BetMGM). Your final output must be ONLY a valid JSON object in the specified format, with no other text. JSON FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "sportsbook": "...", "justification": "..." } ], "confidence_score": 0.80 }`;

    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro', // Using a more capable model
        messages: [
          { role: 'system', content: 'You are a sports betting analyst who responds only in JSON.' },
          { role: 'user', content: prompt },
        ],
      },
      { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` } },
    );

    const text = response?.data?.choices?.[0]?.message?.content || '';
    const obj = extractFirstJsonObject(text);
    if (!obj) throw new Error('Perplexity did not return valid JSON.');
    return obj;
  }

  async _generateWithGemini(sportKey, numLegs, mode, betType, { includeProps } = {}) {
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: modelId,
      safetySettings,
      generationConfig: { 
          maxOutputTokens: 4096,
          responseMimeType: "application/json", // Instruct Gemini to output JSON directly
      },
    });

    const betTypeInstruction =
      betType === 'props'
        ? 'Your parlay must consist exclusively of Player Prop bets (e.g., player points, assists, touchdowns, yards).'
        : 'The legs can be a mix of moneyline (h2h), spreads, totals, or player props.';

    let promptText = '';

    if (mode === 'web') {
      console.log(`AI Service: Using Gemini Web Research mode for ${betType}.`);
      const fixtures = await getUpcomingFixtures(sportKey, 120);
      if (!fixtures.length) throw new Error('No upcoming fixtures found for web mode.');
      const todayIso = new Date().toISOString();
      promptText =
        `Today is ${todayIso} (UTC). Choose ONLY from the fixtures below; do not use past-season content or invent games. `
        + `Pick ${numLegs} legs; ${betTypeInstruction} Include sportsbook and brief evidence. `
        + `Return ONLY a JSON object based on this schema: {"parlay_legs":[{"game":"","market":"...","pick":"...","sportsbook":"...","justification":"..."}],"confidence_score":0.xx}\n`
        + `Fixtures (ISO UTC commence_time):\n\`\`\`json\n${JSON.stringify(fixtures, null, 2)}\n\`\`\``;

      const result = await model.generateContent(promptText);
      const text = result?.response?.text?.() ?? '';
      const obj = extractFirstJsonObject(text);
      if (!obj?.parlay_legs?.length) throw new Error('AI returned invalid or empty JSON.');
      obj.parlay_legs = bindLegsToFixtures(obj.parlay_legs, fixtures);
      return obj;
    }

    if (mode === 'db') {
      console.log('AI Service: Using database-only mode.');
      const gameData = await gamesService.getGamesForSport(sportKey);
      if (!gameData?.length) throw new Error('No games in the database for the specified sport.');
      const fixtures = (gameData || [])
        .filter((g) => g.commence_time)
        .map((g) => ({
          event_id: g.event_id || g.id || g.game_id || null,
          away_team: g.away_team,
          home_team: g.home_team,
          commence_time: g.commence_time,
        }));
      promptText =
        `You are an expert sports betting analyst. Construct a ${numLegs}-leg parlay using ONLY the provided fixtures. `
        + `${betTypeInstruction} Provide justification per leg. `
        + `Return ONLY a JSON object based on this schema: { "parlay_legs": [{"game": "","market":"...","pick":"...","justification":"..."}], "confidence_score": 0.75 }\n`
        + `Fixtures:\n\`\`\`json\n${JSON.stringify(fixtures.slice(0, 25), null, 2)}\n\`\`\``;

      const result = await model.generateContent(promptText);
      const text = result?.response?.text?.() ?? '';
      const obj = extractFirstJsonObject(text);
      if (!obj?.parlay_legs?.length) throw new Error('AI returned invalid or empty JSON.');
      obj.parlay_legs = bindLegsToFixtures(obj.parlay_legs, fixtures);
      return obj;
    }

    // live mode
    console.log(`AI Service: Using live API mode for ${betType}.`);
    const liveGames = await oddsService.getSportOdds(sportKey);
    if (!liveGames?.length) throw new Error('Could not fetch live odds.');

    const shouldFetchProps = includeProps || betType === 'props';
    const enrichedGames = await Promise.all(
      liveGames.slice(0, 10).map(async (g) => {
        if (!shouldFetchProps) return g;
        const eventId = g.event_id || g.id || g.game_id;
        if (!eventId) return { ...g, player_props: null };
        try {
          const props = await oddsService.getPlayerPropsForGame(sportKey, eventId, {
            regions: 'us',
            markets: 'player_points,player_assists,player_rebounds',
            oddsFormat: 'american',
          });
          return { ...g, player_props: props };
        } catch (e) {
          console.warn(`Props unavailable for ${eventId}: ${e?.response?.status || e?.message}`);
          return { ...g, player_props: null };
        }
      }),
    );

    const fixtures = (liveGames || [])
      .filter((g) => g.commence_time)
      .map((g) => ({
        event_id: g.event_id || g.id || g.game_id || null,
        away_team: g.away_team,
        home_team: g.home_team,
        commence_time: g.commence_time,
      }));

    promptText =
      `You are an expert sports betting analyst. Build a ${numLegs}-leg parlay from the provided live odds${shouldFetchProps ? ' and props' : ''}. `
      + `${betTypeInstruction} Provide detailed justification per leg. `
      + `Return ONLY a JSON object based on this schema: { "parlay_legs": [ { "game": "", "market": "...", "pick": "...", "justification": "..." } ], "confidence_score": 0.85 }\n`
      + `Live ${shouldFetchProps ? 'Odds/Props' : 'Odds'} Snapshot:\n\`\`\`json\n${JSON.stringify(enrichedGames, null, 2)}\n\`\`\`\n`
      + `Fixtures:\n\`\`\`json\n${JSON.stringify(fixtures.slice(0, 25), null, 2)}\n\`\`\``;

    const result = await model.generateContent(promptText);
    const text = result?.response?.text?.() ?? '';
    const obj = extractFirstJsonObject(text);
    if (!obj?.parlay_legs?.length) throw new Error('AI returned invalid or empty JSON.');
    obj.parlay_legs = bindLegsToFixtures(obj.parlay_legs, fixtures);
    return obj;
  }

  async validateOdds(oddsData) {
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
        model: modelId, 
        safetySettings,
        generationConfig: { responseMimeType: "application/json" },
    });
    const prompt = `Validate this JSON odds structure; respond ONLY with a JSON object like {"valid": true} or {"valid": false}. Data: ${JSON.stringify(oddsData)}`;
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
