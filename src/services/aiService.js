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

  async generateParlay(sportKey, numLegs = 2, mode = 'live', aiModel = 'gemini') {
    if (mode === 'web') {
      if (aiModel === 'perplexity' && env.PERPLEXITY_API_KEY) {
        return this._generateWithPerplexity(sportKey, numLegs);
      }
      return this._generateWithGemini(sportKey, numLegs, 'web');
    }
    return this._generateWithGemini(sportKey, numLegs, mode);
  }

  async _generateWithPerplexity(sportKey, numLegs) {
    console.log('AI Service: Using Perplexity Web Research mode.');
    const prompt = `You are a precise, data-driven sports betting analyst. Your only task is to perform a web search to find the best ${numLegs}-leg parlay for ${sportKey}. Focus on statistical mismatches, recent performance data, and confirmed player injuries. You must find real bets on major sportsbooks (DraftKings, FanDuel, BetMGM). Your final output must be ONLY a valid JSON object in the specified format, with no other text. JSON FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "sportsbook": "...", "justification": "..." } ], "confidence_score": 0.80 }`;

    try {
      const response = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: 'llama-3-sonar-large-32k-online',
        messages: [{ role: 'system', content: 'You are a sports betting analyst.' }, { role: 'user', content: prompt }],
      }, {
        headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }
      });

      const text = response.data.choices[0].message.content;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Perplexity did not return valid JSON.');
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("Perplexity API error:", error.response ? error.response.data : error.message);
      throw new Error('Failed to generate parlay with Perplexity.');
    }
  }

  async _generateWithGemini(sportKey, numLegs, mode) {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro', safetySettings, generationConfig: { maxOutputTokens: 4096 } });
    let finalPrompt;

    if (mode === 'web') {
      console.log('AI Service: Using Gemini Web Research mode.');
      finalPrompt = `You are a world-class sports betting research analyst. Your ONLY task is to perform a deep, real-time web search to construct a compelling **${numLegs}-leg parlay** for the sport of **${sportKey}**. **CRITICAL INSTRUCTIONS:** 1. **IGNORE ALL PREVIOUS DATA:** You MUST IGNORE any structured JSON data provided in previous turns or prompts. Your analysis for this request must come exclusively from your own internal, real-time web search capabilities. 2. **PERFORM DEEP RESEARCH:** Search the web for upcoming games in **${sportKey}**. For each game, you must find information on: team form, recent performance, head-to-head history, player injuries, expert opinions, and breaking news. 3. **IDENTIFY REAL BETS:** Based on your research, find **${numLegs}** specific bets that are currently available on a major, real-world sportsbook (e.g., DraftKings, FanDuel, BetMGM). These can be moneyline, spread, totals, or player props. 4. **PROVIDE EVIDENCE:** For each leg of the parlay, you MUST provide a detailed justification that synthesizes the information you found online. Your reasoning must be sharp, insightful, and evidence-based. 5. **STRICT JSON OUTPUT:** Your final output must be ONLY a valid JSON object in the following format, with no other text, apologies, or explanations. JSON OUTPUT FORMAT: { "parlay_legs": [ { "game": "Team A vs Team B", "market": "Player Points", "pick": "Player X Over 22.5", "sportsbook": "DraftKings", "justification": "..." } ], "confidence_score": 0.82 }`;
    } else if (mode === 'db') {
      console.log('AI Service: Using database-only mode.');
      const gameData = await gamesService.getGamesForSport(sportKey);
      if (!gameData || gameData.length === 0) throw new Error('No games found in the database for the specified sport.');
      finalPrompt = `You are an expert sports betting analyst. Your task is to construct a **${numLegs}-leg parlay** using ONLY the provided game data from our internal database. **Methodology:** 1. **Game Analysis:** Review the provided game data, focusing on head-to-head (h2h) and spreads odds. 2. **Parlay Construction:** Select exactly **${numLegs} legs** for the parlay from the available markets (h2h, spreads). 3. **Justification and Formatting:** Provide a detailed justification for each leg based on the odds. Your final output must be ONLY a valid JSON object. JSON OUTPUT FORMAT: { "parlay_legs": [{"game": "...", "market": "...", "pick": "...", "justification": "..."}], "confidence_score": 0.75 } **Game Data from Database:** \`\`\`json\n${JSON.stringify(gameData.slice(0, 15), null, 2)}\n\`\`\``;
    } else { // 'live' mode
      console.log('AI Service: Using live API mode.');
      const liveGames = await oddsService.getSportOdds(sportKey);
      if (!liveGames || liveGames.length === 0) throw new Error('Could not fetch live odds for the specified sport.');
      const enrichedGames = await Promise.all(liveGames.slice(0, 10).map(async (game) => {
          const playerProps = await oddsService.getPlayerPropsForGame(sportKey, game.id);
          return { ...game, player_props: playerProps };
      }));
      finalPrompt = `You are an expert sports betting analyst. Your task is to construct a **${numLegs}-leg parlay** from the provided game data. **Methodology:** 1. **Initial Game Analysis:** Review head-to-head (h2h) odds and spreads. 2. **Deep Dive into Player Props:** Scrutinize player props data for value. 3. **Cross-Correlation:** Correlate player performance with game outcomes. 4. **Parlay Construction:** Select exactly **${numLegs} legs**. 5. **Justification and Formatting:** Provide a detailed justification for each leg. Your final output must be ONLY a valid JSON object. JSON OUTPUT FORMAT: { "parlay_legs": [ { "game": "...", "market": "...", "pick": "...", "justification": "..." } ], "confidence_score": 0.85 } **Live Game and Player Prop Data:** \`\`\`json\n${JSON.stringify(enrichedGames, null, 2)}\n\`\`\``;
    }

    try {
      const result = await model.generateContent(finalPrompt);
      const response = await result.response;
      const text = response.text();
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanJson);
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
      return JSON.parse(response.text());
    } catch (error) {
      console.error('AI validation error:', error);
      return { valid: false };
    }
  }
}

export default new AIService();
