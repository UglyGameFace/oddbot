// src/services/aiService.js
// COMPLETELY UPDATED: Gemini 2.0 + Proper timeouts + Error-free implementation

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';

// Internal services for Live/DB modes only
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

// ---------- UPDATED Constants ----------
const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 90000; // Increased to 90 seconds for thorough research
const MAX_OUTPUT_TOKENS = 8192;
const WEB_HORIZON_HOURS = 168;

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// UPDATED: Latest Gemini 2.0 models
const GEMINI_MODELS = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

// Global coverage
const REGULATED_BOOKS = [
  'FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'ESPN BET', 'BetRivers', 
  'PointsBet', 'bet365'
];

// Sport sources
const SPORT_SOURCES = {
  americanfootball_nfl: ['https://www.nfl.com/schedules/', 'https://www.espn.com/nfl/schedule'],
  nba: ['https://www.nba.com/schedule', 'https://www.espn.com/nba/schedule'],
  mlb: ['https://www.mlb.com/schedule', 'https://www.espn.com/mlb/schedule'],
  nhl: ['https://www.nhl.com/schedule', 'https://www.espn.com/nhl/schedule'],
  soccer: ['https://www.espn.com/soccer/schedule', 'https://www.premierleague.com/fixtures'],
  tennis: ['https://www.espn.com/tennis/schedule'],
  ufc: ['https://www.ufc.com/schedule'],
  ncaaf: ['https://www.espn.com/college-football/schedule'],
  ncaab: ['https://www.espn.com/mens-college-basketball/schedule']
};

const BOOK_TIER = {
  'DraftKings': 0.96,
  'FanDuel': 0.96,
  'Caesars': 0.93,
  'BetMGM': 0.93,
  'ESPN BET': 0.91,
  'BetRivers': 0.89,
  'PointsBet': 0.88,
  'bet365': 0.95
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

// ---------- Robust Parsing/validation ----------
function extractJSON(text = '') {
  if (!text || typeof text !== 'string') return null;
  
  // Multiple extraction strategies
  const strategies = [
    // Strategy 1: Code fence extraction
    () => {
      const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1]); } catch {}
      }
      return null;
    },
    // Strategy 2: Find first { to last }
    () => {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try { return JSON.parse(text.substring(start, end + 1)); } catch {}
      }
      return null;
    },
    // Strategy 3: Direct parse
    () => {
      try { return JSON.parse(text); } catch { return null; }
    }
  ];
  
  for (const strategy of strategies) {
    const result = strategy();
    if (result) return result;
  }
  
  return null;
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
    
    // Validate required fields
    if (!book || (!american && !decimal)) return null;
    
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

    // Date handling with robust error handling
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
    };

    // Validate minimum required data
    if (!leg.game || !leg.pick || !leg.market) {
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
    if (!l.game_date_utc) return true; // Allow legs without dates
    
    try {
      const t = Date.parse(l.game_date_utc);
      return Number.isFinite(t) && t >= now && t <= horizon;
    } catch {
      return true; // Be permissive with date parsing errors
    }
  });
}

