// src/services/aiService.js - INSTITUTIONAL AI ENGINE WITH ROBUST PARSER & SPECIALIZED FUNCTIONS

import axios from 'axios';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class AdvancedAIService {
  constructor() {
    this.PPLX_API_URL = 'https://api.perplexity.ai/chat/completions';
    console.log('✅ Advanced AI Service Initialized (Perplexity Sonar-Pro).');
  }

  /**
   * Sanitizes and parses the raw text response from the AI.
   * FIX: Cleans common formatting errors (like '+' in numbers) before parsing.
   */
  sanitizeAndParseAIResponse(responseText) {
    try {
      let cleanText = responseText;
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in the AI response.');
      cleanText = jsonMatch[0];
      cleanText = cleanText.replace(/:\s*\+([0-9])/g, ': $1');
      return JSON.parse(cleanText);
    } catch (error) {
      sentryService.captureError(error, { component: 'ai_parsing', context: { responseText } });
      console.error("AI Response Text that Failed Parsing:", responseText);
      throw new Error('The AI returned a malformed analysis.');
    }
  }

  /**
   * Main function to build a complete parlay based on user strategy.
   */
  async buildAIParlay(options, gamesData) {
    const prompt = this.createMasterPrompt(options, gamesData);
    try {
      const response = await axios.post(
        this.PPLX_API_URL,
        {
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a world-class sports betting analyst. Your response MUST be ONLY a single, valid JSON object.' },
            { role: 'user', content: prompt },
          ],
        },
        { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 90000 }
      );
      return this.sanitizeAndParseAIResponse(response.data.choices[0].message.content);
    } catch (error) {
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      sentryService.captureError(error, { component: 'ai_build_parlay', context: { errorMessage } });
      throw new Error(`AI analysis failed: ${errorMessage}`);
    }
  }

  /**
   * NEW: Specialized function to find available player props.
   */
  async findPlayerProps(playerName) {
    const prompt = `
      As a sports betting prop specialist, your task is to find all commonly available player prop bets for "${playerName}" in their next upcoming game.
      1.  First, identify the player's team and their next scheduled game.
      2.  Using real-time online sources, find the most common prop lines available on DraftKings or FanDuel for this player.
      3.  Focus on major categories: Points, Rebounds, Assists (NBA); Passing/Rushing/Receiving Yards, Touchdowns (NFL); Shots on Goal (NHL), etc.

      MANDATORY OUTPUT FORMAT:
      Your entire response MUST be a single, valid JSON object.

      {
        "player_name": "${playerName}",
        "game": "Team A vs. Team B",
        "props": [
          {
            "market": "Points",
            "selection": "${playerName} Over 25.5",
            "odds": -115
          },
          {
            "market": "Assists",
            "selection": "${playerName} Over 8.5",
            "odds": -120
          }
        ]
      }
    `;
    try {
      const response = await axios.post(
        this.PPLX_API_URL,
        { model: 'sonar-pro', messages: [{ role: 'system', content: 'You are a sports betting prop specialist. Respond ONLY with a single, valid JSON object.' },{ role: 'user', content: prompt }] },
        { headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, timeout: 60000 }
      );
      return this.sanitizeAndParseAIResponse(response.data.choices[0].message.content);
    } catch (error) {
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      sentryService.captureError(error, { component: 'ai_find_player_props', context: { errorMessage } });
      throw new Error(`AI prop search failed: ${errorMessage}`);
    }
  }

  createMasterPrompt(options, gamesData) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const gameInfo = gamesData.slice(0, 50).map(g => `${g.sport_title}: ${g.home_team} vs ${g.away_team} (ID: ${g.id})`).join('; ');
    const strategyDescription = {
        highprobability: "Focus on selections with the highest statistical probability of success, even if the odds are lower (e.g., heavy moneyline favorites, safer spread covers). Prioritize capital preservation.",
        balanced: "Seek out 'value' bets where the odds seem favorable relative to the true probability. This includes underdogs with a strong chance to win, or spreads/totals where the market may have misjudged the line.",
        lottery: "Construct a high-risk, high-reward parlay. Focus on correlated picks, significant underdogs, or difficult prop bets that could lead to a massive payout."
    };
    return `
      As a world-class sports betting analyst, your task is to construct the most optimal parlay based on my request and real-time, online data. Today is ${today}.

      **MY REQUEST:**
      - Number of Legs: ${options.legs}
      - Risk Strategy: "${options.strategy}" (${strategyDescription[options.strategy]})
      - Include Player Props: ${options.includeProps ? 'Yes' : 'No'}

      **YOUR TASK:**
      1.  **Deep Research:** Use real-time online sources (ESPN, official league stats) to analyze team form, matchups, injuries, betting trends, and line movements.
      2.  **Quantitative Edge:** Identify a clear, data-driven edge for every pick. State your justification with specific stats.
      3.  **Player Prop Analysis (If Requested):** Find players with favorable matchups. Justify props like "Over 25.5 points" with hard data.
      4.  **Parlay Construction:** Select the ${options.legs} best picks that align with my chosen risk strategy.

      **AVAILABLE GAMES SAMPLE:** ${gameInfo}

      **MANDATORY OUTPUT FORMAT:**
      Your entire response MUST be a single, valid JSON object.

      {
        "parlay": {
          "title": "Data-Driven Value Parlay",
          "total_legs": ${options.legs},
          "strategy": "${options.strategy}",
          "overall_narrative": "A brief, compelling story for why this parlay makes sense as a whole.",
          "legs": [
            {
              "leg_number": 1, "sport": "NFL", "game": "Team A vs. Team B", "market_type": "Player Props",
              "selection": "Player X Over 75.5 Rushing Yards", "odds": -115,
              "justification": "Player X has exceeded this line in 4 of his last 5 games. Team B has the 28th ranked rush defense.", "confidence_score": 8.5
            }
          ]
        }
      }
    `;
  }
}

export default new AdvancedAIService();
