// src/services/aiService.js - INSTITUTIONAL AI ENGINE WITH ADVANCED PROMPT ENGINEERING

import axios from 'axios';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class AdvancedAIService {
  constructor() {
    // We will primarily use Perplexity for its excellent web search capabilities.
    this.PPLX_API_URL = 'https://api.perplexity.ai/chat/completions';
    console.log('✅ Advanced AI Service Initialized (Perplexity Sonar-Pro).');
  }

  /**
   * Parses the raw text response from the AI, expecting a valid JSON object.
   * This is a critical step and includes robust error handling.
   */
  parseAIResponse(responseText) {
    try {
      // Find the first '{' and the last '}' to extract the JSON object
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in the AI response.');
      }
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      sentryService.captureError(error, { component: 'ai_parsing', context: { responseText } });
      console.error("AI Response Text that Failed Parsing:", responseText);
      throw new Error('The AI returned a malformed analysis. Could not parse the result.');
    }
  }

  /**
   * The master function that takes user configuration and available games to build the best possible parlay.
   * @param {object} options - The user's desired configuration.
   * @param {Array} gamesData - A list of available games from the odds service.
   * @returns {Promise<object>} The fully analyzed parlay object from the AI.
   */
  async buildAIParlay(options, gamesData) {
    const prompt = this.createMasterPrompt(options, gamesData);
    
    try {
      const response = await axios.post(
        this.PPLX_API_URL,
        {
          model: 'sonar-pro', // Using the most powerful online model
          messages: [
            { role: 'system', content: 'You are a world-class sports betting analyst and quantitative expert. Your analysis is sharp, data-driven, and insightful. You MUST respond ONLY with a single, valid JSON object and nothing else.' },
            { role: 'user', content: prompt },
          ],
        },
        {
          headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` },
          timeout: 90000, // 90-second timeout for complex analysis
        }
      );
      const analysisText = response.data.choices[0].message.content;
      return this.parseAIResponse(analysisText);
    } catch (error) {
      sentryService.captureError(error, { component: 'ai_build_parlay' });
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      console.error('FATAL: AI Parlay generation failed:', errorMessage);
      throw new Error(`AI analysis is currently unavailable. Reason: ${errorMessage}`);
    }
  }

  /**
   * Creates the state-of-the-art prompt for the AI model.
   */
  createMasterPrompt(options, gamesData) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const gameInfo = gamesData.slice(0, 50) // Provide a healthy sample of games
        .map(g => `${g.sport_title}: ${g.home_team} vs ${g.away_team} (ID: ${g.id})`)
        .join('; ');

    const strategyDescription = {
        highprobability: "Focus on selections with the highest statistical probability of success, even if the odds are lower (e.g., heavy moneyline favorites, safer spread covers). Prioritize capital preservation.",
        balanced: "Seek out 'value' bets where the odds seem favorable relative to the true probability. This includes underdogs with a strong chance to win, or spreads/totals where the market may have misjudged the line. A good mix of risk and reward.",
        lottery: "Construct a high-risk, high-reward parlay. Focus on correlated picks, significant underdogs, or difficult prop bets that could lead to a massive payout. This is a speculative play."
    };

    // --- THE MASTER PROMPT ---
    return `
      As a world-class sports betting analyst and quantitative expert, your task is to construct the most optimal and well-researched parlay based on my request and real-time, online data. Today is ${today}.

      **MY REQUEST:**
      - **Number of Legs:** ${options.legs}
      - **Risk Strategy:** "${options.strategy}" (${strategyDescription[options.strategy]})
      - **Sports Focus:** ${options.sportsFocus}
      - **Include Player Props:** ${options.includeProps ? 'Yes, find the best available prop bets.' : 'No, focus only on game outcomes (Moneyline, Spreads, Totals).'}
      - **Target Sportsbooks:** Primarily DraftKings and FanDuel. Your odds and line choices should reflect what's commonly available there.

      **YOUR TASK & METHODOLOGY:**
      1.  **Deep Research:** For each potential leg, perform a deep dive using real-time online sources (ESPN, official league stats, reputable sports analytics sites). Analyze recent team form, head-to-head matchups, key player injuries, weather conditions, betting trends, and line movements.
      2.  **Quantitative Edge:** Identify a clear, data-driven edge for every single pick. Do not guess. State your justification with specific stats or trends.
      3.  **Player Prop Analysis (If Requested):** If I want player props, find players with favorable matchups. Analyze their recent performance (e.g., last 5 games), usage rates, and opponent's defensive weaknesses. Justify props like "Over 25.5 points" or "Anytime Touchdown Scorer" with hard data.
      4.  **Parlay Construction:** Select the ${options.legs} best picks that align with my chosen risk strategy. If possible, find correlated legs to maximize upside (e.g., a star QB's passing yards 'Over' correlated with his team winning).
      5.  **Odds & Lines:** Provide odds in American format. Be realistic about the lines available on major sportsbooks like DraftKings or FanDuel.

      **AVAILABLE GAMES SAMPLE (use these as a starting point, but search for others if needed):**
      ${gameInfo}

      **MANDATORY OUTPUT FORMAT:**
      Your entire response MUST be a single, valid JSON object. Do not include any text before or after the JSON.

      {
        "parlay": {
          "title": "High-Probability NFL/NBA Lock Parlay",
          "total_legs": ${options.legs},
          "total_odds": 0,
          "strategy": "${options.strategy}",
          "overall_narrative": "A brief, compelling story for why this parlay makes sense as a whole.",
          "legs": [
            {
              "leg_number": 1,
              "sport": "NFL",
              "game": "Kansas City Chiefs vs. Buffalo Bills",
              "market_type": "Player Props",
              "selection": "Patrick Mahomes Over 285.5 Passing Yards",
              "odds": -115,
              "justification": "Mahomes has exceeded this line in 4 of his last 5 games. The Bills' pass defense is ranked 25th in the league, and this game has the highest projected total of the week, suggesting a shootout.",
              "confidence_score": 8.5
            },
            {
              "leg_number": 2,
              "sport": "NBA",
              "game": "Los Angeles Lakers vs. Boston Celtics",
              "market_type": "Spread",
              "selection": "Boston Celtics -4.5",
              "odds": -110,
              "justification": "The Celtics have the #1 net rating at home this season and are 8-2 against the spread in their last 10 games. The Lakers are on the second night of a back-to-back and have a high turnover rate.",
              "confidence_score": 8.0
            }
          ]
        }
      }
    `;
  }
}

export default new AdvancedAIService();

