// src/services/aiService.js
// Enhanced Web Research mode: Independent game discovery + cross-shopping
// Live/DB modes use internal services, Web mode is completely self-sufficient

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';

// Internal services for Live/DB modes only
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

// ---------- Enhanced Constants ----------
const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 60000;
const MAX_OUTPUT_TOKENS = 8192;
const WEB_HORIZON_HOURS = 168; // Extended to 7 days for better international coverage

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,         threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,  threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,  threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-pro-latest'];

// Global coverage - expanded book list
const REGULATED_BOOKS = [
  'FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'ESPN BET', 'BetRivers', 
  'PointsBet', 'bet365', 'William Hill', 'Unibet', 'Betway', '888sport'
];

// International sports coverage
const SPORT_SOURCES = {
  nfl: ['https://www.nfl.com/schedules/', 'https://www.espn.com/nfl/schedule', 'https://www.cbssports.com/nfl/schedule/'],
  nba: ['https://www.nba.com/schedule', 'https://www.espn.com/nba/schedule', 'https://www.cbssports.com/nba/schedule/'],
  mlb: ['https://www.mlb.com/schedule', 'https://www.espn.com/mlb/schedule', 'https://www.cbssports.com/mlb/schedule/'],
  nhl: ['https://www.nhl.com/schedule', 'https://www.espn.com/nhl/schedule', 'https://www.cbssports.com/nhl/schedule/'],
  soccer: ['https://www.espn.com/soccer/schedule', 'https://www.premierleague.com/fixtures', 'https://www.uefa.com/'],
  tennis: ['https://www.atptour.com/en/schedule', 'https://www.wtatennis.com/schedule', 'https://www.espn.com/tennis/schedule'],
  ufc: ['https://www.ufc.com/schedule', 'https://www.espn.com/mma/schedule'],
  f1: ['https://www.formula1.com/en/racing/2024.html'],
  golf: ['https://www.pgatour.com/schedule', 'https://www.espn.com/golf/schedule'],
  ncaaf: ['https://www.espn.com/college-football/schedule', 'https://www.cbssports.com/college-football/schedule/'],
  ncaab: ['https://www.espn.com/mens-college-basketball/schedule', 'https://www.cbssports.com/college-basketball/schedule/']
};

const BOOK_TIER = {
  'Circa': 1.00,
  'DraftKings': 0.96,
  'FanDuel': 0.96,
  'Caesars': 0.93,
  'BetMGM': 0.93,
  'ESPN BET': 0.91,
  'BetRivers': 0.89,
  'PointsBet': 0.88,
  'bet365': 0.95,
  'William Hill': 0.90
};

// ---------- Math helpers (unchanged) ----------
function americanToDecimal(a) {
  const x = Number(a);
  if (!Number.isFinite(x)) return null;
  if (x > 0) return 1 + x / 100;
  if (x < 0) return 1 + 100 / Math.abs(x);
  return null;
}

function decimalToAmerican(d) {
  const x = Number(d);
  if (!Number.isFinite(x) || x <= 1) return null;
  return x >= 2 ? Math.round((x - 1) * 100) : Math.round(-100 / (x - 1));
}

function americanToImpliedProb(a) {
  const x = Number(a);
  if (!Number.isFinite(x)) return null;
  return x > 0 ? 100 / (x + 100) : Math.abs(x) / (Math.abs(x) + 100);
}

function noVigProb(myA, oppA) {
  const p = americanToImpliedProb(myA);
  const q = americanToImpliedProb(oppA);
  if (p == null || q == null) return null;
  return p / (p + q);
}

function clamp01(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

function parlayDecimal(legs) {
  return (legs || []).reduce((acc, l) => acc * (Number(l.best_quote?.decimal) || 1), 1);
}

// ---------- Enhanced Parsing/validation ----------
function extractJSON(text = '') {
  // More robust JSON extraction
  const fenceRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i;
  const fenceMatch = text.match(fenceRegex);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch?.[1]) {
    try { return JSON.parse(braceMatch[1]); } catch {}
  }
  
  try { return JSON.parse(text); } catch { return null; }
}

