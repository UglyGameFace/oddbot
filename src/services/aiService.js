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
const GEMINI_MODEL_CANDIDATES = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-pro-latest'];

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

function extractFirstJsonObject(text = '') {
  let jsonString = '';
  const markdownMatch = String(text).match(/```json\s*([\s\S]*?)\s*```/);
  if (markdownMatch && markdownMatch[1]) {
    jsonString = markdownMatch[1];
  } else {
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
    return null;
  }
}

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

const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);

class AIService {
  // --- UPDATED: Main router function ---
  async generateParlay(sportKey, numLegs = 2, mode = 'live', aiModel = 'gemini', betType = 'mixed', opts = {}) {
    const includeProps = !!opts.includeProps;
    if (mode === 'web') {
      if (aiModel === 'perplexity' && env.PERPLEXITY_API_KEY) {
        return this._generateWithPerplexityWeb(sportKey, numLegs, betType);
      }
      return this._generateWithGeminiWeb(sportKey, numLegs, betType);
    }
    // 'live' and 'db' modes are handled by the context-based method
    return this._generateWithGeminiContext(sportKey, numLegs, mode, betType, { includeProps });
  }

  // --- ADDED: Helper for consistent instructions ---
  _getBetTypeInstruction(betType) {
    return betType === 'props'
        ? 'Each leg of the parlay MUST be a Player Prop bet (e.g., player points, assists, touchdowns, yards).'
        : 'The parlay can be a mix of moneyline, spread, totals, or player props.';
  }

  // --- ADDED: Specialized function for Perplexity Web Research ---
  async _generateWithPerplexityWeb(sportKey, numLegs, betType) {
    console.log(`AI Service: Using Perplexity Web Research for ${betType}.`);
    const betTypeInstruction = this._getBetTypeInstruction(betType);
    const currentDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

    const prompt = `Act as a senior sports betting analyst. Today is ${currentDate}. Your task is to perform a deep web search for upcoming games in ${sportKey} and construct the most statistically sound ${numLegs}-leg parlay. Your analysis must prioritize recent performance trends (last 5-10 games), head-to-head matchups, and confirmed injury reports. For each leg, provide a sharp, data-driven justification. Your final output must be ONLY a valid JSON object with no introductory text. JSON FORMAT: { "parlay_legs": [ { "game": "Away Team @ Home Team", "market": "...", "pick": "...", "sportsbook": "FanDuel", "justification": "..." } ], "confidence_score": 0.85 }`;

    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro', // Corrected model name
        messages: [
          { role: 'system', content: 'You are a sports betting analyst who responds only in valid JSON format.' },
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
  
  // --- ADDED: Specialized function for Gemini Web Research ---
  async _generateWithGeminiWeb(sportKey, numLegs, betType) {
    console.log(`AI Service: Using Gemini Web Research for ${betType}.`);
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: modelId, safetySettings, generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" } });
    const betTypeInstruction = this._getBetTypeInstruction(betType);
    const currentDate = new Date().toISOString();

    const promptText = `As a top-tier sports analyst, your task is to use your internal knowledge and web search capabilities to find upcoming games for the ${sportKey} league. Today's date is ${currentDate}. Construct a ${numLegs}-leg parlay with a high probability of success. Your reasoning must be sharp, referencing key player stats, team dynamics, and any critical news like injuries. ${betTypeInstruction} Return ONLY a valid JSON object adhering to this schema: {"parlay_legs":[{"game":"Away Team @ Home Team","market":"e.g., Moneyline or Player Points","pick":"e.g., Team Name or Player Name Over 25.5","sportsbook":"DraftKings","justification":"Concise, data-driven reason."}],"confidence_score":0.80}`;
    
    const result = await model.generateContent(promptText);
    const text = result?.response?.text?.() ?? '';
    const obj = extractFirstJsonObject(text);
    if (!obj?.parlay_legs?.length) throw new Error('AI returned invalid or empty JSON.');
    return obj;
  }

  // --- ADDED: Specialized function for Live/DB Context Modes ---
  async _generateWithGeminiContext(sportKey, numLegs, mode, betType, { includeProps } = {}) {
    console.log(`AI Service: Using Gemini with ${mode} context for ${betType}.`);
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: modelId, safetySettings, generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" } });
    const betTypeInstruction = this._getBetTypeInstruction(betType);

    let contextData, fixtures;
    if (mode === 'live') {
      const liveGames = await oddsService.getSportOdds(sportKey);
      if (!liveGames?.length) throw new Error('Could not fetch live odds. The API key may be maxed out or no games are available.');
      
      const shouldFetchProps = includeProps || betType === 'props';
      contextData = await Promise.all(
        liveGames.slice(0, 10).map(async (g) => {
          if (!shouldFetchProps) return g;
          const eventId = g.event_id || g.id || g.game_id;
          if (!eventId) return { ...g, player_props: null };
          try {
            const props = await oddsService.getPlayerPropsForGame(sportKey, eventId);
            return { ...g, player_props: props };
          } catch (e) {
            console.warn(`Props unavailable for ${eventId}: ${e?.response?.status || e?.message}`);
            return { ...g, player_props: null };
          }
        }),
      );
      fixtures = liveGames;
    } else { // mode === 'db'
      contextData = await gamesService.getGamesForSport(sportKey);
      if (!contextData?.length) throw new Error('No games found in the database for the specified sport.');
      fixtures = contextData;
    }

    const promptText = `You are an expert sports betting analyst. From the provided JSON data of upcoming games, construct a ${numLegs}-leg parlay. ${betTypeInstruction} For each leg, provide a detailed justification based ONLY on the data provided. Return ONLY a valid JSON object based on this schema: { "parlay_legs": [ { "game": "Away Team @ Home Team", "market": "...", "pick": "...", "justification": "..." } ], "confidence_score": 0.85 }\n\nHere is the game data:\n\`\`\`json\n${JSON.stringify(contextData.slice(0, 20), null, 2)}\n\`\`\``;

    const result = await model.generateContent(promptText);
    const text = result?.response?.text?.() ?? '';
    const obj = extractFirstJsonObject(text);
    if (!obj?.parlay_legs?.length) throw new Error('AI returned invalid or empty JSON.');
    obj.parlay_legs = bindLegsToFixtures(obj.parlay_legs, fixtures);
    return obj;
  }

  async validateOdds(oddsData) {
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: modelId, safetySettings, generationConfig: { responseMimeType: "application/json" } });
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
