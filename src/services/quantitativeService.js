// src/services/quantitativeService.js
// Node 20+ compatible, no external deps, deterministic, testable.

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
 */

class QuantitativeService {
  /**
   * @param {Partial<CalibrationFactors>} [overrides]
   * @param {{logger?:{info:Function,warn:Function,error:Function}}} [deps]
   */
  constructor(overrides = {}, deps = {}) {
    const defaults = {
      overconfidenceShrinkage: 0.15,     // 15% shrinkage toward 50%
      correlationPenaltyPerLeg: 0.05,    // 5% penalty per leg
      maxCorrelationPenalty: 0.30,       // Cap correlation penalty
      vigAdjustment: 0.95,               // Global vig haircut
      lineMovementRisk: 0.02             // 2% per leg line risk
    };

    /** @type {CalibrationFactors} */
    this.calibrationFactors = Object.freeze({ ...defaults, ...overrides });
    this.logger = deps.logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  // --------------------------
  // Public API
  // --------------------------

  /**
   * Comprehensive parlay evaluation with calibration
   * @param {Leg[]} legs
   * @param {number} parlayDecimalOdds  // If 0/undefined, will attempt to compute from legs
   * @returns {Promise<EvaluateResult|{error:string}>}
   */
  async evaluateParlay(legs, parlayDecimalOdds) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return { error: 'No legs provided for evaluation' };
    }

    // Extract leg-level probabilities and usable decimal odds
    const rawProbabilities = legs.map((leg) => {
      const raw = this._resolveLegFairProb(leg);
      const odds = this._resolveLegDecimalOdds(leg);
      return {
        raw,
        market: leg.market,
        player: leg.pick,
        game: leg.game,
        odds
      };
    });

    // If parlay odds not provided, approximate by multiplying leg odds (fallback 1.9)
    const computedParlayOdds = rawProbabilities.reduce(
      (acc, p) => acc * (Number.isFinite(p.odds) && p.odds > 1 ? p.odds : 1.9),
      1
    );
    const decimalOdds = Number.isFinite(parlayDecimalOdds) && parlayDecimalOdds > 1
      ? parlayDecimalOdds
      : computedParlayOdds;

    // Raw joint probability under independence
    const rawJointProbability = rawProbabilities.reduce((acc, p) => acc * this._clampProb(p.raw), 1);
    const bookmakerJointProbability = 1 / decimalOdds;

    this.logger.info?.('🔬 QUANTITATIVE ANALYSIS');
    this.logger.info?.(`- Raw Joint Probability: ${(rawJointProbability * 100).toFixed(2)}%`);
    this.logger.info?.(`- Bookmaker Implied: ${(bookmakerJointProbability * 100).toFixed(2)}%`);

    // Apply comprehensive calibration
    const calibrated = this._applyComprehensiveCalibration(
      rawProbabilities,
      rawJointProbability,
      bookmakerJointProbability,
      legs
    );

    // EVs (percentage terms)
    const rawEV = this._calculateEV(decimalOdds, rawJointProbability);
    const calibratedEV = this._calculateEV(decimalOdds, calibrated.jointProbability);

    // Recommendations
    const recommendations = this._generateRecommendations(
      calibrated,
      rawEV,
      calibratedEV,
      legs.length
    );

    // Risks
    const riskAssessment = this._assessRisks(legs, calibrated);

    // Optimal structure suggestion
    const optimalStructure = this._findOptimalStructure(legs, rawProbabilities);

    // Breakeven and Kelly
    const breakevenProbability = 1 / decimalOdds;
    const safetyMargin = calibrated.jointProbability - breakevenProbability;
    const kellyFraction = this._kellyFraction(decimalOdds, this._clampProb(calibrated.jointProbability));
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
      breakeven: {
        breakevenProbability,
        safetyMargin
      },
      staking: {
        kellyFraction,
        kellyFractionHalf
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
      const currentProb = this._resolveLegFairProb(leg);
      let breakEvenProb = currentProb;

      // Decrease this leg's probability until raw EV crosses zero
      for (let testProb = currentProb; testProb > 0.3; testProb -= 0.01) {
        const testLegs = [...legs];
        testLegs[index] = { ...leg, fair_prob: this._clampProb(testProb) };

        const testJointProb = testLegs.reduce((acc, l) => acc * this._clampProb(this._resolveLegFairProb(l)), 1);
        const testEV = this._calculateEV(parlayDecimalOdds, testJointProb);

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
      mostVulnerableLeg
    };
  }

  // --------------------------
  // Internal helpers
  // --------------------------

