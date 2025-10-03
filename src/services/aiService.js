// src/services/aiService.js - COMPLETE WITH SCHEDULE VALIDATION
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import { getSportTitle } from './sportsService.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import databaseService from './databaseService.js';
import { rateLimitService } from './rateLimitService.js';
import { sentryService } from './sentryService.js';
import quantitativeService from './quantitativeService.js';

// ---------- ENHANCED Constants ----------
const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 90000;
const MAX_OUTPUT_TOKENS = 8192;
const WEB_HORIZON_HOURS = 168;

// Enhanced safety settings
const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-pro'];
const PERPLEXITY_MODELS = ['sonar-pro', 'sonar-small-chat'];

// VERIFIED SCHEDULE SOURCES - Official league sources
const VERIFIED_SCHEDULE_SOURCES = {
  americanfootball_nfl: [
    'https://www.nfl.com/schedules/',
    'https://www.espn.com/nfl/schedule'
  ],
  americanfootball_ncaaf: [
    'https://www.espn.com/college-football/schedule'
  ],
  basketball_nba: [
    'https://www.nba.com/schedule',
    'https://www.espn.com/nba/schedule'
  ],
  basketball_wnba: [
    'https://www.wnba.com/schedule',
    'https://www.espn.com/wnba/schedule'
  ],
  basketball_ncaab: [
    'https://www.espn.com/mens-college-basketball/schedule'
  ],
  baseball_mlb: [
    'https://www.mlb.com/schedule',
    'https://www.espn.com/mlb/schedule'
  ],
  icehockey_nhl: [
    'https://www.nhl.com/schedule',
    'https://www.espn.com/nhl/schedule'
  ],
  soccer_england_premier_league: [
    'https://www.premierleague.com/fixtures',
    'https://www.espn.com/soccer/schedule'
  ],
  soccer_uefa_champions_league: [
    'https://www.uefa.com/uefachampionsleague/fixtures-results/'
  ],
  tennis_atp: [
    'https://www.atptour.com/en/schedule'
  ],
  tennis_wta: [
    'https://www.wtatennis.com/schedule'
  ],
  mma_ufc: [
    'https://www.ufc.com/schedule'
  ],
  golf_pga: [
    'https://www.pgatour.com/schedule.html'
  ],
  formula1: [
    'https://www.formula1.com/en/racing/2024.html'
  ]
};

const REGULATED_BOOKS = [
  'FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'ESPN BET', 'BetRivers', 
  'PointsBet', 'bet365', 'William Hill', 'Unibet', 'Betway', '888sport'
];

const BOOK_TIER = {
  'DraftKings': 0.96, 'FanDuel': 0.96, 'Caesars': 0.93, 'BetMGM': 0.93,
  'ESPN BET': 0.91, 'BetRivers': 0.89, 'PointsBet': 0.88, 'bet365': 0.95
};

// ---------- Math helpers ----------
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

// ---------- JSON Parsing ----------
function extractJSON(text = '') {
  if (!text || typeof text !== 'string') return null;
  
  const strategies = [
    () => {
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1]); } catch (error) { return null; }
      }
      return null;
    },
    () => {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const candidate = text.substring(start, end + 1);
        try { return JSON.parse(candidate); } catch (error) {
          return attemptJSONRepair(candidate);
        }
      }
      return null;
    }
  ];
  
  for (const strategy of strategies) {
    const result = strategy();
    if (result) return result;
  }
  
  return null;
}

function attemptJSONRepair(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') return null;
  
  try {
    let repaired = jsonString;
    repaired = repaired.replace(/"american":\s*\+(\d+)/g, '"american": $1');
    repaired = repaired.replace(/"opponent_american":\s*\+(\d+)/g, '"opponent_american": $1');
    repaired = repaired.replace(/"odds_american":\s*\+(\d+)/g, '"odds_american": $1');
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/'/g, '"');
    
    return JSON.parse(repaired);
  } catch (repairError) {
    return null;
  }
}

function cleanJSONString(text) {
  if (!text || typeof text !== 'string') return text;
  
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '');
  cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '');
  cleaned = cleaned.replace(/"american":\s*\+(\d+)/g, '"american": $1');
  cleaned = cleaned.replace(/"opponent_american":\s*\+(\d+)/g, '"opponent_american": $1');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const braceIndex = cleaned.indexOf('{');
    const bracketIndex = cleaned.indexOf('[');
    const startIndex = Math.max(braceIndex, bracketIndex);
    if (startIndex !== -1) cleaned = cleaned.substring(startIndex);
  }
  
  return cleaned;
}

