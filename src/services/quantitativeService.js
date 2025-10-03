// src/services/quantitativeService.js - ENHANCED MODULAR VERSION WITH REAL GAME VALIDATION

/**
 * @typedef {Object} Leg
 * @property {string} market
 * @property {string} pick
 * @property {string} game
 * @property {number} [fair_prob]        // User/model fair probability in [0,1]
 * @property {number} [confidence]       // Alternative to fair_prob in [0,1]
 * @property {number} [odds_decimal]     // Leg decimal odds if available
 * @property {{ decimal?: number }} [best_quote] // Fallback decimal quote
 * @property {number} [no_vig_prob]      // Optional no-vig implied prob if precomputed
 * @property {boolean} [real_game_validated] // Whether leg was validated against real schedule
 */

/**
 * @typedef {Object} CalibrationFactors
 * @property {number} overconfidenceShrinkage   // default 0.15
 * @property {number} correlationPenaltyPerLeg  // default 0.05
 * @property {number} maxCorrelationPenalty     // default 0.30
 * @property {number} vigAdjustment             // default 0.95
 * @property {number} lineMovementRisk          // default 0.02
 */

/**
 * @typedef {Object} EvaluateResult
 * @property {{jointProbability:number, evPercentage:number, decimalOdds:number, bookmakerImpliedProbability:number, theoreticalEdge:'POSITIVE'|'NEGATIVE'}} raw
 * @property {{jointProbability:number, evPercentage:number, legProbabilities:any[], adjustments:any, realisticEdge:'HIGH'|'LOW'|'NEGATIVE'}} calibrated
 * @property {{risks:any[], overallRisk:'LOW'|'MODERATE'|'ELEVATED'|'HIGH', riskFactors:string[]}} riskAssessment
 * @property {any[]} recommendations
 * @property {{bestCombination:any, allCombinations:any[], recommendation:string}} optimalStructure
 * @property {{breakevenProbability:number, safetyMargin:number}} breakeven
 * @property {{kellyFraction:number, kellyFractionHalf:number}} staking
 * @property {{real_games_validated:number, total_legs:number, validation_rate:number, data_quality:string, recommendation:string}} validation
 */

// Probability calculation utilities
class ProbabilityCalculator {
  static clampProb(x) {
    if (!Number.isFinite(x)) return 0.5;
    return Math.max(0.0001, Math.min(0.9999, x));
  }

  static calculateEV(decimalOdds, probability) {
    const p = this.clampProb(probability);
    return (decimalOdds * p - 1) * 100;
  }

  static kellyFraction(decimalOdds, probability) {
    const p = this.clampProb(probability);
    const b = Math.max(0, decimalOdds - 1);
    if (b === 0) return 0;
    const k = ((decimalOdds * p) - 1) / b;
    return Math.max(0, k);
  }

  static americanToDecimal(americanOdds) {
    if (americanOdds > 0) return (americanOdds / 100) + 1;
    return (100 / Math.abs(americanOdds)) + 1;
  }

  static decimalToAmerican(decimalOdds) {
    if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
    return Math.round(-100 / (decimalOdds - 1));
  }

  static impliedProbability(decimalOdds) {
    if (decimalOdds <= 0) return 0;
    return 1 / decimalOdds;
  }

  static noVigProbability(probHome, probAway, probDraw = 0) {
    const total = probHome + probAway + probDraw;
    if (total === 0) return { home: 0, away: 0, draw: 0 };
    return {
      home: probHome / total,
      away: probAway / total,
      draw: probDraw / total
    };
  }
}

