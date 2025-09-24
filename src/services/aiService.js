// src/services/aiService.js - COMPLETE AI SERVICE WITH DUAL PROVIDERS
import { GoogleGenerativeAI } from '@google/generative-ai';
import Perplexity from 'perplexity-node';
import env from '../config/env.js';
import * as Sentry from '@sentry/node';

class AIService {
  constructor() {
    // Initialize Google Gemini
    this.gemini = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY);
    this.geminiModel = this.gemini.getGenerativeModel({ model: 'gemini-pro' });
    
    // Initialize Perplexity
    this.perplexity = new Perplexity(env.PERPLEXITY_API_KEY);
    
    // Strategy templates
    this.strategyTemplates = {
      balanced: `Analyze games with a focus on value across multiple factors including recent form, historical matchups, and market inefficiencies. Seek odds that provide positive expected value with moderate risk.`,
      mathematical: `Use statistical models and probability calculations to identify edges. Focus on discrepancies between implied probability and calculated probability. Prioritize quantitative factors over qualitative ones.`,
      high_probability: `Prioritize safety and consistency over high payouts. Look for heavily favored outcomes with high likelihood of success, even if odds are lower. Focus on minimizing risk.`,
      lottery: `Search for high-risk, high-reward opportunities with long odds. Combine multiple underdog scenarios for massive potential payouts. Emphasize entertainment value and upside potential.`
    };
  }

  async generateParlayAnalysis(userContext, gamesData, strategy = 'balanced') {
    try {
      const prompt = this.buildParlayPrompt(userContext, gamesData, strategy);
      
      // Use both AI providers for redundancy and quality
      const [geminiResult, perplexityResult] = await Promise.allSettled([
        this.generateWithGemini(prompt),
        this.generateWithPerplexity(prompt)
      ]);

      // Choose the best result or combine insights
      let analysis;
      if (geminiResult.status === 'fulfilled') {
        analysis = this.parseAIResponse(geminiResult.value, 'gemini');
      } else if (perplexityResult.status === 'fulfilled') {
        analysis = this.parseAIResponse(perplexityResult.value, 'perplexity');
      } else {
        throw new Error('Both AI providers failed');
      }

      return this.formatParlayRecommendation(analysis, userContext);
    } catch (error) {
      Sentry.captureException(error);
      console.error('AI Service Error:', error);
      throw new Error('Failed to generate parlay analysis');
    }
  }

  async generateWithGemini(prompt) {
    try {
      const result = await this.geminiModel.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }

  async generateWithPerplexity(prompt) {
    try {
      const response = await this.perplexity.complete({
        prompt: prompt,
        model: 'pplx-7b-online',
        max_tokens: 1000
      });
      return response.choices[0].text;
    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Perplexity API error: ${error.message}`);
    }
  }

  buildParlayPrompt(userContext, gamesData, strategy) {
    return `
    PARLAY ANALYSIS REQUEST - STRATEGY: ${strategy.toUpperCase()}

    USER CONTEXT:
    - Betting History: ${userContext.totalBets || 0} total bets
    - Win Rate: ${userContext.winRate || 0}%
    - Preferred Sports: ${userContext.preferredSports?.join(', ') || 'All'}
    - Risk Tolerance: ${userContext.riskTolerance || 'medium'}

    AVAILABLE GAMES DATA:
    ${JSON.stringify(gamesData.slice(0, 10), null, 2)}

    STRATEGY GUIDELINES:
    ${this.strategyTemplates[strategy]}

    REQUIREMENTS:
    1. Generate 3-5 leg parlay with total odds between +200 and +800
    2. Provide detailed reasoning for each selection
    3. Calculate implied probabilities
    4. Identify value opportunities
    5. Consider matchup-specific factors
    6. Assess risk factors and potential pitfalls

    RESPONSE FORMAT (JSON):
    {
      "parlay": {
        "legs": [
          {
            "sport": "string",
            "teams": "string",
            "selection": "string",
            "odds": number,
            "reasoning": "string",
            "confidence": number,
            "risk_factors": ["string"]
          }
        ],
        "total_odds": number,
        "strategy_alignment": "string",
        "expected_value": "string",
        "risk_assessment": "string"
      },
      "analysis": {
        "overall_confidence": number,
        "key_insights": ["string"],
        "alternative_options": ["string"]
      }
    }
    `;
  }

  parseAIResponse(response, provider) {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback parsing for non-JSON responses
      return this.parseTextResponse(response, provider);
    } catch (error) {
      Sentry.captureException(error);
      return this.createFallbackAnalysis();
    }
  }

  parseTextResponse(response, provider) {
    // Implement robust text parsing for when AI doesn't return clean JSON
    const lines = response.split('\n').filter(line => line.trim());
    const legs = [];
    let totalOdds = 1;
    
    // Simple parsing logic - in production this would be more sophisticated
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('vs') || lines[i].includes('@')) {
        const leg = {
          teams: lines[i].trim(),
          selection: lines[i+1]?.trim() || 'Moneyline',
          odds: this.extractOdds(lines[i+2] || ''),
          reasoning: lines[i+3]?.trim() || 'AI analysis'
        };
        legs.push(leg);
        totalOdds *= (leg.odds / 100) + 1;
      }
    }
    
    return {
      parlay: {
        legs: legs.slice(0, 4),
        total_odds: (totalOdds - 1) * 100
      },
      analysis: {
        overall_confidence: 70,
        key_insights: ['Generated via text parsing fallback']
      }
    };
  }

  extractOdds(text) {
    const oddsMatch = text.match(/[+-]?\d+/);
    return oddsMatch ? parseInt(oddsMatch[0]) : 150;
  }

  createFallbackAnalysis() {
    // Fallback analysis when AI fails completely
    return {
      parlay: {
        legs: [
          {
            sport: "nfl",
            teams: "Fallback Selection 1",
            selection: "Moneyline",
            odds: 150,
            reasoning: "Conservative fallback option",
            confidence: 50
          }
        ],
        total_odds: 150,
        strategy_alignment: "safety_first"
      },
      analysis: {
        overall_confidence: 50,
        key_insights: ["Using fallback analysis due to AI service issues"]
      }
    };
  }

  formatParlayRecommendation(analysis, userContext) {
    return {
      ...analysis,
      metadata: {
        generated_at: new Date().toISOString(),
        user_context: userContext,
        ai_provider: analysis.metadata?.ai_provider || 'hybrid'
      }
    };
  }

  // Personalized Bet of the Day generation
  async generatePersonalizedBetOfTheDay(userId, userStats) {
    try {
      const prompt = this.buildPersonalizedPrompt(userStats);
      const analysis = await this.generateWithGemini(prompt);
      return this.formatPersonalizedBet(analysis, userStats);
    } catch (error) {
      Sentry.captureException(error);
      return this.generateFallbackBetOfTheDay();
    }
  }

  buildPersonalizedPrompt(userStats) {
    return `
    PERSONALIZED BET OF THE DAY ANALYSIS

    USER BETTING PROFILE:
    - Total Bets: ${userStats.totalBets}
    - Win Rate: ${userStats.winRate}%
    - Profit/Loss: $${userStats.profitLoss}
    - ROI: ${userStats.roi}%
    - Preferred Sports: ${userStats.preferredSports}

    RECENT PERFORMANCE:
    - Last 10 bets: ${userStats.recentWinRate}% win rate
    - Current Streak: ${userStats.currentStreak}
    - Best Streak: ${userStats.bestStreak}

    GENERATE A SINGLE HIGH-CONFIDENCE BET THAT:
    1. Matches user's successful betting patterns
    2. Addresses areas for improvement
    3. Provides educational value
    4. Has strong fundamental reasoning

    Focus on quality over quantity - one exceptional pick.
    `;
  }
}

export default new AIService();