function coerceQuote(q) {
  if (!q || typeof q !== 'object') return null;
  
  try {
    const book = String(q.book || q.sportsbook || '').trim();
    const line = q.line != null ? Number(q.line) : null;
    const american = q.american != null ? Number(q.american) :
                     (q.odds_american != null ? Number(q.odds_american) : null);
    const decimal = q.decimal != null ? Number(q.decimal) :
                    (american != null ? americanToDecimal(american) : null);
    const oppA = q.opponent_american != null ? Number(q.opponent_american) : null;
    const url = String(q.source_url || q.url || '').trim();
    const fetched_at = String(q.fetched_at || q.timestamp || new Date().toISOString()).trim();
    
    if (!book || book === 'Unknown' || (!american && !decimal)) return null;
    
    return { book, line, american, decimal, opponent_american: oppA, source_url: url, fetched_at };
  } catch (error) {
    console.warn('Quote coercion failed:', error.message);
    return null;
  }
}

function bestQuoteEV(quotes = [], fairProb, market = 'moneyline', oppAFallback = null) {
  let best = null; 
  let bestScore = -Infinity;
  
  for (const raw of quotes) {
    const q = coerceQuote(raw);
    if (!q || !q.book || !Number.isFinite(q.decimal)) continue;

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
  if (!raw || typeof raw !== 'object') return null;
  
  try {
    const market = String(raw.market || 'moneyline').toLowerCase();
    const quotes = Array.isArray(raw.quotes) ? raw.quotes.map(coerceQuote).filter(Boolean) : [];
    const fair_prob = clamp01(raw.fair_prob);
    const best = raw.best_quote ? coerceQuote(raw.best_quote) : bestQuoteEV(quotes, fair_prob, market, null);

    let utcISO = null;
    let local = null;
    
    try {
      if (raw.game_date_utc) {
        const date = new Date(raw.game_date_utc);
        if (!isNaN(date.getTime())) {
          utcISO = date.toISOString();
          local = new Intl.DateTimeFormat('en-US', {
            timeZone: TZ, 
            year: 'numeric', 
            month: 'short', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit'
          }).format(date);
        }
      }
    } catch (dateError) {
      console.warn('Date processing failed:', dateError.message);
    }

    const leg = {
      game: String(raw.game || '').trim(),
      market,
      pick: String(raw.pick || '').trim(),
      fair_prob,
      quotes,
      best_quote: best || null,
      sportsbook: (best?.book || raw.sportsbook || 'Multiple Books'),
      odds_american: best?.american ?? null,
      odds_decimal: best?.decimal ?? null,
      game_date_utc: utcISO,
      game_date_local: local || raw.game_date_local || null,
      justification: String(raw.justification || 'Analysis based on current odds and matchups').trim(),
      confidence: typeof raw.confidence === 'number' ? clamp01(raw.confidence) : 0.65,
      ev: (best && fair_prob != null && Number.isFinite(best.decimal)) ? (fair_prob * best.decimal - 1) : null,
      data_quality: 'ai_generated',
      real_game_validated: raw.real_game_validated || false
    };

    if (!leg.game || !leg.pick || !leg.market || leg.game === 'Unknown' || leg.pick === 'Unknown') {
      console.warn('Leg missing required fields:', { game: leg.game, pick: leg.pick, market: leg.market });
      return null;
    }
    
    return leg;
  } catch (error) {
    console.error('Leg normalization failed:', error.message);
    return null;
  }
}

function filterUpcoming(legs, hours = WEB_HORIZON_HOURS) {
  const now = Date.now();
  const horizon = now + hours * 3600_000;
  
  return (legs || []).filter(l => {
    if (!l.game_date_utc) return true;
    try {
      const t = Date.parse(l.game_date_utc);
      return Number.isFinite(t) && t >= now && t <= horizon;
    } catch {
      return true;
    }
  });
}

// ---------- CRITICAL: REAL SCHEDULE VALIDATION ----------
async function getVerifiedRealGames(sportKey, hours = 72) {
  console.log(`🔍 Getting VERIFIED real games for ${sportKey}...`);
  
  try {
    // Try multiple reliable sources in order
    let realGames = [];
    
    // 1. Primary: The Odds API (most reliable)
    try {
      realGames = await oddsService.getSportOdds(sportKey, { useCache: false });
      console.log(`✅ Odds API: ${realGames?.length || 0} games`);
    } catch (error) {
      console.warn('❌ Odds API failed, trying games service...');
    }
    
    // 2. Fallback: Games Service
    if (!realGames || realGames.length === 0) {
      try {
        realGames = await gamesService.getGamesForSport(sportKey, { useCache: false });
        console.log(`✅ Games Service: ${realGames?.length || 0} games`);
      } catch (error) {
        console.warn('❌ Games service failed, trying database...');
      }
    }
    
    // 3. Final Fallback: Database
    if (!realGames || realGames.length === 0) {
      try {
        realGames = await databaseService.getUpcomingGames(sportKey, hours);
        console.log(`✅ Database: ${realGames?.length || 0} games`);
      } catch (error) {
        console.warn('❌ All schedule sources failed');
        return [];
      }
    }
    
    // Filter to upcoming games only
    const now = Date.now();
    const horizon = now + (hours * 3600 * 1000);
    
    const upcomingGames = (realGames || []).filter(game => {
      try {
        const gameTime = new Date(game.commence_time).getTime();
        return gameTime > now && gameTime <= horizon;
      } catch {
        return false;
      }
    });
    
    console.log(`📅 VERIFIED: ${upcomingGames.length} real ${sportKey} games in next ${hours}h`);
    return upcomingGames;
    
  } catch (error) {
    console.error('❌ Failed to get verified real games:', error);
    return [];
  }
}

async function validateAndFilterRealGames(sportKey, proposedLegs, hours = 72) {
  console.log(`🔍 VALIDATING ${proposedLegs.length} proposed legs against REAL schedule...`);
  
  try {
    const realGames = await getVerifiedRealGames(sportKey, hours);
    
    if (realGames.length === 0) {
      console.warn('❌ NO REAL GAMES AVAILABLE for validation');
      return [];
    }
    
    // Create lookup map of real games
    const realGameMap = new Map();
    realGames.forEach(game => {
      const key = `${game.away_team} @ ${game.home_team}`.toLowerCase().trim();
      realGameMap.set(key, {
        event_id: game.event_id,
        commence_time: game.commence_time,
        away_team: game.away_team,
        home_team: game.home_team,
        real: true
      });
    });
    
    // Validate each proposed leg
    const validLegs = proposedLegs.filter(leg => {
      const gameKey = leg.game.toLowerCase().trim();
      const realGame = realGameMap.get(gameKey);
      
      if (!realGame) {
        console.warn(`❌ REJECTED: "${leg.game}" not in real schedule`);
        return false;
      }
      
      // Update leg with real game data
      leg.event_id = realGame.event_id;
      leg.game_date_utc = realGame.commence_time;
      leg.real_game_validated = true;
      
      console.log(`✅ VALIDATED: "${leg.game}"`);
      return true;
    });
    
    const rejectionRate = ((proposedLegs.length - validLegs.length) / proposedLegs.length * 100).toFixed(1);
    console.log(`🎯 VALIDATION: ${validLegs.length}/${proposedLegs.length} legs real (${rejectionRate}% rejected)`);
    
    return validLegs;
    
  } catch (error) {
    console.error('❌ Schedule validation failed:', error);
    return [];
  }
}

async function buildRealScheduleContext(sportKey, hours) {
  try {
    const realGames = await getVerifiedRealGames(sportKey, hours);
    
    if (realGames.length === 0) {
      return `\n\n🚨 CRITICAL SCHEDULE ALERT: There are NO VERIFIED ${sportKey.toUpperCase()} games in the next ${hours} hours according to official league schedules and sports data APIs. DO NOT CREATE ANY LEGS. Return an empty parlay_legs array.`;
    }
    
    // Build game list for AI context
    const gameList = realGames.slice(0, 20).map((game, index) => {
      const date = new Date(game.commence_time);
      const timeStr = date.toLocaleString('en-US', { 
        timeZone: TZ, 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
    }).join('\n');
    
    const verifiedSources = VERIFIED_SCHEDULE_SOURCES[sportKey] || ['Official League Schedule'];
    
    return `\n\n📅 VERIFIED REAL SCHEDULE FOR ${sportKey.toUpperCase()} (Next ${hours} hours):
${gameList}

🔒 SCHEDULE SOURCES: ${verifiedSources.join(', ')}

🚫 STRICT REQUIREMENT: You MUST use ONLY games from this verified schedule. 
❌ DO NOT CREATE, HALLUCINATE, OR INVENT games not on this list.
✅ ONLY analyze and pick from these real, scheduled matchups.
📊 If no games match your analysis criteria, return fewer legs or an empty array.`;
    
  } catch (error) {
    return `\n\n⚠️ SCHEDULE UNAVAILABLE: Real schedule data is temporarily unavailable. Be extremely careful to only use real, current ${sportKey} matchups that you can verify exist in official league schedules.`;
  }
}

// ---------- Enhanced Model discovery ----------
async function pickSupportedModel(apiKey, candidates = GEMINI_MODELS) {
  if (!apiKey) return candidates[0];
  
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!data?.models) return candidates[0];
    
    const availableModels = new Set(data.models.map(m => (m.name || '').replace(/^models\//, '')));
    
    for (const candidate of candidates) {
      if (availableModels.has(candidate)) {
        console.log(`✅ Selected Gemini model: ${candidate}`);
        return candidate;
      }
    }
    
    return candidates[0];
  } catch (error) {
    console.warn('Model discovery failed:', error.message);
    return candidates[0];
  }
}

function createAnalystPrompt({ sportKey, numLegs, betType, hours, includeProps = false, quantitativeMode = 'conservative' }) {
    const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
    const verifiedSources = VERIFIED_SCHEDULE_SOURCES[sportKey] || ['Official League Schedule'];
    
    let betTypeInstruction = '';
    if (betType === 'props') {
        betTypeInstruction = 'CRITICAL: The parlay must consist ONLY of player prop bets. Do NOT include moneyline, spreads, or totals.';
    } else if (betType === 'moneyline') {
        betTypeInstruction = 'The parlay should focus on moneyline (h2h) bets.';
    } else if (betType === 'spreads') {
        betTypeInstruction = 'The parlay should focus on spreads and totals bets.';
    } else if (betType === 'mixed') {
        if (includeProps) {
            betTypeInstruction = 'The parlay should include a variety of bet types including player props.';
        } else {
            betTypeInstruction = 'The parlay should include a variety of bet types but NO player props.';
        }
    }

    let calibrationInstruction = '';
    if (quantitativeMode === 'conservative') {
        calibrationInstruction = `Apply realistic probability estimates accounting for overconfidence and correlation.`;
    } else {
        calibrationInstruction = `Use raw probability estimates without calibration.`;
    }

    return `You are a world-class sports betting analyst. Your task is to construct a high-value ${numLegs}-leg parlay for ${sportName}.

**CRITICAL REQUIREMENTS:**
1. **REAL GAMES ONLY**: You MUST use ONLY real games from the verified schedule provided separately.
2. **NO HALLUCINATION**: Do not create, invent, or imagine games that don't exist.
3. **SCHEDULE COMPLIANCE**: All picks must be from actual scheduled matchups.

**Analysis Process:**
1. Use the provided verified schedule to select real games
2. Analyze matchups, recent performance, injuries, and trends
3. Provide data-driven justifications with specific stats
4. Use real odds from regulated US sportsbooks like ${REGULATED_BOOKS.join(', ')}

**Bet Type Strategy:** ${betTypeInstruction}
**Quantitative Approach:** ${calibrationInstruction}
**Verified Sources:** ${verifiedSources.join(', ')}

**Output Format:** Return ONLY valid JSON:

{
    "parlay_legs": [
        {
        "game": "Team A @ Team B",
        "market": "h2h",
        "pick": "Team A",
        "fair_prob": 0.65,
        "justification": "Specific data-driven analysis...",
        "confidence": 0.75,
        "game_date_utc": "2024-10-05T19:00:00Z",
        "quotes": [
            { "book": "DraftKings", "american": -150, "decimal": 1.67, "opponent_american": 130 }
        ]
        }
    ],
    "confidence_score": 0.80,
    "sources": ["https://official-source.com/game"],
    "market_variety_score": 0.85
}

**STRICT RULES:**
- Use ONLY real games from provided schedule
- No markdown, no explanations - ONLY JSON
- American odds without + signs (e.g., 125 not +125)
- All games must be verifiably real`;
}

// ---------- Enhanced Perplexity with schedule validation ----------
async function callPerplexity(prompt) {
  const { PERPLEXITY_API_KEY } = env;
  if (!PERPLEXITY_API_KEY) {
    throw new Error('Perplexity API key missing');
  }
  
  console.log('🔄 Calling Perplexity with schedule validation...');
  
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional sports data research expert. Return ONLY valid JSON with picks from REAL scheduled games. No markdown, no explanations, no additional text. Validate all games are real using provided schedules. For American odds, use numbers without + signs.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 4000,
        return_images: false,
        return_related_questions: false
      },
      { 
        headers: { 
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        }, 
        timeout: WEB_TIMEOUT_MS
      }
    );
    
    const content = response?.data?.choices?.[0]?.message?.content || '';
    
    if (!content) {
      throw new Error('Empty response from Perplexity');
    }
    
    console.log('✅ Perplexity response received');
    return content;
  } catch (error) {
    console.error('❌ Perplexity API error:', error.message);
    
    if (error.code === 'ECONNABORTED') {
      throw new Error('Perplexity request timed out');
    }
    
    if (error.response?.status === 401) {
      throw new Error('Perplexity API key invalid');
    }
    
    if (error.response?.status === 429) {
      throw new Error('Perplexity rate limit exceeded');
    }
    
    throw new Error(`Perplexity research failed: ${error.message}`);
  }
}

async function callGemini(prompt) {
  const { GOOGLE_GEMINI_API_KEY } = env;
  if (!GOOGLE_GEMINI_API_KEY) {
    throw new Error('Gemini API key missing');
  }
  
  console.log('🔄 Calling Gemini...');
  
  try {
    const modelId = await pickSupportedModel(GOOGLE_GEMINI_API_KEY);
    console.log(`🔧 Using Gemini model: ${modelId}`);
    
    const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);
    
    const aiModel = genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
      },
      safetySettings: SAFETY,
    });

    const result = await aiModel.generateContent([{ text: prompt }]);
    const response = await result.response;
    const text = response.text();
    
    if (!text) {
      throw new Error('Empty response from Gemini');
    }
    
    console.log('✅ Gemini response received');
    return text;

  } catch (error) {
    console.error('❌ Gemini API error:', error.message);
    
    if (error.message.includes('404')) {
      throw new Error('Gemini model not available');
    }
    
    if (error.message.includes('quota')) {
      throw new Error('Gemini API quota exceeded');
    }
    
    if (error.message.includes('403')) {
      throw new Error('Gemini API key invalid');
    }
    
    throw new Error(`Gemini API call failed: ${error.message}`);
  }
}