  /**
   * Resolve a leg's fair probability with sensible fallbacks
   * @param {Leg} leg
   * @returns {number}
   */
  _resolveLegFairProb(leg) {
    // Priority: explicit fair_prob -> confidence -> no_vig_prob -> implied from odds -> 0.5
    if (Number.isFinite(leg.fair_prob)) return this._clampProb(leg.fair_prob);
    if (Number.isFinite(leg.confidence)) return this._clampProb(leg.confidence);
    if (Number.isFinite(leg.no_vig_prob)) return this._clampProb(leg.no_vig_prob);

    const dec = this._resolveLegDecimalOdds(leg);
    if (Number.isFinite(dec) && dec > 1) {
      // Implied probability from decimal odds (contains vig in isolation)
      const implied = 1 / dec;
      // Light haircut to approximate no-vig when only single side is known (configurable via vigAdjustment)
      const approxNoVig = this._clampProb(implied / this.calibrationFactors.vigAdjustment);
      return approxNoVig;
    }

    return 0.5;
  }

  /**
   * Resolve a leg's decimal odds from fields
   * @param {Leg} leg
   * @returns {number|undefined}
   */
  _resolveLegDecimalOdds(leg) {
    if (Number.isFinite(leg.odds_decimal) && leg.odds_decimal > 1) return leg.odds_decimal;
    const fromQuote = leg?.best_quote?.decimal;
    if (Number.isFinite(fromQuote) && fromQuote > 1) return fromQuote;
    return undefined;
  }

  /**
   * Apply comprehensive calibration for overconfidence and correlation
   * @param {Array<{raw:number,market:string,player:string,game:string,odds?:number}>} rawProbabilities
   * @param {number} rawJointProb
   * @param {number} bookmakerJointProb
   * @param {Leg[]} legs
   */
  _applyComprehensiveCalibration(rawProbabilities, rawJointProb, bookmakerJointProb, legs) {
    // 1) Shrink individual probabilities toward 0.5 to reduce overconfidence
    const shrunkProbabilities = rawProbabilities.map((p) => {
      const s = p.raw * (1 - this.calibrationFactors.overconfidenceShrinkage)
              + 0.5 * this.calibrationFactors.overconfidenceShrinkage;
      return { ...p, shrunk: this._clampProb(Math.max(0.4, Math.min(0.9, s))) };
    });

    // 2) Shrunk joint probability under (approx) independence
    let shrunkJointProb = shrunkProbabilities.reduce((acc, p) => acc * p.shrunk, 1);

    // 3) Correlation penalty: base per-leg + surcharges for same-game clusters and market concentration
    const numLegs = legs.length;
    const basePenalty = Math.min(
      this.calibrationFactors.maxCorrelationPenalty,
      this.calibrationFactors.correlationPenaltyPerLeg * numLegs
    );

    // Same-game clusters
    const byGame = new Map();
    legs.forEach((l) => {
      const key = l.game || 'UNK';
      byGame.set(key, (byGame.get(key) || 0) + 1);
    });
    const sameGameSurcharge = [...byGame.values()]
      .filter((n) => n > 1)
      .reduce((sum, n) => sum + 0.02 * (n - 1), 0); // +2% per additional leg in same game

    // Market concentration
    const marketSet = new Set(legs.map((l) => l.market));
    const marketConcentration = Math.max(0, (numLegs - marketSet.size)) * 0.01; // +1% per repeated market

    const correlationPenalty = Math.min(
      this.calibrationFactors.maxCorrelationPenalty,
      basePenalty + sameGameSurcharge + marketConcentration
    );

    const correlatedJointProb = shrunkJointProb * (1 - correlationPenalty);

    // 4) Vig adjustment (global haircut)
    const vigAdjustedProb = correlatedJointProb * this.calibrationFactors.vigAdjustment;

    // 5) Line movement risk per leg
    const finalProbability = vigAdjustedProb * Math.pow(1 - this.calibrationFactors.lineMovementRisk, numLegs);

    // Ensure not below 80% of bookmaker implied probability
    const realisticProbability = Math.max(
      finalProbability,
      bookmakerJointProb * 0.8
    );

    this.logger.info?.('🎯 CALIBRATION BREAKDOWN:');
    this.logger.info?.(`- After Shrinkage: ${(shrunkJointProb * 100).toFixed(2)}%`);
    this.logger.info?.(`- After Correlation: ${(correlatedJointProb * 100).toFixed(2)}%`);
    this.logger.info?.(`- After Vig: ${(vigAdjustedProb * 100).toFixed(2)}%`);
    this.logger.info?.(`- Final Realistic: ${(realisticProbability * 100).toFixed(2)}%`);

    return {
      legProbabilities: shrunkProbabilities,
      jointProbability: this._clampProb(realisticProbability),
      adjustments: {
        shrinkage: this.calibrationFactors.overconfidenceShrinkage,
        correlationPenalty,
        vigAdjustment: this.calibrationFactors.vigAdjustment,
        lineMovementRisk: this.calibrationFactors.lineMovementRisk
      }
    };
  }

  /**
   * Calculate Expected Value (%) for a decimal-odds bet
   * EV% = (decimalOdds * p - 1) * 100
   */
  _calculateEV(decimalOdds, probability) {
    const p = this._clampProb(probability);
    return (decimalOdds * p - 1) * 100;
  }