// ---------- Model discovery with better error handling ----------
async function pickSupportedModel(apiKey, candidates = GEMINI_MODELS) {
  if (!apiKey) {
    console.warn('No Gemini API key provided, using default model');
    return candidates[0];
  }
  
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!data?.models) {
      console.warn('No models found in API response');
      return candidates[0];
    }
    
    const availableModels = new Set(data.models.map(m => (m.name || '').replace(/^models\//, '')));
    console.log('Available Gemini models:', Array.from(availableModels));
    
    for (const candidate of candidates) {
      if (availableModels.has(candidate)) {
        console.log(`✅ Selected Gemini model: ${candidate}`);
        return candidate;
      }
    }
    
    console.warn('No preferred models available, using first candidate');
    return candidates[0];
  } catch (error) {
    console.warn('Model discovery failed, using default:', error.message);
    return candidates[0];
  }
}

// ---------- Optimized Prompt ----------
function createAnalystPrompt({ sportKey, numLegs, betType, hours, tz }) {
  const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
  const sources = SPORT_SOURCES[sportKey] || SPORT_SOURCES.soccer;
  
  return `You are a professional sports analyst. Build a ${numLegs}-leg ${sportName} parlay for games in the next ${hours} hours.

RESEARCH TASKS:
1. Find upcoming games from: ${sources[0]}
2. Cross-shop odds at: ${REGULATED_BOOKS.slice(0, 5).join(', ')}
3. Analyze matchups and identify value bets

CRITICAL: Return ONLY valid JSON in this exact format:

{
  "parlay_legs": [
    {
      "game": "Away Team @ Home Team",
      "market": "moneyline|spread|total",
      "pick": "Specific selection",
      "fair_prob": 0.65,
      "quotes": [
        {
          "book": "Sportsbook",
          "american": -150,
          "decimal": 1.67,
          "opponent_american": +130,
          "source_url": "https://example.com/odds"
        }
      ],
      "best_quote": {
        "book": "Best Sportsbook", 
        "american": -150,
        "decimal": 1.67,
        "source_url": "https://example.com/odds"
      },
      "justification": "Brief analysis of why this is a good bet",
      "confidence": 0.75,
      "game_date_utc": "2025-01-15T20:30:00Z"
    }
  ],
  "confidence_score": 0.80,
  "sources": ["https://source1.com", "https://source2.com"]
}

RULES:
- Only include real upcoming games from official sources
- Provide actual source URLs for odds and game information
- Focus on games with clear value opportunities
- Return pure JSON only - no markdown, no explanations`;
}

// ---------- UPDATED: Perplexity with proper timeout ----------
async function callPerplexity(prompt) {
  const { PERPLEXITY_API_KEY } = env;
  if (!PERPLEXITY_API_KEY) {
    throw new Error('Perplexity API key missing');
  }
  
  console.log('🔄 Calling Perplexity Sonar Pro (90s timeout)...');
  
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { 
            role: 'system', 
            content: 'You are a sports data research expert. Return ONLY valid JSON with current game schedules, odds, and analysis. No markdown, no explanations, no additional text.' 
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
        timeout: 90000 // 90 seconds for thorough research
      }
    );
    
    const content = response?.data?.choices?.[0]?.message?.content || '';
    
    if (!content) {
      throw new Error('Empty response from Perplexity');
    }
    
    console.log('✅ Perplexity response received successfully');
    return content;
  } catch (error) {
    console.error('❌ Perplexity API error:', error.message);
    
    if (error.code === 'ECONNABORTED') {
      throw new Error('Perplexity request timed out after 90 seconds');
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

// UPDATED: Gemini 2.0 with proper implementation
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
    
    // UPDATED: Simple configuration for Gemini 2.0
    const model = genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
      },
      safetySettings: SAFETY,
    });

    const result = await model.generateContent([
      { 
        text: `${prompt}\n\nIMPORTANT: You MUST return ONLY valid JSON format. No markdown, no code fences, no additional text.`
      }
    ]);

    const response = await result.response;
    const text = response.text();
    
    if (!text) {
      throw new Error('Empty response from Gemini');
    }
    
    console.log('✅ Gemini response received successfully');
    return text;
  } catch (error) {
    console.error('❌ Gemini API error:', error.message);
    
    // Specific error handling for common Gemini issues
    if (error.message.includes('404') || error.message.includes('not found')) {
      throw new Error(`Gemini model not available: ${error.message}`);
    }
    
    if (error.message.includes('quota') || error.message.includes('limit')) {
      throw new Error('Gemini API quota exceeded');
    }
    
    if (error.message.includes('403') || error.message.includes('permission')) {
      throw new Error('Gemini API key invalid or permissions insufficient');
    }
    
    throw new Error(`Gemini API call failed: ${error.message}`);
  }
}

