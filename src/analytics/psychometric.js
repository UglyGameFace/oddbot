// src/analytics/psychometric.js - INSTITUTIONAL BEHAVIORAL FINANCE ENGINE
import { kmeans } from 'ml-kmeans';
import { PCA } from 'ml-pca';
import DatabaseService from '../services/databaseService.js'; // Import the database service

class BehavioralAnalyzer {
  constructor() {
    this.biasDetectors = new Map([
      ['confirmation_bias', new ConfirmationBiasDetector()],
      ['anchoring_bias', new AnchoringBiasDetector()],
      ['recency_bias', new RecencyBiasDetector()],
      ['gamblers_fallacy', new GamblersFallacyDetector()],
    ]);
  }

  async detectCognitiveBiases(userId) {
    // In a real system, this would pull complex behavioral data. We use a mock here.
    const behavioralData = await DatabaseService.getMockUserBehavioralData(userId);
    const biases = [];
    for (const [biasName, detector] of this.biasDetectors) {
      const biasScore = await detector.analyze(behavioralData);
      if (biasScore > 0.7) {
        biases.push({
          bias: biasName,
          score: parseFloat(biasScore.toFixed(2)),
          impact: this.calculateBiasImpact(biasName),
          mitigation: this.generateMitigationStrategy(biasName),
        });
      }
    }
    return biases.sort((a, b) => b.score - a.score);
  }

  calculateBiasImpact(biasName) {
    const impacts = {
      confirmation_bias: 'Leads to ignoring contrary evidence.',
      anchoring_bias: 'Over-reliance on initial odds.',
      recency_bias: 'Overweights recent performance.',
      gamblers_fallacy: 'Assumes past outcomes influence future independent events.',
    };
    return impacts[biasName] || 'General negative impact on decision-making.';
  }

  generateMitigationStrategy(biasName) {
    const strategies = {
      confirmation_bias: 'Actively seek out arguments against your chosen bet.',
      anchoring_bias: 'Re-evaluate a game from scratch without looking at the initial odds.',
      recency_bias: 'Review long-term performance data instead of just the last few games.',
      gamblers_fallacy: 'Remind yourself that each game is an independent statistical event.',
    };
    return strategies[biasName] || 'Practice disciplined, data-driven analysis.';
  }
}

class RiskToleranceAssessor {
  // --- FIX: The function is now correctly marked as async ---
  static async behavioralObservation(userId) {
    const bettingHistory = await DatabaseService.getMockUserBehavioralData(userId); // Use mock data
    const riskTakingPatterns = this.analyzeRiskTakingPatterns(bettingHistory);
    
    return {
      method: 'behavioral_observation',
      score: this.calculateBehavioralRiskScore(riskTakingPatterns),
      patterns: riskTakingPatterns,
    };
  }
  
  static analyzeRiskTakingPatterns(bettingHistory){
    // Placeholder logic for analyzing risk
    const underdogBets = bettingHistory.betsOnLosingStreaks || 0;
    const totalBets = bettingHistory.totalBets || 1;
    return { underdogBetRatio: underdogBets / totalBets };
  }
  
  static calculateBehavioralRiskScore(patterns){
    // Simple scoring based on pattern
    return patterns.underdogBetRatio * 100;
  }
}

// --- Supporting Model Implementations ---

class ConfirmationBiasDetector {
  async analyze(data) {
    const favoriteTeamBets = data.betsOnFavoriteTeams / (data.totalBets || 1);
    const ignoredRivalOpportunities = data.ignoredRivalOpportunities / (data.totalOpportunities || 1);
    return (favoriteTeamBets + ignoredRivalOpportunities) / 2;
  }
}

class AnchoringBiasDetector {
  async analyze(data) {
    const staticBetRatio = 1 - (data.betsWithAdapatedStrategy / (data.totalBets || 1));
    return staticBetRatio;
  }
}
class RecencyBiasDetector {
    async analyze(data) {
        const streakBetRatio = data.betsOnHotStreaks / (data.totalBets || 1);
        const streakBetValue = data.avgValueOfStreakBets;
        return streakBetRatio * (1 - (streakBetValue + 0.1));
    }
}
class GamblersFallacyDetector {
    async analyze(data) {
        const dueToWinBetRatio = data.betsOnLosingStreaks / (data.totalBets || 1);
        return dueToWinBetRatio;
    }
}

export { BehavioralAnalyzer, RiskToleranceAssessor };
