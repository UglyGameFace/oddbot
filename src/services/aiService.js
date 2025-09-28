// src/services/aiService.js

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

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
      // FIX: Corrected the URL by removing markdown formatting.
      const response = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: 'sonar-pro',
        messages: [{ role: 'system', content: 'You are a sports betting analyst.' }, { role: 'user', content: prompt }],
      }, { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` } });

      const text = response.data.choices[0].message.content;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Perplexity did not return valid JSON.');
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("Perplexity API error:", error.message);
      throw new Error('Failed to generate parlay with Perplexity.');
    }
  }

  async _generateWithGemini(sportKey, numLegs, mode, betType) {
    // FIX #1: Corrected model name for this SDK version.
    const model = genAI.getGenerativeModel({ model: 'gemini-1.0-pro', safetySettings, generationConfig: { maxOutputTokens: 4096 } });
    let finalPrompt;

    const betTypeInstruction = betType === 'props'
      ? 'Your parlay must consist exclusively of **Player Prop** bets (e.g., player points, assists, touchdowns, yards).'
      : 'The legs can be a mix of moneyline (h2h), spreads, or player props.';

    if (mode === 'web') {
      console.log(`AI Service: Using Gemini Web Research mode for ${betType}.`);
      finalPrompt = `You are a world-class sports betting research analyst. Your ONLY task is to perform a deep, real-time web search to construct a compelling **${numLegs}-leg parlay** for the sport of **${sportKey}**. **CRITICAL INSTRUCTIONS:** 1. **IGNORE ALL PREVIOUS DATA**. Your analysis must come exclusively from your own real-time web search. 2. **PERFORM DEEP RESEARCH** on team form, injuries, and expert opinions. 3. **IDENTIFY REAL BETS** on a major sportsbook (e.g., DraftKings, FanDuel). ${betTypeInstruction} 4. **PROVIDE EVIDENCE** for each leg. 5. **STRICT JSON OUTPUT:** Your final output must be ONLY a valid JSON object in the following format. JSON FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "sportsbook": "...", "justification": "..." } ], "confidence_score": 0.82 }`;
    } else if (mode === 'db') {
      console.log('AI Service: Using database-only mode.');
      const gameData = await gamesService.getGamesForSport(sportKey);
      if (!gameData || !gameData.length) throw new Error('No games in the database for the specified sport.');
      finalPrompt = `You are an expert sports betting analyst. Your task is to construct a **${numLegs}-leg parlay** using ONLY the provided game data. Your parlay can only contain moneyline (h2h) or spreads. Provide a detailed justification for each leg. Your final output must be ONLY a valid JSON object. JSON FORMAT: { "parlay_legs": [{"game": "...", "market": "...", "pick": "...", "justification": "..."}], "confidence_score": 0.75 } **Game Data from Database:** \`\`\`json\n${JSON.stringify(gameData.slice(0, 15), null, 2)}\n\`\`\``;
    } else { // 'live' mode
      console.log(`AI Service: Using live API mode for ${betType}.`);
      const liveGames = await oddsService.getSportOdds(sportKey);
      if (!liveGames || !liveGames.length) throw new Error('Could not fetch live odds.');
      
      // FIX #2: Changed `g.id` to `g.event_id` to pass the correct identifier.
      const enrichedGames = await Promise.all(liveGames.slice(0, 10).map(async (g) => ({
        ...g,
        player_props: await oddsService.getPlayerPropsForGame(sportKey, g.event_id)
      })));
      
      finalPrompt = `You are an expert sports betting analyst. Construct a **${numLegs}-leg parlay** from the provided game data. ${betTypeInstruction} Provide a detailed justification for each leg. Your final output must be ONLY a valid JSON object. JSON FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "justification": "..." } ], "confidence_score": 0.85 } **Live Game and Player Prop Data:** \`\`\`json\n${JSON.stringify(enrichedGames, null, 2)}\n\`\`\``;
    }

    try {
      const result = await model.generateContent(finalPrompt);
      const response = await result.response;
      const text = response.text();
      // FIX #3: More robust JSON cleaning to handle AI responses that aren't perfect JSON.
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("AI response did not contain a valid JSON object.");
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error(`Gemini parlay generation error in ${mode} mode:`, error);
      throw new Error(`Failed to generate AI parlay using Gemini in ${mode} mode.`);
    }
  }

  async validateOdds(oddsData) {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const prompt = `Is this JSON data structured correctly for sports odds? Respond only with {"valid": true/false}. Data: ${JSON.stringify(oddsData)}`;
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { valid: false };
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('AI validation error:', error);
      return { valid: false };
    }
  }
}

export default new AIService();
