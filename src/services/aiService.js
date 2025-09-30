// src/services/aiService.js - FIXED VERSION

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';

// Internal services for Live/DB modes only
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import databaseService from './databaseService.js';
import rateLimitService from './rateLimitService.js';
import { sentryService } from './sentryService.js';

// ---------- ENHANCED Constants ----------
const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 90000; // 90 seconds for thorough research
const MAX_OUTPUT_TOKENS = 8192;
const WEB_HORIZON_HOURS = 168;

// Enhanced safety settings
const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Enhanced model selection with fallbacks
const GEMINI_MODELS = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
const PERPLEXITY_MODELS = ['sonar-pro', 'sonar-small-chat'];

// Enhanced bookmaker coverage
const REGULATED_BOOKS = [
  'FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'ESPN BET', 'BetRivers', 
  'PointsBet', 'bet365', 'William Hill', 'Unibet', 'Betway', '888sport'
];

// Enhanced sport sources with comprehensive coverage
const SPORT_SOURCES = {
  americanfootball_nfl: ['https://www.nfl.com/schedules/', 'https://www.espn.com/nfl/schedule'],
  americanfootball_ncaaf: ['https://www.espn.com/college-football/schedule'],
  basketball_nba: ['https://www.nba.com/schedule', 'https://www.espn.com/nba/schedule'],
  basketball_wnba: ['https://www.wnba.com/schedule', 'https://www.espn.com/wnba/schedule'],
  basketball_ncaab: ['https://www.espn.com/mens-college-basketball/schedule'],
  baseball_mlb: ['https://www.mlb.com/schedule', 'https://www.espn.com/mlb/schedule'],
  icehockey_nhl: ['https://www.nhl.com/schedule', 'https://www.espn.com/nhl/schedule'],
  soccer_england_premier_league: ['https://www.premierleague.com/fixtures', 'https://www.espn.com/soccer/schedule'],
  soccer_uefa_champions_league: ['https://www.uefa.com/uefachampionsleague/fixtures-results/'],
  tennis_atp: ['https://www.atptour.com/en/schedule', 'https://www.espn.com/tennis/schedule'],
  tennis_wta: ['https://www.wtatennis.com/schedule', 'https://www.espn.com/tennis/schedule'],
  mma_ufc: ['https://www.ufc.com/schedule'],
  golf_pga: ['https://www.pgatour.com/schedule.html'],
  formula1: ['https://www.formula1.com/en/racing/2024.html']
};

// Enhanced bookmaker tier system
const BOOK_TIER = {
  'DraftKings': 0.96,
  'FanDuel': 0.96,
  'Caesars': 0.93,
  'BetMGM': 0.93,
  'ESPN BET': 0.91,
  'BetRivers': 0.89,
  'PointsBet': 0.88,
  'bet365': 0.95,
  'William Hill': 0.90,
  'Unibet': 0.89,
  'Betway': 0.88,
  '888sport': 0.87
};

// ---------- Enhanced Math helpers ----------
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

// ---------- ENHANCED Robust JSON Parsing/validation ----------
function extractJSON(text = '') {
  if (!text || typeof text !== 'string') {
    console.warn('⚠️ extractJSON: Empty or invalid text input');
    return null;
  }
  
  console.log('🔧 Attempting JSON extraction from:', text.substring(0, 200) + '...');
  
  // Multiple extraction strategies
  const strategies = [
    // Strategy 1: Code fence extraction
    () => {
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) {
        console.log('✅ Found JSON in code fence');
        try { 
          return JSON.parse(fenceMatch[1]); 
        } catch (error) {
          console.warn('❌ Code fence JSON parse failed:', error.message);
        }
      }
      return null;
    },
    // Strategy 2: Find first { to last } with enhanced cleaning
    () => {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const candidate = text.substring(start, end + 1);
        console.log('✅ Found JSON candidate with braces');
        try { 
          return JSON.parse(candidate); 
        } catch (error) {
          console.warn('❌ Brace-based JSON parse failed:', error.message);
          // Try to fix common JSON issues
          return attemptJSONRepair(candidate);
        }
      }
      return null;
    },
    // Strategy 3: Direct parse
    () => {
      try { 
        return JSON.parse(text); 
      } catch (error) {
        console.warn('❌ Direct JSON parse failed:', error.message);
        return null;
      }
    },
    // Strategy 4: Aggressive cleaning and retry
    () => {
      const cleaned = cleanJSONString(text);
      if (cleaned !== text) {
        console.log('🔄 Attempting with cleaned JSON string');
        try {
          return JSON.parse(cleaned);
        } catch (error) {
          console.warn('❌ Cleaned JSON parse failed:', error.message);
        }
      }
      return null;
    }
  ];
  
  for (const strategy of strategies) {
    const result = strategy();
    if (result) {
      console.log('✅ JSON extraction successful');
      return result;
    }
  }
  
  console.error('❌ All JSON extraction strategies failed');
  return null;
}