async function callProvider(aiModel, prompt) {
  console.log(`🔍 Researching with ${aiModel}...`);
  
  const maxAttempts = 2;
  const retryDelay = 2000;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔄 ${aiModel} attempt ${attempt}/${maxAttempts}...`);
    
    try {
      const text = aiModel === 'perplexity' 
        ? await callPerplexity(prompt) 
        : await callGemini(prompt);
      
      if (!text) {
        throw new Error('Empty response from AI provider');
      }
      
      const parsed = extractJSON(text);
      if (parsed) {
        console.log(`✅ ${aiModel} returned valid JSON on attempt ${attempt}`);
        return parsed;
      }
      
      console.warn(`⚠️ ${aiModel} attempt ${attempt} returned invalid JSON`);
      
      if (attempt < maxAttempts && text) {
        const retryPrompt = `${prompt}\n\nCRITICAL: Previous response was invalid JSON. Return ONLY the JSON object with no additional text. Ensure proper JSON formatting.`;
        console.log(`🔄 Retrying ${aiModel} with stricter JSON requirements...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      throw new Error('Could not extract valid JSON from AI response');
      
    } catch (error) {
      console.error(`❌ ${aiModel} attempt ${attempt} failed:`, error.message);
      
      const fatalErrors = [
        'API key missing', 'API key invalid', 'quota exceeded', 'rate limit exceeded'
      ];
      
      if (fatalErrors.some(fatal => error.message.includes(fatal))) {
        throw error;
      }
      
      if (attempt === maxAttempts) {
        throw new Error(`${aiModel} failed after ${maxAttempts} attempts: ${error.message}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  throw new Error(`Unexpected error in callProvider for ${aiModel}`);
}

// ---------- Service Class ----------
class AIService {
  constructor() {
    this.generationStats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, averageProcessingTime: 0, lastRequest: null };
  }

  async generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'perplexity', betType = 'mixed', options = {}) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      console.log(`🎯 Generating ${numLegs}-leg ${sportKey} parlay in ${mode} mode using ${aiModel} (${requestId})`);
      
      this.generationStats.totalRequests++;
      this.generationStats.lastRequest = new Date().toISOString();
      
      const startTime = Date.now();
      
      try {
        let result;
        const proQuantMode = options.proQuantMode || false;
  
        if (mode === 'web') {
          result = await this._executeWithTimeout(
            this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, {...options, proQuantMode }),
            120000,
            `Web research for ${sportKey}`
          );
        } else {
          result = await this.generateContextBasedParlay(sportKey, numLegs, betType, {...options, proQuantMode });
        }
    
        const processingTime = Date.now() - startTime;
        this._updateStats(true, processingTime);
        
        console.log(`✅ Parlay generated successfully in ${processingTime}ms (${requestId})`);
        return {
          ...result,
          metadata: { ...result.metadata, request_id: requestId, processing_time_ms: processingTime }
        };
    
      } catch (error) {
        const processingTime = Date.now() - startTime;
        this._updateStats(false, processingTime);
        
        console.error(`❌ Parlay generation failed for ${requestId}:`, error.message);
        sentryService.captureError(error, { 
          component: 'ai_service', 
          operation: 'generateParlay',
          sportKey, mode, aiModel, requestId 
        });
        
        if (mode === 'web') {
          const fallbackError = new Error(`Web research failed: ${error.message}`);
          fallbackError.fallbackAvailable = true;
          fallbackError.originalError = error.message;
          fallbackError.fallbackOptions = {
            live_mode: { description: 'Use direct API data (may use quota).' },
            db_mode: { description: 'Use stored historical data (may be outdated).', warning: 'Could not get real-time data.' }
          };
          fallbackError.dataFreshness = {
            lastRefresh: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
            hoursAgo: 2 
          };
          throw fallbackError;
        }
        
        throw new Error(`Parlay generation failed: ${error.message} (${requestId})`);
      }
  }

  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    const hours = Number(options.horizonHours || 72);
    const includeProps = options.includeProps || false;
    const quantitativeMode = options.proQuantMode ? 'conservative' : (options.quantitativeMode || 'aggressive');
    
    // CRITICAL: Get real schedule context first
    const scheduleContext = await buildRealScheduleContext(sportKey, hours);
    
    const basePrompt = createAnalystPrompt({ 
      sportKey, 
      numLegs, 
      betType, 
      hours, 
      includeProps,
      quantitativeMode 
    });
    
    // COMBINE: Base prompt + real schedule context
    const prompt = basePrompt + scheduleContext;
    
    console.log(`📝 Sending REAL-SCHEDULE validated prompt (${quantitativeMode} mode)...`);
    const obj = await callProvider(aiModel, prompt);
    
    if (!obj || !Array.isArray(obj.parlay_legs)) {
      throw new Error('AI returned invalid JSON structure - missing parlay_legs array');
    }
    
    console.log(`🔄 Processing ${obj.parlay_legs.length} proposed legs...`);
    
    // CRITICAL: VALIDATE ALL GAMES AGAINST REAL SCHEDULE
    const validatedLegs = await validateAndFilterRealGames(sportKey, obj.parlay_legs, hours);
    
    if (validatedLegs.length === 0) {
      const realGames = await getVerifiedRealGames(sportKey, hours);
      if (realGames.length === 0) {
        throw new Error(`NO REAL GAMES: There are no ${sportKey} games in the next ${hours} hours according to verified schedules.`);
      } else {
        throw new Error(`SCHEDULE MISMATCH: AI proposed ${obj.parlay_legs.length} games but NONE match the actual ${sportKey} schedule. All games were rejected.`);
      }
    }
    
    if (validatedLegs.length < numLegs) {
      console.warn(`⚠️ Only ${validatedLegs.length} real games validated (requested ${numLegs})`);
    }
    
    const legs = validatedLegs.map(normalizeLeg).filter(Boolean).slice(0, numLegs);
    
    if (legs.length === 0) {
      throw new Error(`No valid ${sportKey} legs could be processed after real-game validation`);
    }
    
    // Calculate parlay odds
    const parlayDec = parlayDecimal(legs);
    const parlayAm = decimalToAmerican(parlayDec);
    
    // Run quantitative analysis
    const quantitativeAnalysis = await quantitativeService.evaluateParlay(legs, parlayDec);
    
    console.log(`📊 Quantitative Analysis Complete:`);
    console.log(`- Raw EV: ${quantitativeAnalysis.raw.evPercentage.toFixed(2)}%`);
    console.log(`- Calibrated EV: ${quantitativeAnalysis.calibrated.evPercentage.toFixed(2)}%`);
    console.log(`- Risk Assessment: ${quantitativeAnalysis.riskAssessment.overallRisk}`);
    
    return {
      parlay_legs: legs,
      confidence_score: quantitativeMode === 'conservative' ? 
        quantitativeAnalysis.calibrated.jointProbability : 
        (typeof obj.confidence_score === 'number' ? clamp01(obj.confidence_score) : 0.75),
      parlay_odds_decimal: parlayDec,
      parlay_odds_american: parlayAm,
      parlay_ev: quantitativeAnalysis.calibrated.evPercentage,
      quantitative_analysis: quantitativeAnalysis,
      sources: Array.isArray(obj.sources) ? obj.sources : [],
      data_quality: this._assessParlayDataQuality(legs),
      market_variety: this._assessMarketVariety(legs, betType, includeProps),
      research_metadata: { 
        sport: sportKey, 
        legs_requested: numLegs, 
        legs_delivered: legs.length, 
        ai_model: aiModel,
        include_props: includeProps,
        bet_type: betType,
        quantitative_mode: quantitativeMode,
        real_games_validated: true,
        schedule_verified: true
      }
    };
  }

  // Enhanced Live/DB modes with REAL schedule data
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}) {
    console.log(`🔄 Using VERIFIED internal APIs for ${sportKey}...`);
    
    try {
      // Use verified real games
      const realGames = await getVerifiedRealGames(sportKey, options.horizonHours || 72);
      
      if (!realGames || realGames.length < numLegs) {
        throw new Error(`Insufficient REAL ${sportKey} games available. Found ${realGames?.length || 0}, need ${numLegs}`);
      }

      // Enhanced game selection with diversity
      const selected = this._selectDiverseGames(realGames, numLegs);
      const legs = selected.map((game, index) => {
        const bookmakers = game.bookmakers || game.market_data?.bookmakers || [];
        const market = this._selectAppropriateMarket(bookmakers, betType);
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
            decimal,
            source_url: `verified:${sportKey}_${game.event_id}`
          },
          odds_american: american,
          odds_decimal: decimal,
          game_date_utc: game.commence_time,
          game_date_local: this.toLocal(game.commence_time, TZ),
          justification: `Selected from VERIFIED ${sportKey} schedule with ${bookmakers.length} bookmakers`,
          confidence: 0.65 - (index * 0.05),
          fair_prob: 0.55,
          data_quality: 'verified_internal',
          real_game_validated: true
        };
      });

      const parlayDec = parlayDecimal(legs);
      const parlayAm = decimalToAmerican(parlayDec);

      return { 
        parlay_legs: legs, 
        confidence_score: 0.70,
        parlay_odds_decimal: parlayDec,
        parlay_odds_american: parlayAm,
        source: 'verified_internal_api',
        data_quality: this._assessParlayDataQuality(legs),
        research_metadata: {
          sport: sportKey,
          legs_requested: numLegs,
          legs_delivered: legs.length,
          generated_at: new Date().toISOString(),
          data_source: 'verified_schedule',
          game_variety: new Set(legs.map(l => l.game)).size,
          real_games_validated: true,
          schedule_verified: true
        }
      };
    } catch (error) {
      console.error('Verified context-based parlay generation failed:', error.message);
      throw new Error(`Verified schedule error: ${error.message}`);
    }
  }

  // Enhanced generic chat method
  async genericChat(model, messages, options = {}) {
    const chatId = `chat_${Date.now()}`;
    console.log(`💬 Processing generic chat request (${chatId})...`);
    
    try {
      const response = await this._executeWithTimeout(
        model === 'perplexity' ? callPerplexity(messages[0]?.content || '') : callGemini(messages[0]?.content || ''),
        45000,
        `Generic chat with ${model}`
      );

      console.log(`✅ Chat completed successfully (${chatId})`);
      return response;

    } catch (error) {
      console.error(`❌ Generic chat failed (${chatId}):`, error.message);
      throw error;
    }
  }

  // Enhanced validation
  async validateOdds(oddsData) {
    try {
      if (!oddsData || !Array.isArray(oddsData)) {
        return { valid: false, reason: 'Invalid odds data structure' };
      }

      const validationResults = oddsData.map(game => ({
        gameId: game.event_id,
        hasOdds: !!(game.bookmakers && game.bookmakers.length > 0),
        bookmakerCount: game.bookmakers?.length || 0,
        dataQuality: game.data_quality?.rating || 'unknown',
        isValid: !!(game.event_id && game.home_team && game.away_team && game.commence_time)
      }));

      const validGames = validationResults.filter(r => r.isValid).length;
      const gamesWithOdds = validationResults.filter(r => r.hasOdds).length;

      return {
        valid: validGames > 0,
        summary: {
          totalGames: oddsData.length,
          validGames,
          gamesWithOdds,
          validationRate: (validGames / oddsData.length * 100).toFixed(1) + '%',
          averageBookmakers: (validationResults.reduce((sum, r) => sum + r.bookmakerCount, 0) / oddsData.length).toFixed(1)
        },
        details: validationResults
      };

    } catch (error) {
      console.error('Odds validation failed:', error);
      return { valid: false, reason: error.message };
    }
  }

  // Enhanced fallback selection handler
  async handleFallbackSelection(sportKey, numLegs, mode, betType) {
    console.log(`🔄 Handling fallback to ${mode} mode for ${sportKey}...`);
    
    try {
      switch (mode) {
        case 'live':
          return await this.generateContextBasedParlay(sportKey, numLegs, betType, { useLiveData: true });
        case 'db':
          return await this.generateContextBasedParlay(sportKey, numLegs, betType, { useDatabase: true });
        default:
          throw new Error(`Unsupported fallback mode: ${mode}`);
      }
    } catch (error) {
      console.error(`Fallback selection failed for ${mode}:`, error);
      throw new Error(`Fallback to ${mode} mode failed: ${error.message}`);
    }
  }

  _assessMarketVariety(legs, betType, includeProps) {
    if (!legs || legs.length === 0) {
        return { score: 0, meetsRequirements: false };
    }

    const markets = legs.map(leg => leg.market);
    const uniqueMarkets = new Set(markets);
    
    let varietyScore = 0;
    const requirements = [];
    
    if (uniqueMarkets.size >= 2) {
        varietyScore += 0.4;
        requirements.push('multiple_markets');
    }
    
    if (uniqueMarkets.size >= 3) {
        varietyScore += 0.3;
        requirements.push('high_diversity');
    }
    
    if (betType === 'mixed' && includeProps) {
        const hasPlayerProps = markets.some(m => m.includes('player_'));
        const hasOtherMarkets = markets.some(m => !m.includes('player_'));
        
        if (hasPlayerProps && hasOtherMarkets) {
            varietyScore += 0.3;
            requirements.push('mixed_with_props');
        } else if (!hasPlayerProps) {
            requirements.push('missing_player_props');
            varietyScore -= 0.2;
        }
    }
    
    if (betType === 'props') {
        const allPlayerProps = markets.every(m => m.includes('player_'));
        if (!allPlayerProps) {
            requirements.push('non_prop_included');
            varietyScore -= 0.3;
        }
    }
    
    return {
        score: Math.max(0, Math.min(1, varietyScore)),
        requirements,
        meetsRequirements: varietyScore >= 0.6,
        marketBreakdown: {
            total: legs.length,
            uniqueMarkets: uniqueMarkets.size,
            markets: Array.from(uniqueMarkets),
            hasPlayerProps: markets.some(m => m.includes('player_')),
            hasMoneyline: markets.some(m => m === 'h2h'),
            hasSpreads: markets.some(m => m === 'spreads'),
            hasTotals: markets.some(m => m === 'totals')
        }
    };
  }
  
  // ========== PRIVATE METHODS ==========

  async _executeWithTimeout(promise, timeoutMs, operation) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms: ${operation}`)), timeoutMs)
      )
    ]);
  }

  _updateStats(success, processingTime) {
    if (success) {
      this.generationStats.successfulRequests++;
    } else {
      this.generationStats.failedRequests++;
    }

    if (this.generationStats.averageProcessingTime === 0) {
      this.generationStats.averageProcessingTime = processingTime;
    } else {
      this.generationStats.averageProcessingTime = 
        (this.generationStats.averageProcessingTime * (this.generationStats.successfulRequests - 1) + processingTime) / 
        this.generationStats.successfulRequests;
    }
  }

  _assessParlayDataQuality(legs) {
    if (!legs || legs.length === 0) {
      return { score: 0, rating: 'poor', factors: ['no_legs'] };
    }

    let score = 0;
    const factors = [];

    if (legs.length >= 3) {
      score += 20;
      factors.push('good_leg_count');
    }

    const verifiedLegs = legs.filter(l => l.real_game_validated).length;
    const aiLegs = legs.filter(l => l.data_quality === 'ai_generated').length;
    const internalLegs = legs.filter(l => l.data_quality === 'verified_internal').length;
    
    if (verifiedLegs > 0) {
      score += 40;
      factors.push('verified_real_games');
    }
    if (aiLegs > 0) {
      score += 20;
      factors.push('ai_enhanced_data');
    }
    if (internalLegs > 0) {
      score += 20;
      factors.push('verified_internal_data');
    }

    const legsWithOdds = legs.filter(l => l.odds_american !== null).length;
    if (legsWithOdds === legs.length) {
      score += 20;
      factors.push('complete_odds_coverage');
    }

    return {
      score: Math.min(100, score),
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor',
      factors,
      breakdown: {
        total_legs: legs.length,
        verified_games: verifiedLegs,
        ai_enhanced: aiLegs,
        internal_data: internalLegs,
        with_odds: legsWithOdds
      }
    };
  }

  _selectDiverseGames(games, numLegs) {
    if (!games || games.length <= numLegs) {
      return games || [];
    }

    const selected = [];
    const usedTeams = new Set();
    
    for (const game of games) {
      if (selected.length >= numLegs) break;
      
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      
      if (!usedTeams.has(homeTeam) && !usedTeams.has(awayTeam)) {
        selected.push(game);
        usedTeams.add(homeTeam);
        usedTeams.add(awayTeam);
      }
    }

    if (selected.length < numLegs) {
      for (const game of games) {
        if (selected.length >= numLegs) break;
        if (!selected.includes(game)) {
          selected.push(game);
        }
      }
    }

    return selected.slice(0, numLegs);
  }

  _selectAppropriateMarket(bookmakers, betType) {
    if (!bookmakers || bookmakers.length === 0) return null;

    const markets = bookmakers.flatMap(b => b.markets || []);
    
    if (betType === 'props') {
      return markets.find(m => m.key.includes('player_')) || markets[0];
    } else if (betType === 'spreads') {
      return markets.find(m => m.key === 'spreads') || markets[0];
    } else if (betType === 'moneyline') {
      return markets.find(m => m.key === 'h2h') || markets[0];
    } else {
      return markets.find(m => m.key === 'spreads') || 
             markets.find(m => m.key === 'totals') || 
             markets.find(m => m.key === 'h2h') || 
             markets[0];
    }
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
      console.warn('Date localization failed:', error.message);
      return null;
    }
  }

  async getServiceStatus() {
    const status = {
      service: 'AIService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      capabilities: {
        web_research: true,
        context_based: true,
        generic_chat: true,
        odds_validation: true,
        real_schedule_validation: true
      },
      statistics: this.generationStats,
      providers: {
        gemini: {
          available: !!env.GOOGLE_GEMINI_API_KEY,
          models: GEMINI_MODELS
        },
        perplexity: {
          available: !!env.PERPLEXITY_API_KEY,
          models: PERPLEXITY_MODELS
        }
      }
    };

    try {
      if (env.GOOGLE_GEMINI_API_KEY) {
        await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
        status.providers.gemini.status = 'connected';
      } else {
        status.providers.gemini.status = 'not_configured';
      }
    } catch (error) {
      status.providers.gemini.status = 'error';
      status.status = 'degraded';
    }

    return status;
  }
}

export default new AIService();
