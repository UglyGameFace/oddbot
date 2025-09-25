// src/services/aiService.js - PROVEN AI INTEGRATION FOR ALL SPORTS
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import env from '../config/env.js';
import sentryService from './sentryService.js';

class ProvenAIService {
  constructor() {
    this.gemini = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);
    this.geminiModel = this.gemini.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
    });
    console.log('✅ Proven AI Service Initialized (Gemini + Perplexity).');
  }
  
  // --- NEW FUNCTION for AI-Driven Correlation ---
  /**
   * Uses AI to determine a narrative or contextual correlation between two games.
   * @param {object} gameA - The first game object.
   * @param {object} gameB - The second game object.
   * @returns {Promise<object>} An object containing the correlation and reasoning.
   */
  async getNarrativeCorrelation(gameA, gameB) {
    const prompt = `
      As a quantitative sports analyst, assess the narrative and contextual correlation between the following two sporting events. Consider factors like player rivalries, coaching connections, divisional momentum, market sentiment, and significant media narratives.

      Game 1: ${gameA.sport_title} - ${gameA.home_team} vs ${gameA.away_team}
      Game 2: ${gameB.sport_title} - ${gameB.home_team} vs ${gameB.away_team}

      Provide a correlation score between -1.0 and 1.0, where 1.0 is a strong positive correlation (if one wins, the other is likely to win), -1.0 is a strong negative correlation, and 0.0 is no meaningful connection.

      Your response MUST be ONLY a single, valid JSON object with the following structure:
      {
        "correlation": number,
        "reasoning": "A brief, expert justification for your score."
      }
    `;
    
    try {
      const result = await this.geminiModel.generateContent(prompt);
      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { correlation: 0, reasoning: "AI failed to produce valid JSON." };
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
        sentryService.captureError(error, { component: 'ai_correlation' });
        console.error('AI correlation analysis failed:', error.message);
        return { correlation: 0, reasoning: "AI service request failed." };
    }
  }

  async generateParlayAnalysis(userContext, gamesData, strategy = 'balanced') {
    const prompt = this.buildComprehensiveParlayPrompt(userContext, gamesData, strategy);
    try {
      let analysisText;
      try {
        console.log('Attempting to generate analysis with Gemini...');
        const result = await this.geminiModel.generateContent(prompt);
        analysisText = result.response.text();
      } catch (geminiError) {
        console.warn(`Gemini generation failed: ${geminiError.message}. Falling back to Perplexity.`);
        sentryService.captureError(geminiError, { component: 'ai_service', model: 'gemini', fallback: true });
        analysisText = await this.generateWithPerplexity(prompt);
      }
      return this.parseAIResponse(analysisText);
    } catch (error) {
      sentryService.captureError(error, { component: 'ai_service' });
      console.error('FATAL: All AI providers failed.');
      throw new Error('AI analysis is currently unavailable.');
    }
  }

  async generateWithPerplexity(prompt) {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: 'You are an expert sports betting analyst. Your response must be only a single, valid JSON object.' },
          { role: 'user', content: prompt },
        ],
      },
      {
        headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` },
        timeout: 30000,
      }
    );
    return response.data.choices[0].message.content;
  }
  
  parseAIResponse(responseText) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in AI response.');
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      sentryService.captureError(error, { component: 'ai_parsing', context: { responseText } });
      throw new Error('Failed to parse the AI-generated analysis.');
    }
  }

  buildComprehensiveParlayPrompt(userContext, gamesData, strategy) {
    const gameInfo = gamesData.slice(0, 25).map(g => `${g.sport_title}: ${g.home_team} vs ${g.away_team}`).join('; ');
    return `
      Analyze the provided games and construct a 3-leg parlay based on the user's profile and the specified strategy.

      User Profile:
      - Risk Tolerance: ${userContext.riskTolerance || 'medium'}
      - Preferred Sports: ${userContext.preferredSports?.join(', ') || 'any'}

      Strategy: "${strategy}"
      - 'balanced': A mix of reasonably safe picks with good value.
      - 'highprobability': Focus on the safest possible picks, even with lower odds.
      - 'lottery': High-risk, high-reward picks with very high odds.

      Available Games (sample): ${gameInfo}

      Your response MUST be a single, valid JSON object with the following structure:
      {
        "parlay": {
          "legs": [
            { "sport": "NFL", "teams": "Team A vs Team B", "selection": "Team A -3.5", "odds": -110, "reasoning": "Brief justification." },
            { "sport": "NBA", "teams": "Team C vs Team D", "selection": "Over 220.5", "odds": -110, "reasoning": "Brief justification." }
          ],
          "total_odds": 264,
          "risk_assessment": "Medium"
        },
        "analysis": {
          "strengths": ["Good value on leg 3", "Strong statistical backing for leg 1"],
          "recommendation": "VALUE PLAY"
        }
      }
    `;
  }
}

export default new ProvenAIService();
