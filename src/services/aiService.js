// src/services/aiService.js
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import databaseService from './databaseService.js';

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GEMINI_MODEL_CANDIDATES = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-pro-latest'];

async function pickSupportedModel(apiKey, candidates = GEMINI_MODEL_CANDIDATES) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    for (const modelName of candidates) {
      try {
        const m = genAI.getGenerativeModel({ model: modelName });
        await m.generateContent('test');
        return modelName;
      } catch {}
    }
  } catch {}
  return candidates[0];
}

function extractJSON(text) {
  const match = String(text).match(/```json\s*(\{[\s\S]*\})\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {}
  }
  const fallbackMatch = String(text).match(/\{[\s\S]*\}/);
  if(fallbackMatch){
      try {
          return JSON.parse(fallbackMatch[0]);
      } catch {}
  }
  return null;
}

/**
 * **GREATLY IMPROVED ANALYST PROMPT**
 */
function analystPrompt({ sportKey, numLegs, betType, hours, tz }) {
  const sportName = sportKey.replace(/_/g, ' ').toUpperCase();
  const betRule = betType === 'props'
    ? 'Each leg MUST be a Player Prop (e.g., Player Points, Rushing Yards, Strikeouts). Avoid exotic alternates.'
    : 'Legs can be moneyline, spread, total, or player props. Choose the best value.';

  const credibleSources = [
      'Official league websites (e.g., NFL.com, NBA.com, MLB.com)',
      'Major sports media outlets (e.g., ESPN, CBS Sports, Bleacher Report, The Athletic)',
      'Statistical databases (e.g., Pro-Football-Reference, Basketball-Reference)',
      'Team-specific official websites and press releases'
  ];

  return `You are a team of elite sports data scientists and professional handicappers. Your task is to construct a high-confidence, data-driven ${numLegs}-leg parlay for upcoming **${sportName}** games scheduled within the next **${hours} hours**.

**METHODOLOGY:**
1.  **Source Verification:** Identify upcoming fixtures using ONLY verified, official sources. Cross-reference schedules from league sites (e.g., NFL.com) and major sports media (e.g., ESPN). Do not use odds aggregators for fixture lists.
2.  **Deep Analysis:** For each potential leg, perform a deep analysis using a wide range of credible sources (${credibleSources.join(', ')}). Synthesize data on team form, player statistics, historical matchups, injuries, and tactical considerations. All claims in your justification must be attributable to these sources.
3.  **Market Evaluation:** For each chosen pick, you must cross-shop the odds at a minimum of five major U.S. sportsbooks: **FanDuel, DraftKings, BetMGM, Caesars, and ESPN BET**.
4.  **Quantitative & Qualitative Synthesis:** Your final pick for each leg must be a synthesis of both quantitative data (stats, trends) and qualitative factors (matchup dynamics, recent news). Your justification must reflect this.

**OUTPUT REQUIREMENTS:**
You must return ONLY a single, valid JSON object with no markdown formatting or extra text. The structure must be exactly as follows:

{
  "parlay_legs": [
    {
      "game": "Away Team @ Home Team",
      "pick": "Full pick description (e.g., 'Kansas City Chiefs -6.5', 'LeBron James Over 25.5 Points')",
      "market": "spread",
      "best_quote": {
        "book": "FanDuel",
        "american": -110,
        "decimal": 1.91
      },
      "justification": "A detailed, data-backed paragraph citing specific stats, trends, and verifiable sources. (e.g., 'The Chiefs have covered the spread in 4 of their last 5 road games, and their offense ranks 1st in DVOA against top-10 defenses, per Football Outsiders. The Broncos will be without their starting QB, confirmed via ESPN injury reports.')",
      "confidence": 0.85
    }
  ],
  "confidence_score": 0.88,
  "sources": [
    "https://www.nfl.com/schedules/",
    "https://www.espn.com/nfl/injuries",
    "https://www.pro-football-reference.com/teams/kan/2025.htm"
  ]
}

**RULES:**
- ${betRule}
- The \`game\` field must be the exact "Away Team @ Home Team" format.
- The \`pick\` must be explicit and unambiguous.
- All URLs in the \`sources\` array must be real and verifiable.
`;
}

// NEW: Expanded game fetching across multiple sports for web mode
async function fetchMultipleSportsGames(primarySportKey, numLegs) {
  const allSports = await databaseService.getDistinctSports();
  const sportsToTry = [primarySportKey];
  
  const sportFamilies = {
    americanfootball_nfl: ['americanfootball_ncaaf'],
    americanfootball_ncaaf: ['americanfootball_nfl'],
    basketball_nba: ['basketball_wnba', 'basketball_ncaab'],
    basketball_wnba: ['basketball_nba'],
    baseball_mlb: ['baseball_ncaa'],
  };
  
  if (sportFamilies[primarySportKey]) {
    sportsToTry.push(...sportFamilies[primarySportKey]);
  }
  
  const gamePromises = sportsToTry.map(key => gamesService.getGamesForSport(key));
  const allGames = (await Promise.all(gamePromises)).flat();
  
  return allGames.slice(0, numLegs * 5); // Increased game context
}

class AIService {
  async validateOdds(oddsData) {
    if (!oddsData || oddsData.length === 0) return { valid: false, message: 'No odds data' };
    return { valid: true };
  }

  async generateParlay(sportKey, numLegs, mode = 'web', aiModel = 'gemini', betType = 'mixed', options = {}) {
    console.log(`AI Service: Using ${mode === 'web' ? (aiModel === 'perplexity' ? 'Perplexity' : 'Gemini') : 'Context-Based'} mode for ${betType}.`);

    if (mode === 'web') {
      return this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options);
    } else {
      return this.generateContextBasedParlay(sportKey, numLegs, betType, options);
    }
  }

  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    try {
      const prompt = analystPrompt({
        sportKey,
        numLegs,
        betType,
        hours: 48,
        tz: env.TIMEZONE || 'America/New_York'
      });

      let responseText;
      if (aiModel === 'perplexity') {
        const resp = await axios.post(
          'https://api.perplexity.ai/chat/completions',
          {
            model: 'sonar-pro',
            messages: [
              { role: 'system', content: 'You are an elite sports data scientist. You will only respond with a single, valid JSON object.' },
              { role: 'user', content: prompt }
            ],
          },
          { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 60000 }
        );
        responseText = resp?.data?.choices?.[0]?.message?.content || '{}';
      } else {
        const modelName = await pickSupportedModel(env.GOOGLE_GEMINI_API_KEY);
        const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        const result = await model.generateContent(prompt);
        responseText = result.response.text();
      }

      const parsed = extractJSON(responseText);
      if (!parsed || !parsed.parlay_legs) {
        throw new Error('AI returned invalid JSON structure');
      }

      // **YOUR ORIGINAL FUZZY MATCHING LOGIC IS PRESERVED HERE**
      // Match AI picks to actual games to ground the response
      const gamesList = await fetchMultipleSportsGames(sportKey, numLegs);
      const matched = [];
      for (const leg of parsed.parlay_legs) {
        const found = this.findBestGameMatch(leg.game, gamesList);
        if (found) {
          matched.push({
            ...leg,
            game: `${found.away_team} @ ${found.home_team}`,
            game_date_utc: found.commence_time,
          });
        } else {
          // If no fuzzy match, trust the AI's game string but log it
          console.warn(`[AI Game String] Could not fuzzy match "${leg.game}". Using AI-provided string.`);
          matched.push(leg);
        }
      }

      if (matched.length === 0) {
        throw new Error('No valid picks could be generated and matched.');
      }
      
      parsed.parlay_legs = matched;
      return parsed;

    } catch (error) {
      console.error('Web research parlay error:', error);
      throw error;
    }
  }
  
  // **YOUR ORIGINAL FUZZY MATCHING FUNCTION IS PRESERVED HERE**
  findBestGameMatch(aiGameString, gamesList) {
    if (!gamesList || gamesList.length === 0) return null;
    
    const normalize = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const aiNorm = normalize(aiGameString);
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const game of gamesList) {
      const gameStr = `${game.away_team} @ ${game.home_team}`;
      const gameNorm = normalize(gameStr);
      
      const aiTokens = new Set(aiNorm.split(/\s+/));
      const gameTokens = new Set(gameNorm.split(/\s+/));
      
      let intersection = 0;
      aiTokens.forEach(token => {
        if (gameTokens.has(token)) {
          intersection++;
        }
      });
      
      const score = intersection / (aiTokens.size + gameTokens.size - intersection); // Jaccard similarity
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = game;
      }
    }
    
    return bestScore > 0.4 ? bestMatch : null; // Require a reasonable similarity score
  }

  // **YOUR ORIGINAL CONTEXT-BASED PARLAY FUNCTION IS PRESERVED HERE**
  async generateContextBasedParlay(sportKey, numLegs, betType, options = {}) {
    try {
      let games = await oddsService.getSportOdds(sportKey);
      if (!games || games.length === 0) {
        games = await gamesService.getGamesForSport(sportKey);
      }

      if (!games || games.length < numLegs) {
        throw new Error(`Not enough games available. Found ${games?.length || 0}, need ${numLegs}`);
      }

      const selected = games.slice(0, numLegs);
      const legs = selected.map(game => {
        const bookmakers = game.bookmakers || game.market_data?.bookmakers || [];
        const market = bookmakers[0]?.markets?.[0];
        const outcome = market?.outcomes?.[0];

        return {
          game: `${game.away_team} @ ${game.home_team}`,
          pick: outcome?.name || game.away_team,
          market: market?.key || 'moneyline',
          best_quote: {
            book: bookmakers[0]?.title || 'DraftKings',
            american: outcome?.price || -110
          },
          game_date_utc: game.commence_time,
          justification: 'Selected based on current market data and availability'
        };
      });

      return {
        parlay_legs: legs,
        confidence_score: 0.70
      };
    } catch (error) {
      console.error('Context parlay error:', error);
      throw error;
    }
  }
}

export default new AIService();
