// src/services/quantitativeService.js - NEW FILE
class QuantitativeService {
  constructor() {
    this.calibrationFactors = {
      overconfidenceShrinkage: 0.15, // 15% shrinkage toward 50%
      correlationPenaltyPerLeg: 0.05, // 5% penalty per leg
      maxCorrelationPenalty: 0.3, // Maximum 30% penalty
      vigAdjustment: 0.95, // Account for bookmaker vig
      lineMovementRisk: 0.02 // 2% risk per leg for line movement
    };
  }

  /**
   * Comprehensive parlay evaluation with calibration
   */
  evaluateParlay(legs, parlayDecimalOdds) {
    if (!legs || legs.length === 0) {
      return { error: 'No legs provided for evaluation' };
    }

    // Extract raw probabilities
    const rawProbabilities = legs.map(leg => ({
      raw: leg.fair_prob || leg.confidence || 0.5,
      market: leg.market,
      player: leg.pick,
      game: leg.game,
      odds: leg.odds_decimal || leg.best_quote?.decimal
    }));

    // Calculate raw joint probability
    const rawJointProbability = rawProbabilities.reduce((acc, p) => acc * p.raw, 1);
    const bookmakerJointProbability = 1 / parlayDecimalOdds;

    console.log('🔬 QUANTITATIVE ANALYSIS');
    console.log(`- Raw Joint Probability: ${(rawJointProbability * 100).toFixed(2)}%`);
    console.log(`- Bookmaker Implied: ${(bookmakerJointProbability * 100).toFixed(2)}%`);

    // Apply comprehensive calibration
    const calibrated = this._applyComprehensiveCalibration(
      rawProbabilities, 
      rawJointProbability, 
      bookmakerJointProbability,
      legs.length
    );

    // Calculate EVs
    const rawEV = this._calculateEV(parlayDecimalOdds, rawJointProbability);
    const calibratedEV = this._calculateEV(parlayDecimalOdds, calibrated.jointProbability);

    // Generate recommendations
    const recommendations = this._generateRecommendations(
      calibrated, 
      rawEV, 
      calibratedEV, 
      legs.length
    );

    return {
      raw: {
        jointProbability: rawJointProbability,
        evPercentage: rawEV,
        decimalOdds: parlayDecimalOdds,
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
      riskAssessment: this._assessRisks(legs, calibrated),
      recommendations: recommendations,
      optimalStructure: this._findOptimalStructure(legs, rawProbabilities)
    };
  }

  /**
   * Apply comprehensive calibration for overconfidence and correlation
   */
  _applyComprehensiveCalibration(rawProbabilities, rawJointProb, bookmakerJointProb, numLegs) {
    // 1. Shrink individual probabilities toward 50%
    const shrunkProbabilities = rawProbabilities.map(p => {
      const shrunk = p.raw * (1 - this.calibrationFactors.overconfidenceShrinkage) + 
                    0.5 * this.calibrationFactors.overconfidenceShrinkage;
      return {
        ...p,
        shrunk: Math.max(0.4, Math.min(0.9, shrunk)) // Keep within reasonable bounds
      };
    });

    // 2. Calculate shrunk joint probability
    let shrunkJointProb = shrunkProbabilities.reduce((acc, p) => acc * p.shrunk, 1);

    // 3. Apply correlation penalty
    const correlationPenalty = Math.min(
      this.calibrationFactors.maxCorrelationPenalty,
      this.calibrationFactors.correlationPenaltyPerLeg * numLegs
    );
    const correlatedJointProb = shrunkJointProb * (1 - correlationPenalty);

    // 4. Apply vig adjustment
    const vigAdjustedProb = correlatedJointProb * this.calibrationFactors.vigAdjustment;

    // 5. Apply line movement risk
    const finalProbability = vigAdjustedProb * 
      Math.pow(1 - this.calibrationFactors.lineMovementRisk, numLegs);

    // Ensure we don't go too far below bookmaker probability
    const realisticProbability = Math.max(
      finalProbability,
      bookmakerJointProb * 0.8 // Don't go below 80% of bookmaker probability
    );

    console.log('🎯 CALIBRATION BREAKDOWN:');
    console.log(`- After Shrinkage: ${(shrunkJointProb * 100).toFixed(2)}%`);
    console.log(`- After Correlation: ${(correlatedJointProb * 100).toFixed(2)}%`);
    console.log(`- After Vig: ${(vigAdjustedProb * 100).toFixed(2)}%`);
    console.log(`- Final Realistic: ${(realisticProbability * 100).toFixed(2)}%`);

    return {
      legProbabilities: shrunkProbabilities,
      jointProbability: realisticProbability,
      adjustments: {
        shrinkage: this.calibrationFactors.overconfidenceShrinkage,
        correlationPenalty: correlationPenalty,
        vigAdjustment: this.calibrationFactors.vigAdjustment,
        lineMovementRisk: this.calibrationFactors.lineMovementRisk
      }
    };
  }

  /**
   * Calculate Expected Value
   */
  _calculateEV(decimalOdds, probability) {
    return (decimalOdds * probability - 1) * 100;
  }

  /**
   * Assess risks for the parlay
   */
  _assessRisks(legs, calibrated) {
    const risks = [];
    const markets = legs.map(leg => leg.market);
    const uniqueGames = new Set(legs.map(leg => leg.game));

    // Correlation risk
    if (uniqueGames.size < legs.length * 0.7) {
      risks.push({
        type: 'CORRELATION',
        severity: 'HIGH',
        message: 'Too many legs from similar games/teams'
      });
    }

    // Market concentration risk
    const marketVariety = new Set(markets).size;
    if (marketVariety < Math.min(3, legs.length)) {
      risks.push({
        type: 'MARKET_CONCENTRATION',
        severity: 'MEDIUM',
        message: 'Low market variety increases correlation risk'
      });
    }

    // Overconfidence risk
    const highConfidenceLegs = legs.filter(leg => (leg.fair_prob || 0) > 0.7).length;
    if (highConfidenceLegs > legs.length * 0.5) {
      risks.push({
        type: 'OVERCONFIDENCE',
        severity: 'MEDIUM',
        message: 'High number of high-confidence legs suggests potential overestimation'
      });
    }

    return {
      risks: risks,
      overallRisk: risks.length > 0 ? 'ELEVATED' : 'MODERATE',
      riskFactors: risks.map(r => r.type)
    };
  }

  /**
   * Generate actionable recommendations
   */
  _generateRecommendations(calibrated, rawEV, calibratedEV, numLegs) {
    const recommendations = [];

    // EV-based recommendations
    if (calibratedEV > 10) {
      recommendations.push({
        type: 'STRONG_EDGE',
        priority: 'HIGH',
        message: 'Strong positive EV detected after calibration',
        action: 'Consider full stake on this parlay'
      });
    } else if (calibratedEV > 0) {
      recommendations.push({
        type: 'MODEST_EDGE',
        priority: 'MEDIUM',
        message: 'Modest positive EV - conservative approach recommended',
        action: 'Consider reduced stake or breaking into smaller parlays'
      });
    } else {
      recommendations.push({
        type: 'NEGATIVE_EV',
        priority: 'HIGH',
        message: 'Negative EV after realistic calibration',
        action: 'Avoid this parlay or significantly reduce stake'
      });
    }

    // Structure recommendations
    if (numLegs >= 4 && calibratedEV < rawEV * 0.3) {
      recommendations.push({
        type: 'REDUCE_LEGS',
        priority: 'MEDIUM',
        message: 'Large leg count significantly reduces realistic EV',
        action: `Consider 2-3 leg parlay instead of ${numLegs} legs`
      });
    }

    // Correlation recommendations
    if (calibrated.adjustments.correlationPenalty > 0.15) {
      recommendations.push({
        type: 'DIVERSIFY',
        priority: 'MEDIUM',
        message: 'High correlation penalty suggests need for diversification',
        action: 'Include legs from different games/markets'
      });
    }

    return recommendations;
  }

  /**
   * Find optimal parlay structure
   */
  _findOptimalStructure(legs, rawProbabilities) {
    if (legs.length <= 2) {
      return { optimalLegs: legs.length, message: 'Current structure is optimal' };
    }

    // Sort legs by confidence (highest first)
    const sortedLegs = [...legs]
      .map((leg, index) => ({ leg, probability: rawProbabilities[index].raw }))
      .sort((a, b) => b.probability - a.probability);

    // Test different combinations
    const combinations = [2, 3, 4].filter(n => n <= legs.length);
    const analysis = combinations.map(numLegs => {
      const selectedLegs = sortedLegs.slice(0, numLegs);
      const jointProb = selectedLegs.reduce((acc, item) => acc * item.probability, 1);
      const decimalOdds = selectedLegs.reduce((acc, item) => 
        acc * (item.leg.odds_decimal || item.leg.best_quote?.decimal || 1.9), 1);
      
      const rawEV = this._calculateEV(decimalOdds, jointProb);
      
      // Apply quick calibration
      const calibratedProb = jointProb * 0.85 * (1 - Math.min(0.3, 0.05 * numLegs));
      const calibratedEV = this._calculateEV(decimalOdds, calibratedProb);

      return {
        legs: numLegs,
        legsList: selectedLegs.map(item => item.leg.pick),
        rawEV: rawEV,
        calibratedEV: calibratedEV,
        jointProbability: jointProb,
        decimalOdds: decimalOdds
      };
    });

    // Find best combination by calibrated EV
    const bestCombination = analysis.reduce((best, current) => 
      current.calibratedEV > best.calibratedEV ? current : best
    );

    return {
      bestCombination: bestCombination,
      allCombinations: analysis,
      recommendation: bestCombination.legs !== legs.length ? 
        `Consider reducing to ${bestCombination.legs} legs for better risk-adjusted returns` :
        'Current leg count appears optimal'
    };
  }

  /**
   * Generate detailed sensitivity analysis
   */
  sensitivityAnalysis(legs, parlayDecimalOdds) {
    const baseEvaluation = this.evaluateParlay(legs, parlayDecimalOdds);
    
    // Test how much probabilities need to drop to break even
    const breakEvenAnalysis = legs.map((leg, index) => {
      const currentProb = leg.fair_prob || leg.confidence || 0.5;
      let breakEvenProb = currentProb;
      
      // Find where EV becomes zero
      for (let testProb = currentProb; testProb > 0.3; testProb -= 0.01) {
        const testLegs = [...legs];
        testLegs[index] = { ...leg, fair_prob: testProb };
        
        const testJointProb = testLegs.reduce((acc, l) => acc * (l.fair_prob || 0.5), 1);
        const testEV = this._calculateEV(parlayDecimalOdds, testJointProb);
        
        if (testEV <= 0) {
          breakEvenProb = testProb;
          break;
        }
      }
      
      return {
        leg: leg.pick,
        currentProbability: currentProb,
        breakEvenProbability: breakEvenProb,
        marginForError: currentProb - breakEvenProb,
        vulnerability: (currentProb - breakEvenProb) < 0.1 ? 'HIGH' : 
                      (currentProb - breakEvenProb) < 0.15 ? 'MEDIUM' : 'LOW'
      };
    });

    return {
      baseEvaluation: baseEvaluation,
      breakEvenAnalysis: breakEvenAnalysis,
      mostVulnerableLeg: breakEvenAnalysis.reduce((most, current) => 
        current.vulnerability === 'HIGH' && current.marginForError < (most?.marginForError || 1) ? 
        current : most, null
      )
    };
  }
}

export default new QuantitativeService();
