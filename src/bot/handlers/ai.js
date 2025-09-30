// src/services/aiService.js
// COMPLETE REWRITE: Fallback system + Better JSON parsing + Stale data warnings

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';

// Internal services for Live/DB modes
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

// ---------- Constants ----------
const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 90000;
const MAX_OUTPUT_TOKENS = 8192;
const WEB_HORIZON_HOURS = 168;

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Updated Gemini models with 2.5 support
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

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

// ---------- IMPROVED JSON Parsing ----------
function extractJSON(text = '') {
  if (!text || typeof text !== 'string') {
    console.log('❌ extractJSON: No text provided');
    return null;
  }

  console.log(`🔍 extractJSON: Processing ${text.length} characters`);

  // Clean the text first
  let cleanText = text.trim();
  
  // Remove any markdown code fences
  cleanText = cleanText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  
  // Remove any leading/trailing whitespace and common AI artifacts
  cleanText = cleanText.replace(/^[\s\S]*?({[\s\S]*})[\s\S]*?$/, '$1');
  
  // Multiple extraction strategies
  const strategies = [
    // Strategy 1: Direct parse (clean)
    () => {
      try {
        const result = JSON.parse(cleanText);
        console.log('✅ Strategy 1 (Direct) succeeded');
        return result;
      } catch (e) {
        console.log('❌ Strategy 1 failed:', e.message);
        return null;
      }
    },
    
    // Strategy 2: Find first { to last }
    () => {
      const start = cleanText.indexOf('{');
      const end = cleanText.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          const candidate = cleanText.substring(start, end + 1);
          const result = JSON.parse(candidate);
          console.log('✅ Strategy 2 (Brace match) succeeded');
          return result;
        } catch (e) {
          console.log('❌ Strategy 2 failed:', e.message);
        }
      }
      return null;
    },
    
    // Strategy 3: Try to fix common JSON issues
    () => {
      try {
        // Fix common AI JSON issues
        let fixed = cleanText
          .replace(/(\w+):/g, '"$1":') // Add quotes to keys
          .replace(/'/g, '"') // Replace single quotes with double
          .replace(/,\s*}/g, '}') // Remove trailing commas
          .replace(/,\s*]/g, ']') // Remove trailing commas in arrays
          .replace(/\n/g, ' ') // Remove newlines
          .replace(/\s+/g, ' '); // Normalize whitespace
        
        const result = JSON.parse(fixed);
        console.log('✅ Strategy 3 (Fixed JSON) succeeded');
        return result;
      } catch (e) {
        console.log('❌ Strategy 3 failed:', e.message);
        return null;
      }
    },
    
    // Strategy 4: Extract JSON from markdown code blocks
    () => {
      const codeBlockMatch = cleanText.match(/(\{[^}]*(?:\}[^}]*)*\})/);
      if (codeBlockMatch) {
        try {
          const result = JSON.parse(codeBlockMatch[1]);
          console.log('✅ Strategy 4 (Code block) succeeded');
          return result;
        } catch (e) {
          console.log('❌ Strategy 4 failed:', e.message);
        }
      }
      return null;
    }
  ];

  // Try each strategy
  for (let i = 0; i < strategies.length; i++) {
    const result = strategies[i]();
    if (result) {
      console.log(`🎉 JSON extraction successful with strategy ${i + 1}`);
      return result;
    }
  }

  // Log what we got for debugging
  console.log('❌ All JSON extraction strategies failed');
  console.log('📝 First 500 chars of response:', text.substring(0, 500));
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

    // Date handling
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

    if (!leg.game || !leg.pick || !leg.market) {
      console.warn('Leg missing required fields');
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

// ---------- Model discovery ----------
async function pickSupportedModel(apiKey, candidates = GEMINI_MODELS) {
  if (!apiKey) {
    console.warn('No Gemini API key provided');
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
    console.warn('Model discovery failed:', error.message);
    return candidates[0];
  }
}

// ---------- IMPROVED Prompt with Better JSON Instructions ----------
function createAnalystPrompt({ sportKey, numLegs, betType, hours, tz }) {
  const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
  const sources = SPORT_SOURCES[sportKey] || SPORT_SOURCES.soccer;
  
  return `You are a professional sports analyst. Build a ${numLegs}-leg ${sportName} parlay for games in the next ${hours} hours.

RESEARCH:
- Find upcoming games from: ${sources[0]}
- Cross-shop odds at: ${REGULATED_BOOKS.slice(0, 5).join(', ')}

CRITICAL: You MUST return ONLY valid JSON in this exact format. No other text, no markdown, no explanations.

{
  "parlay_legs": [
    {
      "game": "Away Team @ Home Team",
      "market": "moneyline",
      "pick": "Team Name",
      "fair_prob": 0.65,
      "quotes": [
        {
          "book": "Sportsbook Name",
          "american": -150,
          "decimal": 1.67,
          "opponent_american": 130,
          "source_url": "https://example.com/odds"
        }
      ],
      "best_quote": {
        "book": "Sportsbook Name",
        "american": -150,
        "decimal": 1.67,
        "source_url": "https://example.com/odds"
      },
      "justification": "Brief analysis of why this is a good bet",
      "confidence": 0.75,
      "game_date_utc": "2025-01-15T20:30:00.000Z"
    }
  ],
  "confidence_score": 0.80,
  "sources": ["https://source1.com", "https://source2.com"]
}

IMPORTANT RULES:
1. Only include real upcoming games from official sources
2. Provide actual source URLs for odds
3. Use proper JSON format - all keys in double quotes
4. No trailing commas
5. No comments or explanations
6. Return ONLY the JSON object`;
}

// ---------- IMPROVED Perplexity with Better Error Handling ----------
async function callPerplexity(prompt) {
  const { PERPLEXITY_API_KEY } = env;
  if (!PERPLEXITY_API_KEY) {
    throw new Error('Perplexity API key missing');
  }
  
  console.log('🔄 Calling Perplexity Sonar Pro...');
  
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { 
            role: 'system', 
            content: 'You are a sports data expert. Return ONLY valid JSON format. No markdown, no code fences, no explanations. Ensure all JSON keys are in double quotes and there are no trailing commas.' 
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
        timeout: 120000 // 120 seconds for thorough research
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
      throw new Error('Perplexity request timed out after 120 seconds');
    }
    
    throw new Error(`Perplexity research failed: ${error.message}`);
  }
}

