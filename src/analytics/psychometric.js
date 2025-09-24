// src/analytics/psychometric.js - INSTITUTIONAL BEHAVIORAL FINANCE ENGINE
import { KMeans, PCA } from 'ml';
import { Regression, Classification } from 'ml-classification';
import { entropy, informationGain } from 'ml-stat';

class BehavioralAnalyzer {
  constructor() {
    this.cognitiveModels = new Map();
    this.emotionalPatterns = new Map();
    this.decisionModels = new Map();
    this.biasDetectors = new Map();
    
    this.initializeBehavioralModels();
  }

  initializeBehavioralModels() {
    this.cognitiveModels.set('risk_tolerance', new RiskToleranceModel());
    this.cognitiveModels.set('loss_aversion', new LossAversionModel());
    this.cognitiveModels.set('time_preference', new TimePreferenceModel());
    this.cognitiveModels.set('overconfidence', new OverconfidenceDetector());
    
    this.emotionalPatterns.set('fear_greed', new FearGreedIndex());
    this.emotionalPatterns.set('regret_aversion', new RegretAversionModel());
    this.emotionalPatterns.set('herding_behavior', new HerdingBehaviorDetector());
    
    this.biasDetectors.set('confirmation_bias', new ConfirmationBiasDetector());
    this.biasDetectors.set('anchoring_bias', new AnchoringBiasDetector());
    this.biasDetectors.set('recency_bias', new RecencyBiasDetector());
    this.biasDetectors.set('gamblers_fallacy', new GamblersFallacyDetector());
  }

  async detectCognitiveBiases(userId) {
    const userData = await this.getUserBehavioralData(userId);
    const biases = [];
    
    for (const [biasName, detector] of this.biasDetectors) {
      const biasScore = await detector.analyze(userData);
      if (biasScore > 0.7) { // High probability of bias
        biases.push({
          bias: biasName,
          score: biasScore,
          evidence: detector.getEvidence(userData),
          impact: this.calculateBiasImpact(biasName, userData),
          mitigation: this.generateMitigationStrategy(biasName, biasScore)
        });
      }
    }
    
    return this.rankBiasesByImpact(biases);
  }

  async analyzeEmotionalPatterns(userId) {
    const emotionalData = await this.getUserEmotionalData(userId);
    const patterns = [];
    
    for (const [patternName, analyzer] of this.emotionalPatterns) {
      const analysis = await analyzer.analyze(emotionalData);
      patterns.push({
        pattern: patternName,
        intensity: analysis.intensity,
        frequency: analysis.frequency,
        triggers: analysis.triggers,
        impactOnDecisions: analysis.impactOnDecisions
      });
    }
    
    return this.clusterEmotionalPatterns(patterns);
  }

  async assessDecisionMakingStyle(userId) {
    const decisionHistory = await this.getUserDecisionHistory(userId);
    
    const styleAnalysis = {
      analytical: this.measureAnalyticalThinking(decisionHistory),
      intuitive: this.measureIntuitiveDecisionMaking(decisionHistory),
      impulsive: this.measureImpulsivity(decisionHistory),
      deliberative: this.measureDeliberation(decisionHistory)
    };
    
    return {
      primaryStyle: this.determinePrimaryStyle(styleAnalysis),
      styleProfile: styleAnalysis,
      consistency: this.measureDecisionConsistency(decisionHistory),
      adaptability: this.measureStyleAdaptability(decisionHistory)
    };
  }

  async calculateLossAversion(userId) {
    const lossData = await this.getUserLossResponses(userId);
    
    // Prospect theory-based loss aversion calculation
    const lossAversionCoefficient = this.calculateProspectTheoryLambda(lossData);
    const lossSensitivity = this.measureLossSensitivity(lossData);
    const recoveryPattern = this.analyzeLossRecovery(lossData);
    
    return {
      coefficient: lossAversionCoefficient,
      sensitivity: lossSensitivity,
      recoveryTime: recoveryPattern.recoveryTime,
      behavioralImpact: recoveryPattern.behavioralImpact,
      classification: this.classifyLossAversionLevel(lossAversionCoefficient)
    };
  }

  calculateProspectTheoryLambda(lossData) {
    // λ = |v(-x)| / v(x) where x > 0
    const lossUtility = this.calculateLossUtility(lossData);
    const gainUtility = this.calculateGainUtility(lossData);
    
    return Math.abs(lossUtility) / gainUtility;
  }

  async generatePersonalizedCoaching(userId) {
    const biases = await this.detectCognitiveBiases(userId);
    const emotions = await this.analyzeEmotionalPatterns(userId);
    const decisionStyle = await this.assessDecisionMakingStyle(userId);
    const lossAversion = await this.calculateLossAversion(userId);
    
    return {
      userId,
      assessmentDate: new Date().toISOString(),
      behavioralProfile: {
        biases,
        emotions,
        decisionStyle,
        lossAversion
      },
      coachingRecommendations: this.generateCoachingStrategies({
        biases, emotions, decisionStyle, lossAversion
      }),
      interventionPlan: this.createBehavioralInterventionPlan({
        biases, emotions, decisionStyle, lossAversion
      }),
      progressMetrics: this.establishProgressMetrics(userId)
    };
  }