function coerceQuote(q) {
  const book = String(q.book || q.sportsbook || '').trim();
  const line = q.line != null ? Number(q.line) : null;
  const american = q.american != null ? Number(q.american) :
                   (q.odds_american != null ? Number(q.odds_american) : null);
  const decimal = q.decimal != null ? Number(q.decimal) :
                  (american != null ? americanToDecimal(american) : null);
  const oppA = q.opponent_american != null ? Number(q.opponent_american) : null;
  const url = String(q.source_url || q.url || '').trim();
  const fetched_at = String(q.fetched_at || q.timestamp || new Date().toISOString()).trim();
  return { book, line, american, decimal, opponent_american: oppA, source_url: url, fetched_at };
}

function bestQuoteEV(quotes = [], fairProb, market = 'moneyline', oppAFallback = null) {
  let best = null; 
  let bestScore = -Infinity;
  
  for (const raw of quotes) {
    const q = coerceQuote(raw);
    if (!q.book || !Number.isFinite(q.decimal)) continue;

    const tier = BOOK_TIER[q.book] ?? 0.85;
    const oppA = q.opponent_american != null ? q.opponent_american : oppAFallback;
    const pNoVig = (oppA != null && q.american != null) ? noVigProb(q.american, oppA) : null;
    const pFair = Number.isFinite(fairProb) ? fairProb : (pNoVig != null ? pNoVig : null);
    const ev = pFair != null ? (pFair * q.decimal - 1) : (q.decimal - 1) * 0.98;

    let lineBonus = 0;
    if ((market === 'spread' || market === 'total') && q.line != null) {
      lineBonus = 0.0005 * Math.abs(q.line);
    }

    const score = ev + lineBonus + 0.002 * tier;
    if (score > bestScore) { 
      bestScore = score; 
      best = { ...q, p_novig: pNoVig, ev }; 
    }
  }
  return best;
}

function normalizeLeg(raw) {
  const market = String(raw.market || 'moneyline').toLowerCase();
  const quotes = Array.isArray(raw.quotes) ? raw.quotes.map(coerceQuote) : [];
  const fair_prob = clamp01(raw.fair_prob);
  const best = raw.best_quote ? coerceQuote(raw.best_quote) : bestQuoteEV(quotes, fair_prob, market, null);

  // Enhanced date normalization with timezone awareness
  let utcISO = null;
  if (raw.game_date_utc) {
    utcISO = new Date(raw.game_date_utc).toISOString();
  } else if (raw.game_date_local) {
    // Try to parse local date string to UTC
    const localDate = new Date(raw.game_date_local);
    if (!isNaN(localDate.getTime())) {
      utcISO = localDate.toISOString();
    }
  }

  const local = raw.game_date_local || (utcISO ? new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, 
    year: 'numeric', 
    month: 'short', 
    day: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(utcISO)) : null);

  return {
    game: String(raw.game || '').trim(),
    market,
    pick: String(raw.pick || '').trim(),
    fair_prob,
    quotes,
    best_quote: best || null,
    sportsbook: (best?.book || raw.sportsbook || 'Multiple Books'),
    odds_american: best?.american ?? null,
    odds_decimal: best?.decimal ?? (best?.american != null ? americanToDecimal(best.american) : null),
    game_date_utc: utcISO,
    game_date_local: local,
    justification: String(raw.justification || '').trim(),
    confidence: typeof raw.confidence === 'number' ? clamp01(raw.confidence) : null,
    ev: (best && fair_prob != null && Number.isFinite(best.decimal)) ? (fair_prob * best.decimal - 1) : null,
    injury_impact: raw.injury_impact || null,
    key_players: raw.key_players || null
  };
}

function filterUpcoming(legs, hours = WEB_HORIZON_HOURS) {
  const now = Date.now();
  const horizon = now + hours * 3600_000;
  return (legs || []).filter(l => {
    if (!l.game_date_utc) return true;
    const t = Date.parse(l.game_date_utc);
    return Number.isFinite(t) && t >= now && t <= horizon;
  });
}