// ENHANCED: JSON repair function with better positive odds handling
// ENHANCED: JSON repair function with COMPREHENSIVE positive odds handling
function attemptJSONRepair(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') return null;
  
  console.log('🔄 Attempting JSON repair...');
  
  try {
    let repaired = jsonString;
    
    // CRITICAL FIX: Handle ALL positive American odds with + signs
    // Fix pattern: "american": +125 -> "american": 125
    repaired = repaired.replace(/"american":\s*\+(\d+)/g, '"american": $1');
    repaired = repaired.replace(/"opponent_american":\s*\+(\d+)/g, '"opponent_american": $1');
    
    // ENHANCED: Also fix any numeric field that might have + signs
    repaired = repaired.replace(/"odds_american":\s*\+(\d+)/g, '"odds_american": $1');
    repaired = repaired.replace(/"price":\s*\+(\d+)/g, '"price": $1');
    
    // ENHANCED: General fix for any field with positive numbers
    repaired = repaired.replace(/(["']\w*["']\s*:\s*)\+(\d+)/g, '$1$2');
    
    // Keep your existing repairs...
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
    repaired = repaired.replace(/'/g, '"');
    repaired = repaired.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    
    console.log('🔧 Repaired JSON sample:', repaired.substring(0, 300) + '...');
    
    const parsed = JSON.parse(repaired);
    console.log('✅ JSON repair successful');
    return parsed;
  } catch (repairError) {
    console.warn('❌ JSON repair failed:', repairError.message);
    return null;
  }
}

// ENHANCED: JSON string cleaning with positive odds handling
function cleanJSONString(text) {
  if (!text || typeof text !== 'string') return text;
  
  let cleaned = text.trim();
  
  // Remove common non-JSON prefixes/suffixes
  cleaned = cleaned.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '');
  
  // Remove markdown formatting
  cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '');
  
  // Fix positive American odds before other processing
  cleaned = cleaned.replace(/"american":\s*\+(\d+)/g, '"american": $1');
  cleaned = cleaned.replace(/"opponent_american":\s*\+(\d+)/g, '"opponent_american": $1');
  
  // Remove extra whitespace but preserve structure
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Ensure it starts with { or [
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const braceIndex = cleaned.indexOf('{');
    const bracketIndex = cleaned.indexOf('[');
    const startIndex = Math.max(braceIndex, bracketIndex);
    if (startIndex !== -1) {
      cleaned = cleaned.substring(startIndex);
    }
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
    
    // Enhanced validation
    if (!book || book === 'Unknown' || (!american && !decimal)) return null;
    
    return { book, line, american, decimal, opponent_american: oppA, source_url: url, fetched_at };
  } catch (error) {
    console.warn('Quote coercion failed:', error.message);
    sentryService.captureError(error, { component: 'ai_service', operation: 'coerceQuote' });
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

    // Enhanced date handling with validation
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
      data_quality: 'ai_generated'
    };

    // Enhanced validation
    if (!leg.game || !leg.pick || !leg.market || leg.game === 'Unknown' || leg.pick === 'Unknown') {
      console.warn('Leg missing required fields:', { game: leg.game, pick: leg.pick, market: leg.market });
      return null;
    }
    
    return leg;
  } catch (error) {
    console.error('Leg normalization failed:', error.message);
    sentryService.captureError(error, { component: 'ai_service', operation: 'normalizeLeg' });
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

// ---------- Enhanced Model discovery ----------
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
    sentryService.captureError(error, { component: 'ai_service', operation: 'pickSupportedModel' });
    return candidates[0];
  }
}

// ---------- ENHANCED Prompt Engineering with BETTER JSON Formatting ----------
function createAnalystPrompt({ sportKey, numLegs, betType, hours, tz }) {
  const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
  const sources = SPORT_SOURCES[sportKey] || SPORT_SOURCES.soccer;
  
  // SIMPLIFIED but still comprehensive prompt
  return `As a professional ${sportName} analyst, create a ${numLegs}-leg parlay for games in the next ${hours} hours.

CRITICAL: Return ONLY valid JSON in this exact structure:

{
  "parlay_legs": [
    {
      "game": "Team A @ Team B",
      "market": "moneyline",
      "pick": "Team A", 
      "fair_prob": 0.65,
      "quotes": [
        {
          "book": "DraftKings",
          "american": -150,
          "decimal": 1.67,
          "opponent_american": 130,
          "source_url": "https://example.com/odds"
        }
      ],
      "justification": "Detailed analysis here...",
      "confidence": 0.75,
      "game_date_utc": "2025-01-15T20:30:00Z"
    }
  ],
  "confidence_score": 0.80,
  "sources": ["https://source1.com"]
}

STRICT REQUIREMENTS:
- Use REAL teams and accurate odds from ${REGULATED_BOOKS.slice(0, 4).join(', ')}
- For American odds: use -150 or 125 (NO + signs)
- Return PURE JSON only - no markdown, no explanations
- Validate JSON syntax: double quotes, no trailing commas
- All brackets must be properly closed

Your response must be valid JSON that can be parsed by JSON.parse() without modifications.`;
}

// ---------- Enhanced Perplexity with better error handling ----------
async function callPerplexity(prompt) {
  const { PERPLEXITY_API_KEY } = env;
  if (!PERPLEXITY_API_KEY) {
    throw new Error('Perplexity API key missing - check environment configuration');
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
            content: 'You are a professional sports data research expert. Return ONLY valid JSON with current game schedules, real odds from regulated books, and data-driven analysis. No markdown, no explanations, no additional text. Validate all information is current and accurate. For American odds, use numbers without + signs (e.g., 125 instead of +125).' 
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
          'Content-Type': 'application/json',
          'User-Agent': 'ParlayBot-AI-Service/1.0'
        }, 
        timeout: WEB_TIMEOUT_MS
      }
    );
    
    const content = response?.data?.choices?.[0]?.message?.content || '';
    
    if (!content) {
      throw new Error('Empty response from Perplexity - no content received');
    }
    
    console.log('✅ Perplexity response received successfully');
    return content;
  } catch (error) {
    console.error('❌ Perplexity API error:', error.message);
    
    // Enhanced error categorization
    if (error.code === 'ECONNABORTED') {
      throw new Error('Perplexity request timed out after 90 seconds - service may be overloaded');
    }
    
    if (error.response?.status === 401) {
      throw new Error('Perplexity API key invalid or expired');
    }
    
    if (error.response?.status === 429) {
      throw new Error('Perplexity rate limit exceeded - try again later');
    }
    
    if (error.response?.status >= 500) {
      throw new Error('Perplexity service temporarily unavailable');
    }
    
    sentryService.captureError(error, { 
      component: 'ai_service', 
      operation: 'callPerplexity',
      status: error.response?.status 
    });
    
    throw new Error(`Perplexity research failed: ${error.message}`);
  }
}