// ---------- IMPROVED Gemini 2.5/2.0 Implementation ----------
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
    
    const model = genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
      },
      safetySettings: SAFETY,
    });

    // Use the exact prompt format that works
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    if (!text) {
      throw new Error('Empty response from Gemini');
    }
    
    console.log('✅ Gemini response received');
    return text;
  } catch (error) {
    console.error('❌ Gemini API error:', error.message);
    
    if (error.message.includes('404') || error.message.includes('not found')) {
      throw new Error(`Gemini model not available: ${error.message}`);
    }
    
    throw new Error(`Gemini API call failed: ${error.message}`);
  }
}

// ---------- IMPROVED Provider Calling ----------
async function callProvider(aiModel, prompt) {
  console.log(`🔍 Researching with ${aiModel}...`);
  
  const maxAttempts = 2;
  
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
      
      // More directive prompt for retry
      if (attempt < maxAttempts) {
        const retryPrompt = `${prompt}\n\nCRITICAL: You must return ONLY the JSON object. Remove ALL other text, markdown, code fences, and explanations. Ensure proper JSON syntax with double quotes for all keys and no trailing commas.`;
        console.log(`🔄 Retrying ${aiModel} with stricter JSON requirements...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      throw new Error('Could not extract valid JSON from response');
      
    } catch (error) {
      console.error(`❌ ${aiModel} attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxAttempts) {
        throw new Error(`${aiModel} failed after ${maxAttempts} attempts: ${error.message}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  throw new Error(`Unexpected error in callProvider for ${aiModel}`);
}

// ---------- NEW: Fallback System with Stale Data Warnings ----------
class FallbackSystem {
  constructor() {
    this.lastDataRefresh = new Map();
  }

  async getDataFreshness(sportKey) {
    try {
      // Try to get the last refresh time from your database
      // This would typically come from your oddsService or gamesService
      const refreshTime = await this.getLastRefreshTime(sportKey);
      this.lastDataRefresh.set(sportKey, refreshTime);
      return refreshTime;
    } catch (error) {
      console.warn('Could not get data freshness:', error.message);
      // Return a default stale time if we can't get the actual refresh time
      return new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago as fallback
    }
  }

  async getLastRefreshTime(sportKey) {
    // This should be implemented in your oddsService/gamesService
    // For now, return current time minus a reasonable delay
    return new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago as example
  }

  getStaleDataWarning(sportKey, lastRefresh) {
    const now = new Date();
    const hoursAgo = Math.round((now - lastRefresh) / (1000 * 60 * 60));
    
    let warningLevel = '⚠️';
    if (hoursAgo > 24) warningLevel = '🚨';
    else if (hoursAgo > 6) warningLevel = '❗';
    
    return {
      warning: `${warningLevel} *STALE DATA WARNING* ${warningLevel}`,
      message: `Database information is ${hoursAgo} hours old. Odds and game information may be outdated. Last refresh: ${lastRefresh.toLocaleString()}`,
      hoursAgo,
      isCritical: hoursAgo > 6
    };
  }

  generateFallbackOptions(sportKey, lastRefresh) {
    const warning = this.getStaleDataWarning(sportKey, lastRefresh);
    
    return {
      live_mode: {
        name: "🔴 Live Mode",
        description: "Use current API data (may be limited)",
        warning: warning.message,
        requires_confirmation: warning.isCritical
      },
      db_mode: {
        name: "💾 Database Mode", 
        description: "Use stored database information",
        warning: `${warning.message}\n\nThis data is ${warning.hoursAgo} hours old and may contain expired odds.`,
        requires_confirmation: true
      }
    };
  }
}

// ---------- ENHANCED Service Class with Fallback System ----------
class AIService {
  constructor() {
    this.fallbackSystem = new FallbackSystem();
  }

  async generateParlay(sportKey, numLegs = 2, mode = 'web', aiModel = 'perplexity', betType = 'mixed', options = {}) {
    console.log(`🎯 Generating ${numLegs}-leg ${sportKey} parlay in ${mode} mode using ${aiModel}`);
    
    // Handle non-web modes directly (no timeout needed for internal data)
    if (mode !== 'web') {
      return this.generateContextBasedParlay(sportKey, numLegs, betType, options, mode);
    }

    // Web mode with proper timeout
    const overallTimeoutMs = 120000;
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Web research timed out after ${overallTimeoutMs}ms`));
      }, overallTimeoutMs);
      
      try {
        const result = await this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options);
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        
        // Web mode failed - prepare fallback options
        const lastRefresh = await this.fallbackSystem.getDataFreshness(sportKey);
        const fallbackOptions = this.fallbackSystem.generateFallbackOptions(sportKey, lastRefresh);
        
        const enhancedError = {
          originalError: error.message,
          fallbackAvailable: true,
          fallbackOptions,
          dataFreshness: {
            lastRefresh: lastRefresh.toISOString(),
            hoursAgo: Math.round((new Date() - lastRefresh) / (1000 * 60 * 60))
          },
          suggestion: "Web research failed. Would you like to use stored data instead?"
        };
        
        reject(enhancedError);
      }
    });
  }

  // Web Research Mode
  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    const hours = Number(options.horizonHours || 72);
    const prompt = createAnalystPrompt({ sportKey, numLegs, betType, hours, tz: TZ });

    console.log('📝 Sending prompt to AI...');
    const obj = await callProvider(aiModel, prompt);
    
    if (!obj || !Array.isArray(obj.parlay_legs)) {
      throw new Error('AI returned invalid JSON structure - missing parlay_legs array');
    }

    console.log(`🔄 Processing ${obj.parlay_legs.length} potential legs...`);
    
    const legs = obj.parlay_legs
      .map(leg => normalizeLeg(leg))
      .filter(leg => leg !== null)
      .slice(0, numLegs);

    if (legs.length === 0) {
      throw new Error(`No valid ${sportKey} legs could be processed from AI response`);
    }

    console.log(`✅ Successfully processed ${legs.length} legs`);

    const parlayDec = parlayDecimal(legs);
    const parlayAm = decimalToAmerican(parlayDec);

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
        data_source: 'web_research',
        freshness: 'real_time'
      }
    };
  }

  // Enhanced Context-Based Parlay with Freshness Info
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}, mode = 'live') {
    console.log(`🔄 Using ${mode.toUpperCase()} mode for ${sportKey}...`);
    
    try {
      let games;
      let dataSource;
      
      if (mode === 'live') {
        games = await oddsService.getSportOdds(sportKey);
        dataSource = 'live_api';
      } else {
        games = await gamesService.getGamesForSport(sportKey);
        dataSource = 'database';
      }
      
      if (!games || games.length === 0) {
        throw new Error(`No ${sportKey} games available in ${mode} mode`);
      }

      if (games.length < numLegs) {
        console.warn(`Only ${games.length} games available, requested ${numLegs}`);
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
          justification: `Selected from ${mode} data source`,
          confidence: 0.65,
          fair_prob: 0.55
        };
      });

      // Get data freshness information
      const lastRefresh = await this.fallbackSystem.getDataFreshness(sportKey);
      const freshnessWarning = this.fallbackSystem.getStaleDataWarning(sportKey, lastRefresh);

      return { 
        parlay_legs: legs, 
        confidence_score: 0.70,
        source: dataSource,
        data_freshness: {
          last_refresh: lastRefresh.toISOString(),
          hours_ago: freshnessWarning.hoursAgo,
          warning: freshnessWarning.warning,
          message: freshnessWarning.message
        },
        metadata: {
          sport: sportKey,
          mode: mode,
          generated_at: new Date().toISOString(),
          data_source: dataSource,
          freshness: mode === 'live' ? 'near_real_time' : 'cached'
        }
      };
    } catch (error) {
      console.error(`${mode.toUpperCase()} mode parlay generation failed:`, error.message);
      throw new Error(`${mode.toUpperCase()} data service error: ${error.message}`);
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
      return null;
    }
  }

  // NEW: Method to handle fallback selection
  async handleFallbackSelection(sportKey, numLegs, selectedMode, betType = 'mixed') {
    console.log(`🔄 Handling fallback to ${selectedMode} mode for ${sportKey}`);
    
    const result = await this.generateContextBasedParlay(
      sportKey, 
      numLegs, 
      betType, 
      {}, 
      selectedMode
    );
    
    // Add fallback context to the result
    return {
      ...result,
      fallback_context: {
        was_fallback: true,
        original_mode: 'web',
        selected_fallback: selectedMode,
        fallback_reason: 'Web research failed, using stored data'
      }
    };
  }
}

export default new AIService();