  /**
   * Kelly fraction for a single decimal-odds bet
   * Kelly% = [(odds * p) - 1] / (odds - 1)
   * Returns 0 if negative
   */
  _kellyFraction(decimalOdds, p) {
    const b = Math.max(0, decimalOdds - 1);
    if (b === 0) return 0;
    const k = ((decimalOdds * p) - 1) / b;
    return Math.max(0, k);
  }

  /**
   * Assess risks for the parlay
   */
  _assessRisks(legs, calibrated) {
    const risks = [];
    const markets = legs.map((leg) => leg.market);
    const uniqueGames = new Set(legs.map((leg) => leg.game));
    const numLegs = legs.length;

    // Correlation risk (same games)
    const sameGameRatio = uniqueGames.size / numLegs;
    if (sameGameRatio < 0.7) {
      risks.push({
        type: 'CORRELATION',
        severity: 'HIGH',
        message: 'Too many legs from similar games/teams'
      });
    }

    // Market concentration risk
    const marketVariety = new Set(markets).size;
    if (marketVariety < Math.min(3, numLegs)) {
      risks.push({
        type: 'MARKET_CONCENTRATION',
        severity: 'MEDIUM',
        message: 'Low market variety increases correlation risk'
      });
    }

    // Overconfidence risk
    const highConfidenceLegs = legs.filter((leg) => (leg.fair_prob || 0) > 0.7).length;
    if (highConfidenceLegs > numLegs * 0.5) {
      risks.push({
        type: 'OVERCONFIDENCE',
        severity: 'MEDIUM',
        message: 'High number of high-confidence legs suggests potential overestimation'
      });
    }

    // Price efficiency awareness (if calibrated prob far below raw)
    if (calibrated.jointProbability < 0.75 * legs.reduce((acc, l) => acc * this._clampProb(l.fair_prob || l.confidence || 0.5), 1)) {
      risks.push({
        type: 'MARKET_EFFICIENCY',
        severity: 'LOW',
        message: 'Calibration significantly reduced joint probability; market may be efficient'
      });
    }

    const severityOrder = { HIGH: 3, ELEVATED: 2, MODERATE: 1, LOW: 0 };
    const overall =
      risks.some((r) => r.severity === 'HIGH') ? 'ELEVATED'
      : risks.length > 0 ? 'ELEVATED'
      : 'MODERATE';

    return {
      risks,
      overallRisk: overall,
      riskFactors: risks.map((r) => r.type)
    };
  }

  /**
   * Generate actionable recommendations
   */
  _generateRecommendations(calibrated, rawEV, calibratedEV, numLegs) {
    const recommendations = [];

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

    if (numLegs >= 4 && calibratedEV < rawEV * 0.3) {
      recommendations.push({
        type: 'REDUCE_LEGS',
        priority: 'MEDIUM',
        message: 'Large leg count significantly reduces realistic EV',
        action: `Consider 2-3 leg parlay instead of ${numLegs} legs`
      });
    }

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
   * Find optimal parlay structure (2-4 legs) by calibrated EV heuristic
   */
  _findOptimalStructure(legs, rawProbabilities) {
    if (legs.length <= 2) {
      return { optimalLegs: legs.length, message: 'Current structure is optimal' };
    }

    // Sort legs by highest raw confidence
    const sorted = legs
      .map((leg, idx) => ({ leg, probability: this._clampProb(rawProbabilities[idx].raw) }))
      .sort((a, b) => b.probability - a.probability);

    const counts = [2, 3, 4].filter((n) => n <= legs.length);

    const analysis = counts.map((k) => {
      const chosen = sorted.slice(0, k);
      const jointProb = chosen.reduce((acc, item) => acc * item.probability, 1);
      const decimalOdds = chosen.reduce(
        (acc, item) => acc * (this._resolveLegDecimalOdds(item.leg) || 1.9),
        1
      );

      const rawEV = this._calculateEV(decimalOdds, jointProb);

      // Quick calibration heuristic mirroring main calibration proportions
      const basePenalty = Math.min(0.30, 0.05 * k);
      const quickProb = jointProb
        * (1 - basePenalty)
        * 0.95
        * Math.pow(1 - 0.02, k)
        * 0.85; // shrinkage proxy

      const calibratedEV = this._calculateEV(decimalOdds, this._clampProb(quickProb));

      return {
        legs: k,
        legsList: chosen.map((c) => c.leg.pick),
        rawEV,
        calibratedEV,
        jointProbability: jointProb,
        decimalOdds
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

  // --------------------------
  // Utils
  // --------------------------
  _clampProb(x) {
    if (!Number.isFinite(x)) return 0.5;
    return Math.max(0.0001, Math.min(0.9999, x));
  }
}

export default new QuantitativeService();
export { QuantitativeService };