// ---------- FIXED Gemini 2.0 implementation - REMOVED unsupported parameters ----------
// ---------- FIXED Gemini 2.0 implementation - REMOVED unsupported parameters ----------
async function callGemini(prompt) {
  const { GOOGLE_GEMINI_API_KEY } = env;
  if (!GOOGLE_GEMINI_API_KEY) {
    throw new Error('Gemini API key missing - check environment configuration');
  }
  
  console.log('🔄 Calling Gemini...');
  
  try {
    const modelId = await pickSupportedModel(GOOGLE_GEMINI_API_KEY);
    console.log(`🔧 Using Gemini model: ${modelId}`);
    
    const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);
    
    // FIXED: Remove unsupported parameters that cause 400 errors
    const model = genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
        // REMOVED: responseMimeType and responseSchema - not supported
      },
      safetySettings: SAFETY,
    });

    const result = await model.generateContent([{ text: prompt }]);
    const response = await result.response;
    const text = response.text();
    
    if (!text) {
      throw new Error('Empty response from Gemini - no text generated');
    }
    
    console.log('✅ Gemini response received successfully');
    return text;
  } catch (error) {
    console.error('❌ Gemini API error:', error.message);
  }
}
    
    // Enhanced error handling
    if (error.message.includes('404') || error.message.includes('not found')) {
      throw new Error(`Gemini model not available: ${error.message}`);
    }
    
    if (error.message.includes('quota') || error.message.includes('limit')) {
      throw new Error('Gemini API quota exceeded - check usage limits');
    }
    
    if (error.message.includes('403') || error.message.includes('permission')) {
      throw new Error('Gemini API key invalid or permissions insufficient');
    }
    
    if (error.message.includes('500') || error.message.includes('503')) {
      throw new Error('Gemini service temporarily unavailable');
    }
    
    sentryService.captureError(error, { 
      component: 'ai_service', 
      operation: 'callGemini' 
    });
    
    throw new Error(`Gemini API call failed: ${error.message}`);
  }
}