// Leg probability resolver
class LegProbabilityResolver {
  static resolveLegFairProb(leg) {
    // Priority: explicit fair_prob -> confidence -> no_vig_prob -> implied from odds -> 0.5
    if (Number.isFinite(leg.fair_prob)) return ProbabilityCalculator.clampProb(leg.fair_prob);
    if (Number.isFinite(leg.confidence)) return ProbabilityCalculator.clampProb(leg.confidence);
    if (Number.isFinite(leg.no_vig_prob)) return ProbabilityCalculator.clampProb(leg.no_vig_prob);

    const dec = this.resolveLegDecimalOdds(leg);
    if (Number.isFinite(dec) && dec > 1) {
      const implied = 1 / dec;
      const approxNoVig = ProbabilityCalculator.clampProb(implied / 0.95); // Light haircut for vig
      return approxNoVig;
    }

    return 0.5;
  }

  static resolveLegDecimalOdds(leg) {
    if (Number.isFinite(leg.odds_decimal) && leg.odds_decimal > 1) return leg.odds_decimal;
    const fromQuote = leg?.best_quote?.decimal;
    if (Number.isFinite(fromQuote) && fromQuote > 1) return fromQuote;
    return undefined;
  }
}

// Risk assessment engine
class RiskAssessmentEngine {
  static assessRisks(legs, calibrated, validationMetrics = null) {
    const risks = [];
    const markets = legs.map((leg) => leg.market);
    const uniqueGames = new Set(legs.map((leg) => leg.game));
    const numLegs = legs.length;

    // Add validation risks if available
    if (validationMetrics) {
      if (validationMetrics.validation_rate < 0.5) {
        risks.push({
          type: 'VALIDATION',
          severity: 'HIGH',
          message: 'Low real game validation rate',
          impact: 'Many legs may be based on non-existent games'
        });
      } else if (validationMetrics.validation_rate < 0.8) {
        risks.push({
          type: 'VALIDATION',
          severity: 'MEDIUM',
          message: 'Moderate real game validation rate',
          impact: 'Some legs may not be verified'
        });
      }
    }

    // Correlation risk (same games)
    const sameGameRatio = uniqueGames.size / numLegs;
    if (sameGameRatio < 0.7) {
      risks.push({
        type: 'CORRELATION',
        severity: 'HIGH',
        message: 'Too many legs from similar games/teams',
        impact: 'Joint probability overestimated'
      });
    }

    // Market concentration risk
    const marketVariety = new Set(markets).size;
    if (marketVariety < Math.min(3, numLegs)) {
      risks.push({
        type: 'MARKET_CONCENTRATION',
        severity: 'MEDIUM',
        message: 'Low market variety increases correlation risk',
        impact: 'Reduced diversification benefits'
      });
    }

    // Overconfidence risk
    const highConfidenceLegs = legs.filter((leg) => (leg.fair_prob || 0) > 0.7).length;
    if (highConfidenceLegs > numLegs * 0.5) {
      risks.push({
        type: 'OVERCONFIDENCE',
        severity: 'MEDIUM',
        message: 'High number of high-confidence legs suggests potential overestimation',
        impact: 'Probabilities may be inflated'
      });
    }

    // Price efficiency awareness
    if (calibrated.jointProbability < 0.75 * legs.reduce((acc, l) => acc * ProbabilityCalculator.clampProb(l.fair_prob || l.confidence || 0.5), 1)) {
      risks.push({
        type: 'MARKET_EFFICIENCY',
        severity: 'LOW',
        message: 'Calibration significantly reduced joint probability; market may be efficient',
        impact: 'Limited edge opportunities'
      });
    }

    // Odds quality risk
    const legsWithOdds = legs.filter(leg => LegProbabilityResolver.resolveLegDecimalOdds(leg));
    if (legsWithOdds.length < legs.length) {
      risks.push({
        type: 'ODDS_QUALITY',
        severity: 'MEDIUM',
        message: `${legs.length - legsWithOdds.length} legs missing reliable odds data`,
        impact: 'Probability estimates less reliable'
      });
    }

    const severityOrder = { HIGH: 3, ELEVATED: 2, MODERATE: 1, LOW: 0 };
    const overall = risks.some((r) => r.severity === 'HIGH') ? 'HIGH' :
                   risks.some((r) => r.severity === 'ELEVATED') ? 'ELEVATED' :
                   risks.length > 0 ? 'MODERATE' : 'LOW';

    return {
      risks,
      overallRisk: overall,
      riskFactors: risks.map((r) => r.type),
      riskScore: this.calculateRiskScore(risks, numLegs)
    };
  }

