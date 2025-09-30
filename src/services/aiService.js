// src/services/aiService.js
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';
import databaseService from './databaseService.js'; // NEW

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
  const patterns = [
    /``````/i,
    /``````/,
    /\{[\s\S]*\}/
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1] || match[0]);
      } catch {}
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// NEW: Expanded game fetching across multiple sports for web mode
async function fetchMultipleSportsGames(primarySportKey, numLegs) {
  const allSports = await databaseService.getDistinctSports();
  const sportsToTry = [primarySportKey];
  
  // Add related sports for variety
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
  
  // Fetch games from all relevant sports
  const gamePromises = sportsToTry.map(async (key) => {
    try {
      return await gamesService.getGamesForSport(key);
    } catch {
      return [];
    }
  });
  
  const allGames = (await Promise.all(gamePromises)).flat();
  
  // Return up to numLegs * 3 games for variety
  return allGames.slice(0, numLegs * 3);
}

class AIService {
  async validateOdds(oddsData) {
    if (!oddsData || oddsData.length === 0) return { valid: false, message: 'No odds data' };
    return { valid: true };
  }

  async generateParlay(sportKey, numLegs, mode = 'web', aiModel = 'gemini', betType = 'mixed', options = {}) {
    console.log(`AI Service: Using ${mode === 'web' ? (aiModel === 'perplexity' ? 'Perplexity' : 'Gemini') : mode} Web Research for ${betType}.`);

    if (mode === 'web') {
      return this.generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options);
    } else {
      return this.generateContextBasedParlay(sportKey, numLegs, betType, options);
    }
  }

  async generateWebResearchParlay(sportKey, numLegs, aiModel, betType, options = {}) {
    try {
      // Fetch broader game set for better matching
      const gamesList = await fetchMultipleSportsGames(sportKey, numLegs);
      
      if (!gamesList || gamesList.length === 0) {
        throw new Error('No games available for the selected sport');
      }

      // Build comprehensive game context with clearer team names
      const gamesContext = gamesList.map(g => {
        const awayTeam = g.away_team || 'Unknown';
        const homeTeam = g.home_team || 'Unknown';
        return `${awayTeam} @ ${homeTeam} (${new Date(g.commence_time).toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/New_York'
        })})`;
      }).join('\n');

      const prompt = `You are a professional sports analyst. Generate a ${numLegs}-leg parlay for ${sportKey.replace(/_/g, ' ')} with ONLY games from this exact list:

${gamesContext}

CRITICAL RULES:
1. Use ONLY games from the list above - use the EXACT team names as written
2. For each pick, specify the exact matchup using the format "Team A @ Team B"
3. Include detailed justification based on current stats, trends, injuries, and recent performance
4. Return valid JSON with this exact structure:

{
  "parlay_legs": [
    {
      "game": "Away Team @ Home Team",
      "pick": "Team Name or Over/Under X.5",
      "market": "moneyline OR spread OR totals OR player_props",
      "justification": "detailed reasoning with stats and trends",
      "confidence": 0.75
    }
  ],
  "confidence_score": 0.80
}

Focus on ${betType === 'props' ? 'player props only' : 'any bet type including spreads, totals, and moneylines'}.`;

      let responseText;
      if (aiModel === 'perplexity') {
        const resp = await axios.post(
          'https://api.perplexity.ai/chat/completions',
          {
            model: 'sonar-pro',
            messages: [
              { role: 'system', content: 'You are a professional sports analyst. Return only valid JSON. No markdown, no extra text.' },
              { role: 'user', content: prompt }
            ],
          },
          { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 45000 }
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

      // Match AI picks to actual games with fuzzy matching
      const matched = [];
      for (const leg of parsed.parlay_legs) {
        const found = this.findBestGameMatch(leg.game, gamesList);
        if (found) {
          matched.push({
            ...leg,
            game: `${found.away_team} @ ${found.home_team}`,
            game_date_utc: found.commence_time,
            sportsbook: 'Multiple Books'
          });
        } else {
          console.warn(`[AI Hallucination] Unmatched leg discarded: ${leg.game}`);
        }
      }

      if (matched.length === 0) {
        throw new Error('No valid picks could be matched to available games');
      }

      return {
        parlay_legs: matched,
        confidence_score: parsed.confidence_score || 0.75
      };

    } catch (error) {
      console.error('Web research parlay error:', error);
      throw error;
    }
  }

  // NEW: Fuzzy game matching to reduce hallucination warnings
  findBestGameMatch(aiGameString, gamesList) {
    const normalize = (str) => String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
    const aiNorm = normalize(aiGameString);
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const game of gamesList) {
      const gameStr = `${game.away_team} @ ${game.home_team}`;
      const gameNorm = normalize(gameStr);
      
      // Calculate similarity score
      let score = 0;
      const aiTokens = aiNorm.split(/\s+/);
      const gameTokens = gameNorm.split(/\s+/);
      
      for (const token of aiTokens) {
        if (gameTokens.some(gt => gt.includes(token) || token.includes(gt))) {
          score += 1;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = game;
      }
    }
    
    // Require at least 50% token match
    return bestScore >= aiNorm.split(/\s+/).length * 0.5 ? bestMatch : null;
  }

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
          odds: outcome?.price || -110,
          game_date_utc: game.commence_time,
          sportsbook: bookmakers[0]?.title || 'DraftKings',
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