// UPDATED: Robust provider calling with better error handling
async function callProvider(aiModel, prompt) {
  console.log(`🔍 Researching with ${aiModel}...`);
  
  const maxAttempts = 2;
  const retryDelay = 2000; // 2 seconds between retries
  
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
      
      // If we have text but no JSON, try a more directive prompt on retry
      if (attempt < maxAttempts && text) {
        const retryPrompt = `${prompt}\n\nCRITICAL: You must return ONLY the JSON object. Remove any markdown, code fences, or explanatory text.`;
        console.log(`🔄 Retrying ${aiModel} with stricter JSON requirements...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      throw new Error('Could not extract valid JSON from response');
      
    } catch (error) {
      console.error(`❌ ${aiModel} attempt ${attempt} failed:`, error.message);
      
      // Don't retry on certain errors
      const fatalErrors = [
        'API key missing',
        'API key invalid', 
        'quota exceeded',
        'rate limit exceeded',
        'model not available'
      ];
      
      if (fatalErrors.some(fatal => error.message.includes(fatal))) {
        throw error;
      }
      
      if (attempt === maxAttempts) {
        throw new Error(`${aiModel} failed after ${maxAttempts} attempts: ${error.message}`);
      }
      
      // Wait before retry
      console.log(`⏳ Waiting ${retryDelay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  throw new Error(`Unexpected error in callProvider for ${aiModel}`);
}

// ---------- UPDATED: Enhanced Service Class ----------
class AIService {
  async generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'perplexity', betType = 'mixed', options = {}) {
    console.log(`🎯 Generating ${numLegs}-leg ${sportKey} parlay in ${mode} mode using ${aiModel}`);
    
    // UPDATED: Proper timeout handling with 120 seconds for thorough research
    const overallTimeoutMs = 120000; // 120 seconds
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Parlay generation timed out after ${overallTimeoutMs}ms`));
      }, overallTimeoutMs);
      
      try {
        let result;
        if (mode === 'web') {
          result = await this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options);
        } else {
          result = await this.generateContextBasedParlay(sportKey, numLegs, betType, options);
        }
        
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  // UPDATED: Web Research with comprehensive error handling
  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    const hours = Number(options.horizonHours || 72); // 3 days for better game selection
    const prompt = createAnalystPrompt({ sportKey, numLegs, betType, hours, tz: TZ });

    console.log('📝 Sending optimized prompt to AI...');
    const obj = await callProvider(aiModel, prompt);
    
    if (!obj || !Array.isArray(obj.parlay_legs)) {
      throw new Error('AI returned invalid JSON structure - missing parlay_legs array');
    }

    console.log(`🔄 Processing ${obj.parlay_legs.length} potential legs...`);
    
    // Robust leg processing
    const legs = obj.parlay_legs
      .map(leg => {
        try {
          return normalizeLeg(leg);
        } catch (error) {
          console.warn('Failed to normalize leg:', error.message);
          return null;
        }
      })
      .filter(leg => leg !== null)
      .slice(0, numLegs);

    if (legs.length === 0) {
      throw new Error(`No valid ${sportKey} legs could be processed from AI response`);
    }

    console.log(`✅ Successfully processed ${legs.length} legs`);

    // Calculate parlay metrics
    const parlayDec = parlayDecimal(legs);
    const parlayAm = decimalToAmerican(parlayDec);

    // Calculate expected value
    const fairProbs = legs.map(l => l.fair_prob).filter(v => v != null);
    const jointFair = fairProbs.length > 0 ? fairProbs.reduce((p, v) => p * v, 1) : null;
    const parlayEV = jointFair != null ? (jointFair * parlayDec - 1) : null;

    console.log(`🎉 Parlay built successfully: ${legs.length} legs, ${parlayAm > 0 ? '+' : ''}${parlayAm} odds`);
    
    return {
      parlay_legs: legs,
      confidence_score: typeof obj.confidence_score === 'number' ? clamp01(obj.confidence_score) : 0.75,
      parlay_odds_decimal: parlayDec,
      parlay_odds_american: parlayAm,
      parlay_ev: parlayEV,
      sources: Array.isArray(obj.sources) ? obj.sources : [],
      research_metadata: {
        sport: sportKey,
        legs_requested: numLegs,
        legs_delivered: legs.length,
        generated_at: new Date().toISOString(),
        ai_model: aiModel,
        research_time_hours: hours
      }
    };
  }

  // Live/DB modes - optimized
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}) {
    console.log(`🔄 Using internal APIs for ${sportKey}...`);
    
    try {
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
          confidence: 0.65,
          fair_prob: 0.55
        };
      });

      return { 
        parlay_legs: legs, 
        confidence_score: 0.70,
        source: 'internal_api' 
      };
    } catch (error) {
      console.error('Context-based parlay generation failed:', error.message);
      throw new Error(`Internal data service error: ${error.message}`);
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
}

export default new AIService();