  static calculateRiskScore(risks, numLegs) {
    const severityWeights = { HIGH: 3, ELEVATED: 2, MODERATE: 1, LOW: 0.5 };
    const baseScore = risks.reduce((score, risk) => score + severityWeights[risk.severity], 0);
    const legPenalty = Math.max(0, (numLegs - 3) * 0.2); // Penalty for too many legs
    return Math.min(10, baseScore + legPenalty);
  }
}

// Calibration engine
class CalibrationEngine {
  constructor(calibrationFactors) {
    this.factors = calibrationFactors;
  }

  applyComprehensiveCalibration(rawProbabilities, rawJointProb, bookmakerJointProb, legs, validationMetrics = null) {
    // 1) Shrink individual probabilities toward 0.5 to reduce overconfidence
    const shrunkProbabilities = rawProbabilities.map((p) => {
      const s = p.raw * (1 - this.factors.overconfidenceShrinkage)
              + 0.5 * this.factors.overconfidenceShrinkage;
      return { ...p, shrunk: ProbabilityCalculator.clampProb(Math.max(0.4, Math.min(0.9, s))) };
    });

    // 2) Shrunk joint probability under (approx) independence
    let shrunkJointProb = shrunkProbabilities.reduce((acc, p) => acc * p.shrunk, 1);

    // 3) Correlation penalty
    const correlationPenalty = this.calculateCorrelationPenalty(legs);

    const correlatedJointProb = shrunkJointProb * (1 - correlationPenalty);

    // 4) Vig adjustment (global haircut)
    const vigAdjustedProb = correlatedJointProb * this.factors.vigAdjustment;

    // 5) Line movement risk per leg
    const finalProbability = vigAdjustedProb * Math.pow(1 - this.factors.lineMovementRisk, legs.length);

    // 6) Apply validation penalty if low validation rate
    let validationAdjustedProb = finalProbability;
    if (validationMetrics && validationMetrics.validation_rate < 0.8) {
      const validationPenalty = 1 - (validationMetrics.validation_rate * 0.5); // Up to 50% penalty for poor validation
      validationAdjustedProb = finalProbability * (1 - validationPenalty);
    }

    // Ensure not below 80% of bookmaker implied probability
    const realisticProbability = Math.max(
      validationAdjustedProb,
      bookmakerJointProb * 0.8
    );

    return {
      legProbabilities: shrunkProbabilities,
      jointProbability: ProbabilityCalculator.clampProb(realisticProbability),
      adjustments: {
        shrinkage: this.factors.overconfidenceShrinkage,
        correlationPenalty,
        vigAdjustment: this.factors.vigAdjustment,
        lineMovementRisk: this.factors.lineMovementRisk,
        validationPenalty: validationMetrics ? (1 - validationMetrics.validation_rate) * 0.5 : 0
      }
    };
  }

  calculateCorrelationPenalty(legs) {
    const numLegs = legs.length;
    const basePenalty = Math.min(
      this.factors.maxCorrelationPenalty,
      this.factors.correlationPenaltyPerLeg * numLegs
    );

    // Same-game clusters
    const byGame = new Map();
    legs.forEach((l) => {
      const key = l.game || 'UNK';
      byGame.set(key, (byGame.get(key) || 0) + 1);
    });
    const sameGameSurcharge = [...byGame.values()]
      .filter((n) => n > 1)
      .reduce((sum, n) => sum + 0.02 * (n - 1), 0);

    // Market concentration
    const marketSet = new Set(legs.map((l) => l.market));
    const marketConcentration = Math.max(0, (numLegs - marketSet.size)) * 0.01;

    return Math.min(
      this.factors.maxCorrelationPenalty,
      basePenalty + sameGameSurcharge + marketConcentration
    );
  }
}