// ---------- Enhanced Model selection ----------
async function pickSupportedModel(apiKey, candidates = GEMINI_MODELS) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const names = new Set((data?.models || []).map(m => (m.name || '').replace(/^models\//, '')));
    for (const id of candidates) if (names.has(id)) return id;
  } catch {}
  return candidates[0];
}

// ---------- Enhanced Prompt for Independent Game Discovery ----------
function enhancedAnalystPrompt({ sportKey, numLegs, betType, hours, tz }) {
  const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
  const sources = SPORT_SOURCES[sportKey] || SPORT_SOURCES.soccer;
  
  const betRule = betType === 'props' 
    ? 'Focus on player props (points, yards, assists, goals) with clear statistical edges.'
    : 'Mix moneyline, spreads, and totals based on strongest value opportunities.';

  return `You are the lead analyst at a premier international sports betting firm. Build a ${numLegs}-leg parlay for ${sportName} games within the next ${hours} hours.

CRITICAL MISSION:
1. FIRST, discover ALL upcoming ${sportName} games by researching official sources:
   ${sources.map(src => `   - ${src}`).join('\n')}

2. For each potential game, gather REAL-TIME information:
   - Exact game time (convert to ${tz} timezone)
   - Team lineups and recent form
   - CONFIRMED injury reports affecting key players
   - Weather conditions (if outdoor sport)
   - Venue factors

3. CROSS-SHOP odds across these books (check ALL):
   ${REGULATED_BOOKS.join(', ')}

4. For each selection, analyze:
   - True probability vs. implied probability
   - Injury impact on team performance
   - Historical matchup data
   - Recent team trends

REQUIRED OUTPUT STRUCTURE:
{
  "parlay_legs": [
    {
      "game": "Exact Team Names @ Exact Team Names",
      "market": "moneyline|spread|total|prop",
      "pick": "Specific selection with details",
      "fair_prob": 0.65,
      "quotes": [
        {
          "book": "Sportsbook Name",
          "american": -150,
          "decimal": 1.67,
          "opponent_american": +130,
          "line": -3.5,
          "source_url": "https://direct.odds.page",
          "fetched_at": "${new Date().toISOString()}"
        }
      ],
      "best_quote": { ... },
      "justification": "Data-driven analysis citing specific sources for injuries, trends, and odds",
      "confidence": 0.75,
      "game_date_utc": "2025-01-15T20:30:00Z",
      "injury_impact": "Key player X is OUT, reducing offensive efficiency by 15%",
      "key_players": ["Player A", "Player B"]
    }
  ],
  "confidence_score": 0.82,
  "sources": [
    "https://official.schedule.source",
    "https://injury.report.source", 
    "https://odds.comparison.source"
  ]
}

MANDATORY CHECKS:
- Verify EVERY game exists on official league schedules
- Include opponent American odds for no-vig calculations
- Document injury impacts with specific performance estimates
- Provide direct URLs to odds pages and news sources
- ${betRule}
- Focus on games with clear analytical edges

OUTPUT: STRICT JSON ONLY, no commentary.`;
}

// ---------- Provider calls with enhanced error handling ----------
async function callPerplexity(prompt) {
  const { PERPLEXITY_API_KEY } = env;
  if (!PERPLEXITY_API_KEY) throw new Error('Perplexity API key missing.');
  
  try {
    const resp = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { 
            role: 'system', 
            content: 'You are a sports data research expert. Return ONLY valid JSON with current game schedules, odds, and injury information. No markdown, no explanations.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1, // Lower temperature for more consistent data
        max_tokens: 4000
      },
      { 
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}` }, 
        timeout: WEB_TIMEOUT_MS 
      }
    );
    return resp?.data?.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity API error:', error.message);
    throw new Error(`Perplexity research failed: ${error.message}`);
  }
}

async function callGemini(prompt) {
  try {
    const modelId = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
    const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: modelId,
      safetySettings: SAFETY,
      generationConfig: { 
        maxOutputTokens: MAX_OUTPUT_TOKENS, 
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });
    
    const result = await model.generateContent(prompt);
    return result?.response?.text?.() ?? '';
  } catch (error) {
    console.error('Gemini API error:', error.message);
    throw new Error(`Gemini research failed: ${error.message}`);
  }
}

async function callProvider(aiModel, prompt) {
  console.log(`🔍 Researching ${aiModel} for game schedules and odds...`);
  
  const text1 = aiModel === 'perplexity' 
    ? await callPerplexity(prompt) 
    : await callGemini(prompt);
    
  const parsed1 = extractJSON(text1);
  if (parsed1) return parsed1;

  // Fallback: More directive retry
  const retryPrompt = `${prompt}\n\nCRITICAL: Return ONLY the JSON object. No markdown, no code fences, no additional text.`;
  const text2 = aiModel === 'perplexity'
    ? await callPerplexity(retryPrompt)
    : await callGemini(retryPrompt);
    
  const parsed2 = extractJSON(text2);
  if (parsed2) return parsed2;

  throw new Error('AI returned non-parseable JSON after two attempts');
}

// ---------- Enhanced Service Class ----------
class AIService {
  async generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'gemini', betType = 'mixed', options = {}) {
    console.log(`🎯 Generating ${numLegs}-leg ${sportKey} parlay in ${mode} mode`);
    
    if (mode === 'web') {
      return this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options);
    }
    return this.generateContextBasedParlay(sportKey, numLegs, betType, options);
  }

  // ENHANCED Web Research: Completely independent game discovery + cross-shopping
  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    const hours = Number(options.horizonHours || WEB_HORIZON_HOURS);
    const prompt = enhancedAnalystPrompt({ sportKey, numLegs, betType, hours, tz: TZ });

    const obj = await callProvider(aiModel, prompt);
    if (!obj || !Array.isArray(obj.parlay_legs)) {
      throw new Error('AI returned invalid JSON structure - missing parlay_legs array');
    }

    // Enhanced normalization with injury data
    let legs = obj.parlay_legs.map(leg => {
      const normalized = normalizeLeg(leg);
      // Preserve additional research data
      if (leg.injury_impact) normalized.injury_impact = leg.injury_impact;
      if (leg.key_players) normalized.key_players = leg.key_players;
      return normalized;
    });

    // Filter to upcoming games within horizon
    legs = filterUpcoming(legs, hours);

    if (legs.length === 0) {
      throw new Error(`No valid upcoming ${sportKey} games found within ${hours} hours`);
    }

    // Select best legs and compute parlay
    legs = legs.slice(0, numLegs);
    const parlayDec = parlayDecimal(legs);
    const parlayAm = decimalToAmerican(parlayDec);

    // Calculate joint probability and EV
    const jointFair = (() => {
      const arr = legs.map(l => l.fair_prob).filter(v => v != null);
      return arr.length ? arr.reduce((p, v) => p * v, 1) : null;
    })();
    
    const parlayEV = jointFair != null ? (jointFair * parlayDec - 1) : null;

    return {
      parlay_legs: legs,
      confidence_score: typeof obj.confidence_score === 'number' ? clamp01(obj.confidence_score) : 0.80,
      parlay_odds_decimal: parlayDec,
      parlay_odds_american: parlayAm,
      parlay_ev: parlayEV,
      sources: Array.isArray(obj.sources) ? obj.sources : [],
      research_metadata: {
        sport: sportKey,
        horizon_hours: hours,
        generated_at: new Date().toISOString(),
        total_games_researched: obj.parlay_legs.length
      }
    };
  }

  // Live/DB modes - unchanged, uses your existing services
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}) {
    let games = await oddsService.getSportOdds(sportKey);
    if (!games || games.length === 0) {
      games = await gamesService.getGamesForSport(sportKey);
    }
    
    if (!games || games.length < numLegs) {
      throw new Error(`Not enough ${sportKey} games available. Found ${games?.length || 0}, need ${numLegs}`);
    }

    const selected = games.slice(0, numLegs);
    const legs = selected.map(game => {
      const bookmakers = game.bookmakers || game.market_data?.bookmakers || [];
      const market = bookmakers[0]?.markets?.[0];
      const outcome = market?.outcomes?.[0];
      const american = outcome?.price ?? -110;
      const decimal = americanToDecimal(american);

      return {
        game: `${game.away_team} @ ${game.home_team}`,
        pick: outcome?.name || game.away_team,
        market: market?.key || 'moneyline',
        best_quote: {
          book: bookmakers[0]?.title || 'DraftKings',
          american, 
          decimal
        },
        odds_american: american,
        odds_decimal: decimal,
        game_date_utc: game.commence_time,
        game_date_local: this.toLocal(game.commence_time, TZ),
        justification: 'Selected from internal sports data API',
        confidence: 0.65
      };
    });

    return { 
      parlay_legs: legs, 
      confidence_score: 0.70,
      source: 'internal_api' 
    };
  }

  toLocal(utcDateString, timezone) {
    if (!utcDateString) return null;
    try {
      const date = new Date(utcDateString);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch (error) {
      return null;
    }
  }
}

export default new AIService();
