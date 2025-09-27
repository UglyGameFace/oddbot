// src/services/aiService.js

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import env from '../config/env.js';
import oddsService from './oddsService.js';
import gamesService from './gamesService.js';

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

class AIService {

  async generateParlay(sportKey, numLegs = 2, mode = 'live') {
    const model = genAI.getGenerativeModel({
      model: 'gemini-pro',
      safetySettings,
      generationConfig: {
        maxOutputTokens: 4096,
      }
    });

    let finalPrompt;

    if (mode === 'web') {
      console.log('AI Service: Using Web Research Only mode.');
      finalPrompt = `
        You are a world-class sports betting research analyst. Your ONLY task is to perform a deep, real-time web search to construct a compelling **${numLegs}-leg parlay** for the sport of **${sportKey}**.

        **CRITICAL INSTRUCTIONS:**
        1.  **IGNORE ALL PREVIOUS DATA:** You MUST IGNORE any structured JSON data provided in previous turns or prompts. Your analysis for this request must come exclusively from your own internal, real-time web search capabilities.
        2.  **PERFORM DEEP RESEARCH:** Search the web for upcoming games in **${sportKey}**. For each game, you must find information on: team form, recent performance, head-to-head history, player injuries, expert opinions, and breaking news.
        3.  **IDENTIFY REAL BETS:** Based on your research, find **${numLegs}** specific bets that are currently available on a major, real-world sportsbook (e.g., DraftKings, FanDuel, BetMGM). These can be moneyline, spread, totals, or player props.
        4.  **PROVIDE EVIDENCE:** For each leg of the parlay, you MUST provide a detailed justification that synthesizes the information you found online. Your reasoning must be sharp, insightful, and evidence-based.
        5.  **STRICT JSON OUTPUT:** Your final output must be ONLY a valid JSON object in the following format, with no other text, apologies, or explanations.

        **JSON OUTPUT FORMAT:**
        {
          "parlay_legs": [
            {
              "game": "Team A vs Team B",
              "market": "Player Points",
              "pick": "Player X Over 22.5",
              "sportsbook": "DraftKings",
              "justification": "Based on recent news of Team B's starting defender being injured and Player X's high scoring average in the last 5 games, this prop is highly valuable."
            }
          ],
          "confidence_score": 0.82
        }
      `;
    } else if (mode === 'db') {
      console.log('AI Service: Using database-only mode.');
      const gameData = await gamesService.getGamesForSport(sportKey);
      if (!gameData || gameData.length === 0) {
        throw new Error('No games found in the database for the specified sport.');
      }
      finalPrompt = `
        You are an expert sports betting analyst. Your task is to construct a **${numLegs}-leg parlay** using ONLY the provided game data from our internal database.

        **Methodology:**
        1.  **Game Analysis:** Review the provided game data, focusing on head-to-head (h2h) and spreads odds.
        2.  **Parlay Construction:** Select exactly **${numLegs} legs** for the parlay from the available markets (h2h, spreads).
        3.  **Justification and Formatting:** Provide a detailed justification for each leg based on the odds. Your final output must be ONLY a valid JSON object in the format specified below.

        **JSON OUTPUT FORMAT:**
        {
          "parlay_legs": [{"game": "...", "market": "...", "pick": "...", "justification": "..."}],
          "confidence_score": 0.75
        }

        **Game Data from Database:**
        \`\`\`json
        ${JSON.stringify(gameData.slice(0, 15), null, 2)}
        \`\`\`
      `;
    } else { // Default to 'live'
      console.log('AI Service: Using live API mode.');
      const liveGames = await oddsService.getSportOdds(sportKey);
      if (!liveGames || liveGames.length === 0) {
        throw new Error('Could not fetch live odds for the specified sport.');
      }

      const enrichedGames = await Promise.all(liveGames.slice(0, 10).map(async (game) => {
          const playerProps = await oddsService.getPlayerPropsForGame(sportKey, game.id);
          return { ...game, player_props: playerProps };
      }));
      
      finalPrompt = `
        You are an expert sports betting analyst with 20 years of experience in quantitative and qualitative analysis. Your task is to construct a **${numLegs}-leg parlay** from the provided game data. You must follow a strict, evidence-based methodology.

        **Methodology:**
        1.  **Initial Game Analysis:** Review the provided game data, including head-to-head (h2h) odds, spreads, and commence times.
        2.  **Deep Dive into Player Props:** For the games you've shortlisted, scrutinize the player props data. Look for star players, favorable matchups, and prop bets that seem statistically probable.
        3.  **Cross-Correlation:** Correlate player performance with game outcomes.
        4.  **Parlay Construction:** Select exactly **${numLegs} legs** for the parlay. The legs can be a mix of moneyline (h2h), spreads, or player props.
        5.  **Justification and Formatting:** You MUST provide a detailed justification for each leg, citing specific data points from the provided JSON. Your final output must be ONLY a valid JSON object.

        **JSON OUTPUT FORMAT:**
          {
            "parlay_legs": [
              {
                "game": "Team A vs Team B",
                "market": "Moneyline or Player Points",
                "pick": "Team A",
                "justification": "Detailed reason citing player props, h2h odds, or other data."
              }
            ],
            "confidence_score": 0.85
          }

        **Live Game and Player Prop Data:**
        \`\`\`json
        ${JSON.stringify(enrichedGames, null, 2)}
        \`\`\`
      `;
    }

    try {
      const result = await model.generateContent(finalPrompt);
      const response = await result.response;
      const text = response.text();
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanJson);
    } catch (error) {
      console.error(`AI parlay generation error in ${mode} mode:`, error);
      throw new Error(`Failed to generate AI parlay using ${mode} mode.`);
    }
  }

    async validateOdds(oddsData) {
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const prompt = `Validate the following sports odds data. Is it structured correctly and are the values plausible? Respond with only a JSON object: {"valid": true/false, "reason": "..."}\n\n${JSON.stringify(oddsData)}`;
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            return JSON.parse(text);
        } catch (error) {
            console.error('AI validation error:', error);
            return { valid: false, reason: 'AI validation failed' };
        }
    }
}

export default new AIService();