// Recommendation engine
class RecommendationEngine {
  static generateRecommendations(calibrated, rawEV, calibratedEV, numLegs, riskAssessment, validationMetrics = null) {
    const recommendations = [];

    // Validation-based recommendations
    if (validationMetrics) {
      if (validationMetrics.validation_rate < 0.5) {
        recommendations.push({
          type: 'VALIDATION_ISSUE',
          priority: 'HIGH',
          message: 'Low real game validation - many legs may be based on non-existent games',
          action: 'Use verified schedule data or try Live mode',
          confidence: 'high'
        });
      } else if (validationMetrics.validation_rate < 0.8) {
        recommendations.push({
          type: 'VALIDATION_WARNING',
          priority: 'MEDIUM',
          message: 'Moderate real game validation - some legs may not be verified',
          action: 'Consider using Live mode for better verification',
          confidence: 'medium'
        });
      }
    }

    // EV-based recommendations
    if (calibratedEV > 10) {
      recommendations.push({
        type: 'STRONG_EDGE',
        priority: 'HIGH',
        message: 'Strong positive EV detected after calibration',
        action: 'Consider full stake on this parlay',
        confidence: 'high'
      });
    } else if (calibratedEV > 0) {
      recommendations.push({
        type: 'MODEST_EDGE',
        priority: 'MEDIUM',
        message: 'Modest positive EV - conservative approach recommended',
        action: 'Consider reduced stake or breaking into smaller parlays',
        confidence: 'medium'
      });
    } else {
      recommendations.push({
        type: 'NEGATIVE_EV',
        priority: 'HIGH',
        message: 'Negative EV after realistic calibration',
        action: 'Avoid this parlay or significantly reduce stake',
        confidence: 'high'
      });
    }

    // Leg count recommendations
    if (numLegs >= 4 && calibratedEV < rawEV * 0.3) {
      recommendations.push({
        type: 'REDUCE_LEGS',
        priority: 'MEDIUM',
        message: 'Large leg count significantly reduces realistic EV',
        action: `Consider 2-3 leg parlay instead of ${numLegs} legs`,
        confidence: 'medium'
      });
    }

    // Correlation recommendations
    if (calibrated.adjustments.correlationPenalty > 0.15) {
      recommendations.push({
        type: 'DIVERSIFY',
        priority: 'MEDIUM',
        message: 'High correlation penalty suggests need for diversification',
        action: 'Include legs from different games/markets',
        confidence: 'medium'
      });
    }

    // Risk-based recommendations
    if (riskAssessment.overallRisk === 'HIGH') {
      recommendations.push({
        type: 'HIGH_RISK',
        priority: 'HIGH',
        message: 'Parlay carries elevated risk levels',
        action: 'Consider significantly reduced stake or alternative bets',
        confidence: 'high'
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }
}

// Optimal structure analyzer
class OptimalStructureAnalyzer {
  static findOptimalStructure(legs, rawProbabilities) {
    if (legs.length <= 2) {
      return { optimalLegs: legs.length, message: 'Current structure is optimal' };
    }

    // Sort legs by highest raw confidence
    const sorted = legs
      .map((leg, idx) => ({ leg, probability: ProbabilityCalculator.clampProb(rawProbabilities[idx].raw) }))
      .sort((a, b) => b.probability - a.probability);

    const counts = [2, 3, 4].filter((n) => n <= legs.length);

    const analysis = counts.map((k) => {
      const chosen = sorted.slice(0, k);
      const jointProb = chosen.reduce((acc, item) => acc * item.probability, 1);
      const decimalOdds = chosen.reduce(
        (acc, item) => acc * (LegProbabilityResolver.resolveLegDecimalOdds(item.leg) || 1.9),
        1
      );

      const rawEV = ProbabilityCalculator.calculateEV(decimalOdds, jointProb);

      // Quick calibration heuristic
      const basePenalty = Math.min(0.30, 0.05 * k);
      const quickProb = jointProb
        * (1 - basePenalty)
        * 0.95
        * Math.pow(1 - 0.02, k)
        * 0.85;

      const calibratedEV = ProbabilityCalculator.calculateEV(decimalOdds, ProbabilityCalculator.clampProb(quickProb));

      return {
        legs: k,
        legsList: chosen.map((c) => c.leg.pick),
        rawEV,
        calibratedEV,
        jointProbability: jointProb,
        decimalOdds,
        kellyFraction: ProbabilityCalculator.kellyFraction(decimalOdds, quickProb)
      };
    });

    const best = analysis.reduce((a, b) => (b.calibratedEV > a.calibratedEV ? b : a));

    return {
      bestCombination: best,
      allCombinations: analysis,
      recommendation:
        best.legs !== legs.length
          ? `Consider reducing to ${best.legs} legs for better risk-adjusted returns`
          : 'Current leg count appears optimal'
    };
  }
}

// Main Quantitative Service Class
class QuantitativeService {
  /**
   * @param {Partial<CalibrationFactors>} [overrides]
   * @param {{logger?:{info:Function,warn:Function,error:Function}}} [deps]
   */
  constructor(overrides = {}, deps = {}) {
    const defaults = {
      overconfidenceShrinkage: 0.15,
      correlationPenaltyPerLeg: 0.05,
      maxCorrelationPenalty: 0.30,
      vigAdjustment: 0.95,
      lineMovementRisk: 0.02
    };

    this.calibrationFactors = Object.freeze({ ...defaults, ...overrides });
    this.logger = deps.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.calibrationEngine = new CalibrationEngine(this.calibrationFactors);
  }

  /**
   * Comprehensive parlay evaluation with calibration
   * @param {Leg[]} legs
   * @param {number} parlayDecimalOdds
   * @returns {Promise<EvaluateResult|{error:string}>}
   */
  async evaluateParlay(legs, parlayDecimalOdds) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return { error: 'No legs provided for evaluation' };
    }

    // Extract leg-level probabilities and usable decimal odds
    const rawProbabilities = legs.map((leg) => {
      const raw = LegProbabilityResolver.resolveLegFairProb(leg);
      const odds = LegProbabilityResolver.resolveLegDecimalOdds(leg);
      return {
        raw,
        market: leg.market,
        player: leg.pick,
        game: leg.game,
        odds,
        validated: leg.real_game_validated || false
      };
    });

    // Calculate validation metrics
    const validatedLegs = legs.filter(leg => leg.real_game_validated).length;
    const validationRate = validatedLegs / legs.length;
    const validationMetrics = {
      real_games_validated: validatedLegs,
      total_legs: legs.length,
      validation_rate: validationRate,
      data_quality: validationRate > 0.8 ? 'HIGH' : validationRate > 0.5 ? 'MEDIUM' : 'LOW',
      recommendation: validationRate < 0.5 ? 
        'Consider using verified schedule data' : 'Good real game coverage'
    };

    // If parlay odds not provided, approximate by multiplying leg odds
    const computedParlayOdds = rawProbabilities.reduce(
      (acc, p) => acc * (Number.isFinite(p.odds) && p.odds > 1 ? p.odds : 1.9),
      1
    );
    const decimalOdds = Number.isFinite(parlayDecimalOdds) && parlayDecimalOdds > 1
      ? parlayDecimalOdds
      : computedParlayOdds;

    // Raw joint probability under independence
    const rawJointProbability = rawProbabilities.reduce((acc, p) => acc * ProbabilityCalculator.clampProb(p.raw), 1);
    const bookmakerJointProbability = 1 / decimalOdds;

    this.logger.info?.('🔬 QUANTITATIVE ANALYSIS');
    this.logger.info?.(`- Raw Joint Probability: ${(rawJointProbability * 100).toFixed(2)}%`);
    this.logger.info?.(`- Bookmaker Implied: ${(bookmakerJointProbability * 100).toFixed(2)}%`);
    this.logger.info?.(`- Real Game Validation: ${validatedLegs}/${legs.length} legs (${(validationRate * 100).toFixed(1)}%)`);

    // Apply comprehensive calibration with validation metrics
    const calibrated = this.calibrationEngine.applyComprehensiveCalibration(
      rawProbabilities,
      rawJointProbability,
      bookmakerJointProbability,
      legs,
      validationMetrics
    );

    // EVs (percentage terms)
    const rawEV = ProbabilityCalculator.calculateEV(decimalOdds, rawJointProbability);
    const calibratedEV = ProbabilityCalculator.calculateEV(decimalOdds, calibrated.jointProbability);

    // Risk assessment with validation metrics
    const riskAssessment = RiskAssessmentEngine.assessRisks(legs, calibrated, validationMetrics);

    // Recommendations with validation metrics
    const recommendations = RecommendationEngine.generateRecommendations(
      calibrated,
      rawEV,
      calibratedEV,
      legs.length,
      riskAssessment,
      validationMetrics
    );

    // Optimal structure suggestion
    const optimalStructure = OptimalStructureAnalyzer.findOptimalStructure(legs, rawProbabilities);

    // Breakeven and Kelly
    const breakevenProbability = 1 / decimalOdds;
    const safetyMargin = calibrated.jointProbability - breakevenProbability;
    const kellyFraction = ProbabilityCalculator.kellyFraction(decimalOdds, calibrated.jointProbability);
    const kellyFractionHalf = Math.max(0, kellyFraction / 2);

    return {
      raw: {
        jointProbability: rawJointProbability,
        evPercentage: rawEV,
        decimalOdds,
        bookmakerImpliedProbability: bookmakerJointProbability,
        theoreticalEdge: rawEV > 0 ? 'POSITIVE' : 'NEGATIVE'
      },
      calibrated: {
        jointProbability: calibrated.jointProbability,
        evPercentage: calibratedEV,
        legProbabilities: calibrated.legProbabilities,
        adjustments: calibrated.adjustments,
        realisticEdge: calibratedEV > 5 ? 'HIGH' : calibratedEV > 0 ? 'LOW' : 'NEGATIVE'
      },
      riskAssessment,
      recommendations,
      optimalStructure,
      validation: validationMetrics,
      breakeven: {
        breakevenProbability,
        safetyMargin
      },
      staking: {
        kellyFraction,
        kellyFractionHalf,
        recommendedStake: this.calculateRecommendedStake(kellyFractionHalf, riskAssessment.overallRisk, validationRate)
      },
      summary: this.generateSummary(calibratedEV, riskAssessment, recommendations, validationMetrics)
    };
  }

  /**
   * Enhanced evaluation with real game validation
   */
  async evaluateParlayWithValidation(legs, parlayDecimalOdds, sportKey) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return { error: 'No legs provided for evaluation' };
    }