// ---------- ENHANCED provider calling with better JSON validation ----------
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
      console.log('📄 Raw response sample:', text.substring(0, 500));
      
      // Enhanced retry logic with better prompt for JSON formatting
      if (attempt < maxAttempts && text) {
        const retryPrompt = `${prompt}\n\nCRITICAL: Previous response was invalid JSON. You must return ONLY the JSON object with no additional text, markdown, or code fences. Ensure:\n- All strings use double quotes\n- No trailing commas in arrays or objects\n- All brackets and braces are properly closed\n- For American odds, use numbers without + signs (e.g., 125 instead of +125)\n- The JSON structure matches exactly the required format`;
        console.log(`🔄 Retrying ${aiModel} with stricter JSON requirements...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      throw new Error('Could not extract valid JSON from AI response after multiple attempts');
      
    } catch (error) {
      console.error(`❌ ${aiModel} attempt ${attempt} failed:`, error.message);
      
      // Enhanced fatal error detection
      const fatalErrors = [
        'API key missing',
        'API key invalid', 
        'quota exceeded',
        'rate limit exceeded',
        'model not available',
        'service temporarily unavailable'
      ];
      
      if (fatalErrors.some(fatal => error.message.includes(fatal))) {
        sentryService.captureError(error, { 
          component: 'ai_service', 
          operation: 'callProvider',
          provider: aiModel,
          attempt 
        });
        throw error;
      }
      
      if (attempt === maxAttempts) {
        const finalError = new Error(`${aiModel} failed after ${maxAttempts} attempts: ${error.message}`);
        sentryService.captureError(finalError, { 
          component: 'ai_service', 
          operation: 'callProvider_final',
          provider: aiModel 
        });
        throw finalError;
      }
      
      // Wait before retry
      console.log(`⏳ Waiting ${retryDelay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  throw new Error(`Unexpected error in callProvider for ${aiModel}`);
}

// ---------- ENHANCED Service Class ----------
class AIService {
  constructor() {
    this.generationStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageProcessingTime: 0,
      lastRequest: null
    };
  }

  async function generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'perplexity', betType = 'mixed', options = {}) {
  const requestId = `parlay_${sportKey}_${Date.now()}`;
  console.log(`🎯 Generating ${numLegs}-leg ${sportKey} parlay in ${mode} mode using ${aiModel} (${requestId})`);
  
  this.generationStats.totalRequests++;
  this.generationStats.lastRequest = new Date().toISOString();
  
  const startTime = Date.now();
  
  try {
    let result;
    if (mode === 'web') {
      result = await this._executeWithTimeout(
        this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options),
        120000,
        `Web research parlay generation for ${sportKey}`
      );
    } else {
      result = await this._executeWithTimeout(
        this.generateContextBasedParlay(sportKey, numLegs, betType, options),
        120000,
        `Context-based parlay generation for ${sportKey}`
      );
    }

    const processingTime = Date.now() - startTime;
    this._updateStats(true, processingTime);
    
    console.log(`✅ Parlay generated successfully in ${processingTime}ms (${requestId})`);
    return {
      ...result,
      metadata: {
        ...result.metadata,
        request_id: requestId,
        processing_time_ms: processingTime,
        service_version: '2.1-fixed'
      }
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;
    this._updateStats(false, processingTime);
    
    console.error(`❌ Parlay generation failed for ${requestId}:`, error.message);
    
    // CRITICAL FIX: Automatic fallback to internal data
    if (mode === 'web') {
      console.log('🔄 Attempting automatic fallback to internal data...');
      try {
        const fallbackResult = await this.generateContextBasedParlay(sportKey, numLegs, betType, options);
        console.log(`✅ Fallback parlay generated successfully with ${fallbackResult.parlay_legs.length} legs`);
        
        // Mark as fallback in metadata
        fallbackResult.metadata = {
          ...fallbackResult.metadata,
          request_id: requestId,
          processing_time_ms: processingTime,
          service_version: '2.1-fixed',
          fallback_used: true,
          original_error: error.message
        };
        
        return fallbackResult;
      } catch (fallbackError) {
        console.error('❌ Fallback also failed:', fallbackError.message);
      }
    }
    
    sentryService.captureError(error, { 
      component: 'ai_service', 
      operation: 'generateParlay',
      sportKey,
      mode,
      aiModel,
      betType,
      requestId,
      processingTime 
    });
    
    throw new Error(`Parlay generation failed: ${error.message} (${requestId})`);
  }
}

  // Enhanced Web Research with comprehensive error handling
  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    const hours = Number(options.horizonHours || 72);
    const prompt = createAnalystPrompt({ sportKey, numLegs, betType, hours, tz: TZ });

    console.log('📝 Sending enhanced prompt to AI...');
    const obj = await callProvider(aiModel, prompt);
    
    if (!obj || !Array.isArray(obj.parlay_legs)) {
      throw new Error('AI returned invalid JSON structure - missing parlay_legs array');
    }

    console.log(`🔄 Processing ${obj.parlay_legs.length} potential legs...`);
    
    // Enhanced leg processing with validation
    const legs = obj.parlay_legs
      .map((leg, index) => {
        try {
          const normalized = normalizeLeg(leg);
          if (!normalized) {
            console.warn(`⚠️ Discarding invalid leg ${index + 1}:`, leg);
          }
          return normalized;
        } catch (error) {
          console.warn(`⚠️ Failed to normalize leg ${index + 1}:`, error.message);
          return null;
        }
      })
      .filter(leg => leg !== null)
      .slice(0, numLegs);

    if (legs.length === 0) {
      throw new Error(`No valid ${sportKey} legs could be processed from AI response`);
    }

    console.log(`✅ Successfully processed ${legs.length} legs`);

    // Enhanced parlay metrics
    const parlayDec = parlayDecimal(legs);
    const parlayAm = decimalToAmerican(parlayDec);

    // Enhanced expected value calculation
    const fairProbs = legs.map(l => l.fair_prob).filter(v => v != null);
    const jointFair = fairProbs.length > 0 ? fairProbs.reduce((p, v) => p * v, 1) : null;
    const parlayEV = jointFair != null ? (jointFair * parlayDec - 1) : null;

    // Enhanced data quality assessment
    const dataQuality = this._assessParlayDataQuality(legs);

    console.log(`🎉 Parlay built successfully: ${legs.length} legs, ${parlayAm > 0 ? '+' : ''}${parlayAm} odds`);
    
    return {
      parlay_legs: legs,
      confidence_score: typeof obj.confidence_score === 'number' ? clamp01(obj.confidence_score) : 0.75,
      parlay_odds_decimal: parlayDec,
      parlay_odds_american: parlayAm,
      parlay_ev: parlayEV,
      sources: Array.isArray(obj.sources) ? obj.sources : [],
      data_quality: dataQuality,
      research_metadata: {
        sport: sportKey,
        legs_requested: numLegs,
        legs_delivered: legs.length,
        generated_at: new Date().toISOString(),
        ai_model: aiModel,
        research_time_hours: hours,
        data_sources: obj.sources?.length || 0,
        success_rate: (legs.length / obj.parlay_legs.length * 100).toFixed(1) + '%'
      }
    };
  }

  // Enhanced Live/DB modes with better data integration
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}) {
    console.log(`🔄 Using enhanced internal APIs for ${sportKey}...`);
    
    try {
      // Enhanced data fetching with fallbacks
      let games = await oddsService.getSportOdds(sportKey, { useCache: true });
      if (!games || games.length === 0) {
        console.log(`🔄 Fallback to games service for ${sportKey}...`);
        games = await gamesService.getGamesForSport(sportKey, { useCache: true });
      }
      
      if (!games || games.length === 0) {
        // Final fallback to database
        console.log(`🔄 Final fallback to database for ${sportKey}...`);
        games = await databaseService.getUpcomingGames(sportKey, 72);
      }
      
      if (!games || games.length < numLegs) {
        throw new Error(`Insufficient ${sportKey} games available. Found ${games?.length || 0}, need ${numLegs}`);
      }

      // Enhanced game selection with diversity
      const selected = this._selectDiverseGames(games, numLegs);
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
            source_url: `internal:${sportKey}_${game.event_id}`
          },
          odds_american: american,
          odds_decimal: decimal,
          game_date_utc: game.commence_time,
          game_date_local: this.toLocal(game.commence_time, TZ),
          justification: `Selected from verified ${sportKey} data with ${bookmakers.length} bookmakers`,
          confidence: 0.65 - (index * 0.05), // Slightly decreasing confidence
          fair_prob: 0.55,
          data_quality: 'internal_api'
        };
      });

      const parlayDec = parlayDecimal(legs);
      const parlayAm = decimalToAmerican(parlayDec);

      return { 
        parlay_legs: legs, 
        confidence_score: 0.70,
        parlay_odds_decimal: parlayDec,
        parlay_odds_american: parlayAm,
        source: 'enhanced_internal_api',
        data_quality: this._assessParlayDataQuality(legs),
        research_metadata: {
          sport: sportKey,
          legs_requested: numLegs,
          legs_delivered: legs.length,
          generated_at: new Date().toISOString(),
          data_source: gamesService.constructor.name,
          game_variety: new Set(legs.map(l => l.game)).size
        }
      };
    } catch (error) {
      console.error('Enhanced context-based parlay generation failed:', error.message);
      throw new Error(`Internal data service error: ${error.message}`);
    }
  }

  // Enhanced generic chat method for analytics
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
      sentryService.captureError(error, { 
        component: 'ai_service', 
        operation: 'genericChat',
        model,
        chatId 
      });
      throw error;
    }
  }

  // Enhanced validation for analytics
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
      // Enhanced fallback logic
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

  // ========== PRIVATE ENHANCED METHODS ==========

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

    // Update rolling average processing time
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

    // Leg count quality
    if (legs.length >= 3) {
      score += 20;
      factors.push('good_leg_count');
    }

    // Data source quality
    const aiGeneratedLegs = legs.filter(l => l.data_quality === 'ai_generated').length;
    const internalLegs = legs.filter(l => l.data_quality === 'internal_api').length;
    
    if (aiGeneratedLegs > 0) {
      score += 30;
      factors.push('ai_enhanced_data');
    }
    if (internalLegs > 0) {
      score += 20;
      factors.push('verified_internal_data');
    }

    // Odds quality
    const legsWithOdds = legs.filter(l => l.odds_american !== null).length;
    if (legsWithOdds === legs.length) {
      score += 20;
      factors.push('complete_odds_coverage');
    }

    // Date quality
    const legsWithDates = legs.filter(l => l.game_date_utc).length;
    if (legsWithDates === legs.length) {
      score += 15;
      factors.push('complete_date_coverage');
    }

    // Justification quality
    const goodJustifications = legs.filter(l => l.justification && l.justification.length > 30).length;
    if (goodJustifications === legs.length) {
      score += 15;
      factors.push('detailed_justifications');
    }

    return {
      score: Math.min(100, score),
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor',
      factors,
      breakdown: {
        total_legs: legs.length,
        ai_enhanced: aiGeneratedLegs,
        internal_data: internalLegs,
        with_odds: legsWithOdds,
        with_dates: legsWithDates,
        with_justifications: goodJustifications
      }
    };
  }

  _selectDiverseGames(games, numLegs) {
    if (!games || games.length <= numLegs) {
      return games || [];
    }

    // Enhanced diversity selection
    const selected = [];
    const usedTeams = new Set();
    
    for (const game of games) {
      if (selected.length >= numLegs) break;
      
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      
      // Prefer games with teams we haven't used yet
      if (!usedTeams.has(homeTeam) && !usedTeams.has(awayTeam)) {
        selected.push(game);
        usedTeams.add(homeTeam);
        usedTeams.add(awayTeam);
      }
    }

    // If we still need more games, fill with any available
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

    // Enhanced market selection based on bet type
    const markets = bookmakers.flatMap(b => b.markets || []);
    
    if (betType === 'props') {
      return markets.find(m => m.key.includes('player_')) || markets[0];
    } else if (betType === 'spreads') {
      return markets.find(m => m.key === 'spreads') || markets[0];
    } else if (betType === 'moneyline') {
      return markets.find(m => m.key === 'h2h') || markets[0];
    } else {
      // Mixed - prefer spreads and totals for variety
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

  // Enhanced service status method
  async getServiceStatus() {
    const status = {
      service: 'AIService',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      capabilities: {
        web_research: true,
        context_based: true,
        generic_chat: true,
        odds_validation: true
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

    // Test AI provider connectivity
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

    // Note: Perplexity connectivity is tested during actual calls

    return status;
  }
}

export default new AIService();