  generateCoachingStrategies(profile) {
    const strategies = [];
    
    // Bias mitigation strategies
    profile.biases.forEach(bias => {
      strategies.push({
        type: 'bias_mitigation',
        targetBias: bias.bias,
        strategy: this.getBiasMitigationStrategy(bias),
        exercises: this.getBiasMitigationExercises(bias),
        expectedTimeline: this.estimateMitigationTimeline(bias)
      });
    });
    
    // Emotional regulation strategies
    if (profile.emotions.some(e => e.intensity > 0.8)) {
      strategies.push({
        type: 'emotional_regulation',
        techniques: this.getEmotionalRegulationTechniques(profile.emotions),
        triggers: this.identifyEmotionalTriggers(profile.emotions),
        copingMechanisms: this.developCopingMechanisms(profile.emotions)
      });
    }
    
    // Decision-making improvement
    strategies.push({
      type: 'decision_optimization',
      framework: this.getDecisionFramework(profile.decisionStyle),
      tools: this.getDecisionSupportTools(profile.decisionStyle),
      processImprovements: this.optimizeDecisionProcess(profile.decisionStyle)
    });
    
    return strategies;
  }
}

class RiskToleranceAssessor {
  static async comprehensiveAssessment(config) {
    const assessmentMethods = [
      this.psychometricQuestionnaire(config.userId),
      this.behavioralObservation(config.userId),
      this.financialCapacityAnalysis(config.userId),
      this.scenarioAnalysis(config.userId)
    ];
    
    const results = await Promise.all(assessmentMethods);
    const integratedScore = this.integrateAssessmentResults(results);
    
    return {
      score: integratedScore.overall,
      capacity: integratedScore.capacity,
      required: integratedScore.required,
      biases: this.identifyRiskBiases(results),
      recommendation: this.generateRiskRecommendation(integratedScore)
    };
  }

  static async psychometricQuestionnaire(userId) {
    const questions = this.getRiskToleranceQuestions();
    const responses = await this.getUserQuestionnaireResponses(userId, questions);
    
    return this.scorePsychometricQuestionnaire(responses, questions);
  }

  static behavioralObservation(userId) {
    const bettingHistory = await this.getUserBettingHistory(userId);
    const riskTakingPatterns = this.analyzeRiskTakingPatterns(bettingHistory);
    
    return {
      method: 'behavioral_observation',
      score: this.calculateBehavioralRiskScore(riskTakingPatterns),
      patterns: riskTakingPatterns,
      consistency: this.measureRiskConsistency(riskTakingPatterns)
    };
  }

  static financialCapacityAnalysis(userId) {
    const financialData = await this.getUserFinancialData(userId);
    
    return {
      method: 'financial_capacity',
      score: this.calculateFinancialCapacityScore(financialData),
      capacityMetrics: {
        emergencyFund: financialData.emergencyFund,
        debtToIncome: financialData.debtToIncome,
        investmentHorizon: financialData.investmentHorizon,
        liquidityNeeds: financialData.liquidityNeeds
      }
    };
  }
}

// Supporting behavioral models
class LossAversionModel {
  analyze(lossData) {
    const coefficient = this.calculateLossAversionCoefficient(lossData);
    const sensitivity = this.measureLossSensitivity(lossData);
    const recovery = this.analyzeLossRecoveryPatterns(lossData);
    
    return {
      coefficient,
      sensitivity,
      recoveryPatterns: recovery,
      classification: this.classifyLossAversion(coefficient)
    };
  }

  calculateLossAversionCoefficient(lossData) {
    // Based on prospect theory: λ = -U(-x) / U(x)
    const lossUtility = this.calculateUtilityFunction(lossData.losses, true);
    const gainUtility = this.calculateUtilityFunction(lossData.gains, false);
    
    return Math.abs(lossUtility) / gainUtility;
  }
}

class ConfirmationBiasDetector {
  async analyze(userData) {
    const informationSeeking = await this.analyzeInformationSeeking(userData);
    const beliefPersistence = await this.analyzeBeliefPersistence(userData);
    const contradictoryHandling = await this.analyzeContradictoryHandling(userData);
    
    return this.aggregateBiasIndicators([
      informationSeeking,
      beliefPersistence,
      contradictoryHandling
    ]);
  }

  analyzeInformationSeeking(userData) {
    // Measure tendency to seek confirming information
    const searchPatterns = userData.searchHistory;
    const confirmationRatio = this.calculateConfirmationRatio(searchPatterns);
    const diversityIndex = this.calculateInformationDiversity(searchPatterns);
    
    return {
      indicator: 'information_seeking',
      score: 1 - diversityIndex, // Lower diversity = higher bias
      confidence: confirmationRatio,
      evidence: this.extractConfirmingSearches(searchPatterns)
    };
  }
}

export { BehavioralAnalyzer, RiskToleranceAssessor, LossAversionModel, ConfirmationBiasDetector };