    // Check if legs are validated against real games
    const validatedLegs = legs.filter(leg => leg.real_game_validated);
    const validationRate = validatedLegs.length / legs.length;
    
    if (validationRate < 0.5) {
      console.warn(`⚠️ Low real game validation: ${validatedLegs.length}/${legs.length} legs validated`);
    }

    const baseEvaluation = await this.evaluateParlay(legs, parlayDecimalOdds);
    
    // Add validation metrics to the evaluation
    return {
      ...baseEvaluation,
      validation: {
        real_games_validated: validatedLegs.length,
        total_legs: legs.length,
        validation_rate: validationRate,
        data_quality: validationRate > 0.8 ? 'HIGH' : validationRate > 0.5 ? 'MEDIUM' : 'LOW',
        recommendation: validationRate < 0.5 ? 
          'Consider using verified schedule data' : 'Good real game coverage'
      }
    };
  }

  /**
   * Generate detailed sensitivity analysis
   * @param {Leg[]} legs
   * @param {number} parlayDecimalOdds
   */
  async sensitivityAnalysis(legs, parlayDecimalOdds) {
    const baseEvaluation = await this.evaluateParlay(legs, parlayDecimalOdds);

    const breakEvenAnalysis = legs.map((leg, index) => {
      const currentProb = LegProbabilityResolver.resolveLegFairProb(leg);
      let breakEvenProb = currentProb;

      // Decrease this leg's probability until raw EV crosses zero
      for (let testProb = currentProb; testProb > 0.3; testProb -= 0.01) {
        const testLegs = [...legs];
        testLegs[index] = { ...leg, fair_prob: ProbabilityCalculator.clampProb(testProb) };

        const testJointProb = testLegs.reduce((acc, l) => acc * ProbabilityCalculator.clampProb(LegProbabilityResolver.resolveLegFairProb(l)), 1);
        const testEV = ProbabilityCalculator.calculateEV(parlayDecimalOdds, testJointProb);

        if (testEV <= 0) {
          breakEvenProb = testProb;
          break;
        }
      }

      const marginForError = currentProb - breakEvenProb;
      return {
        leg: leg.pick,
        currentProbability: currentProb,
        breakEvenProbability: breakEvenProb,
        marginForError,
        vulnerability:
          marginForError < 0.10 ? 'HIGH' :
          marginForError < 0.15 ? 'MEDIUM' : 'LOW'
      };
    });

    const mostVulnerableLeg = breakEvenAnalysis.reduce((most, cur) => {
      if (!most) return cur;
      if (cur.vulnerability === 'HIGH' && most.vulnerability !== 'HIGH') return cur;
      if (cur.vulnerability === most.vulnerability && cur.marginForError < most.marginForError) return cur;
      return most;
    }, null);

    return {
      baseEvaluation,
      breakEvenAnalysis,
      mostVulnerableLeg,
      overallRobustness: this.calculateOverallRobustness(breakEvenAnalysis)
    };
  }

  // ========== PRIVATE METHODS ==========

  calculateRecommendedStake(kellyFraction, riskLevel, validationRate = 1.0) {
    const riskMultipliers = { LOW: 1.0, MODERATE: 0.7, ELEVATED: 0.4, HIGH: 0.2 };
    const multiplier = riskMultipliers[riskLevel] || 0.5;
    
    // Apply validation rate penalty
    const validationMultiplier = Math.min(1.0, validationRate * 1.2); // Up to 20% boost for full validation
    
    return Math.min(0.1, kellyFraction * multiplier * validationMultiplier); // Cap at 10% of bankroll
  }

  generateSummary(calibratedEV, riskAssessment, recommendations, validationMetrics = null) {
    const primaryRec = recommendations[0];
    
    let verdict = calibratedEV > 0 ? 'CONSIDER_BET' : 'AVOID_BET';
    let confidence = riskAssessment.overallRisk === 'LOW' ? 'HIGH' : 'MEDIUM';
    
    // Adjust based on validation
    if (validationMetrics && validationMetrics.validation_rate < 0.5) {
      verdict = 'AVOID_BET';
      confidence = 'LOW';
    }
    
    return {
      verdict,
      confidence,
      keyMetric: `Calibrated EV: ${calibratedEV.toFixed(2)}%`,
      primaryRecommendation: primaryRec?.action || 'No specific recommendation',
      riskLevel: riskAssessment.overallRisk,
      validationStatus: validationMetrics?.data_quality || 'UNKNOWN'
    };
  }

  calculateOverallRobustness(breakEvenAnalysis) {
    const avgMargin = breakEvenAnalysis.reduce((sum, leg) => sum + leg.marginForError, 0) / breakEvenAnalysis.length;
    if (avgMargin > 0.15) return 'HIGH';
    if (avgMargin > 0.10) return 'MEDIUM';
    if (avgMargin > 0.05) return 'LOW';
    return 'VERY_LOW';
  }
}

export default new QuantitativeService();
export { 
  QuantitativeService,
  ProbabilityCalculator,
  LegProbabilityResolver,
  RiskAssessmentEngine,
  CalibrationEngine,
  RecommendationEngine,
  OptimalStructureAnalyzer
};
