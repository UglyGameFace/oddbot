// src/services/quantitativeService.js - EV-DRIVEN UPDATE
import { sentryService } from './sentryService.js'; // Added Sentry
import { toDecimalFromAmerican, toAmericanFromDecimal } from '../utils/botUtils.js'; // Use shared utils

// --- Core Probability & Odds Utilities ---
class ProbabilityCalculator {
  static clampProb(p) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return 0.5; // Default invalid probability to 50%
    return Math.max(0.01, Math.min(0.99, p)); // Clamp between 1% and 99%
  }

  // Calculates Expected Value as a percentage (per $100 wagered)
  static calculateEVPercentage(decimalOdds, modelProbability) {
    if (decimalOdds <= 1 || !modelProbability) return -100; // Cannot profit if odds <= 1
    const p = this.clampProb(modelProbability);
    // EV = (Probability of Winning * Amount Won Per Dollar) - (Probability of Losing * Amount Lost Per Dollar)
    // Amount Won Per Dollar = decimalOdds - 1
    // Amount Lost Per Dollar = 1
    // EV = p * (decimalOdds - 1) - (1 - p) * 1
    // EV = p * decimalOdds - p - 1 + p
    // EV = p * decimalOdds - 1
    // EV % = (p * decimalOdds - 1) * 100
    const ev = (p * decimalOdds - 1) * 100;
    return ev;
  }

  // Calculates the Kelly Criterion fraction
  static kellyFraction(decimalOdds, modelProbability) {
    if (decimalOdds <= 1 || !modelProbability) return 0; // Cannot bet if odds <= 1 or no probability
    const p = this.clampProb(modelProbability);
    const b = decimalOdds - 1; // Net odds received on a win
    if (b <= 0) return 0; // Cannot bet if net odds are not positive
    const q = 1 - p; // Probability of losing
    // Kelly formula: f* = (bp - q) / b
    const kelly = (b * p - q) / b;
    return Math.max(0, kelly); // Kelly fraction cannot be negative
  }

  // Convert American odds from AI input to Decimal
  static americanToDecimal(americanOdds) {
     // Use imported function, add validation
     if (typeof americanOdds !== 'number' || americanOdds === 0) return 1.0; // Invalid odds return 1.0
     return toDecimalFromAmerican(americanOdds);
  }

  // Calculate Implied Probability from Decimal Odds
   static impliedProbability(decimalOdds) {
    if (typeof decimalOdds !== 'number' || decimalOdds <= 1) return 0;
    return 1 / decimalOdds;
  }

  // Convert Decimal back to American for output/display if needed
   static decimalToAmerican(decimalOdds) {
      if (typeof decimalOdds !== 'number' || decimalOdds <= 1) return null; // Or return a default like '+10000'?
      return toAmericanFromDecimal(decimalOdds);
  }

} // End ProbabilityCalculator

// --- Risk Assessment Engine ---
// Updated to use inputs from the AI's detailed leg output
class RiskAssessmentEngine {
  static assessRisks(legs = [], parlayMetrics = {}) {
    const risks = [];
    if (!Array.isArray(legs) || legs.length === 0) {
      return { risks: [{ type: 'INPUT', severity: 'CRITICAL', message: 'No legs provided for risk assessment.' }], overallRisk: 'REJECTED' };
    }
    const numLegs = legs.length;

    // 1. Injury Gate Risk
    const criticalInjuryGates = legs.flatMap(leg =>
      (leg.injury_gates || []).filter(gate =>
         /\((Questionable|Doubtful|Out)\)/i.test(gate) // Check for critical statuses
      )
    );
    if (criticalInjuryGates.length > 0) {
      risks.push({
        type: 'INJURY',
        severity: 'HIGH',
        message: `Critical player statuses unresolved: ${criticalInjuryGates.slice(0, 2).join(', ')}${criticalInjuryGates.length > 2 ? '...' : ''}`,
        impact: 'Parlay validity depends on player availability.'
      });
    }

    // 2. Correlation Risk (using AI's assessment primarily)
    const highCorrLegs = legs.filter(leg => /high positive/i.test(leg.correlation_notes || ''));
    const negCorrLegs = legs.filter(leg => /negative/i.test(leg.correlation_notes || ''));
    if (negCorrLegs.length > 0) {
       risks.push({
        type: 'CORRELATION',
        severity: 'CRITICAL', // Negative correlation often invalidates parlays
        message: `Negative correlation detected between legs: ${negCorrLegs.map(l => l.selection).join(' vs ')}`,
        impact: 'Parlay likely invalid or has significantly reduced true odds.'
      });
    } else if (parlayMetrics.correlation_score > 0.3 || highCorrLegs.length >= 2) { // Use combined score or count
      risks.push({
        type: 'CORRELATION',
        severity: 'MEDIUM',
        message: `Potential positive correlation detected (Score: ${parlayMetrics.correlation_score?.toFixed(2) ?? 'N/A'}).`,
        impact: 'Joint probability might be slightly lower than product.'
      });
    }

    // 3. Market Signal Conflict Risk
    const rlmConflicts = legs.filter(leg =>
        leg.market_signals?.reverse_line_movement &&
        /against model|conflicts with edge/i.test(leg.market_signals.reverse_line_movement)
    );
    if (rlmConflicts.length > 0) {
        risks.push({
            type: 'MARKET_SIGNAL',
            severity: 'MEDIUM',
            message: `Reverse line movement conflicts with model edge on ${rlmConflicts.length} leg(s).`,
            impact: 'Sharp money may disagree with the model.'
        });
    }

    // 4. Low Edge / Negative EV Risk
    if (parlayMetrics.parlay_ev_per_100 < 1) { // EV threshold (e.g., 1%)
        risks.push({
            type: 'VALUE',
            severity: 'HIGH',
            message: `Low or negative overall EV (${parlayMetrics.parlay_ev_per_100?.toFixed(2)}%) after analysis.`,
            impact: 'Parlay is likely unprofitable long-term.'
        });
    } else if (legs.some(leg => leg.ev_per_100 < 0.5)) { // Check individual leg EV
         risks.push({
            type: 'VALUE',
            severity: 'LOW',
            message: 'One or more legs have very marginal EV.',
            impact: 'Reduces overall parlay value and robustness.'
        });
    }

    // 5. Data Quality / Stale Odds Risk (Check Timestamps)
    const now = Date.now();
    const staleLegs = legs.filter(leg => {
        if (!leg.timestamp) return true; // Missing timestamp is high risk
        try {
            return (now - new Date(leg.timestamp).getTime()) > 15 * 60 * 1000; // Older than 15 mins
        } catch { return true; } // Invalid timestamp
    });
     if (staleLegs.length > 0) {
        risks.push({
            type: 'DATA_STALE',
            severity: 'MEDIUM',
            message: `${staleLegs.length} leg(s) based on potentially stale odds (>15 min old).`,
            impact: 'Current market price may differ, affecting EV.'
        });
    }

    // Determine Overall Risk Level
    let overallRisk = 'LOW';
    if (risks.some(r => r.severity === 'CRITICAL')) overallRisk = 'REJECTED';
    else if (risks.some(r => r.severity === 'HIGH')) overallRisk = 'HIGH';
    else if (risks.filter(r => r.severity === 'MEDIUM').length >= 2) overallRisk = 'HIGH';
    else if (risks.some(r => r.severity === 'MEDIUM')) overallRisk = 'MEDIUM';
    // else remains LOW

    return {
      risks,
      overallRisk: overallRisk, // LOW, MEDIUM, HIGH, REJECTED
      riskFactors: risks.map((r) => r.type), // List of risk types identified
    };
  }

} // End RiskAssessmentEngine

// --- Recommendation Engine ---
// Simplified recommendations based on EV, Kelly, and Risk
class RecommendationEngine {
    static generateRecommendations(parlayMetrics, riskAssessment) {
        const recommendations = [];
        const ev = parlayMetrics?.parlay_ev_per_100 ?? -100;
        const kellyRec = parlayMetrics?.kelly_stake?.recommended_fraction ?? 0;
        const riskLevel = riskAssessment?.overallRisk ?? 'REJECTED';

        if (riskLevel === 'REJECTED') {
            recommendations.push({
                priority: 'CRITICAL',
                message: `Parlay REJECTED due to: ${riskAssessment.risks.find(r => r.severity === 'CRITICAL')?.message || 'Critical risk factors.'}`,
                action: 'DO NOT BET. Re-evaluate legs or wait for updates (e.g., injuries).'
            });
            return recommendations; // Stop further recommendations if rejected
        }

        // EV Based
        if (ev > 15) {
             recommendations.push({ priority: 'HIGH', type: 'EV', message: `Strong positive EV (+${ev.toFixed(1)}%) detected.` });
        } else if (ev > 5) {
             recommendations.push({ priority: 'MEDIUM', type: 'EV', message: `Moderate positive EV (+${ev.toFixed(1)}%) detected.` });
        } else if (ev > 0) {
             recommendations.push({ priority: 'LOW', type: 'EV', message: `Marginal positive EV (+${ev.toFixed(1)}%). Consider risk.` });
        } else {
             recommendations.push({ priority: 'HIGH', type: 'EV', message: `Negative EV (${ev.toFixed(1)}%) detected.` });
        }

        // Staking Based
        if (kellyRec > 0.02) { // e.g., > 2% bankroll via Quarter Kelly
             recommendations.push({ priority: 'HIGH', type: 'STAKE', message: `Significant edge warrants consideration. Recommended stake: ${(kellyRec * 100).toFixed(1)}% bankroll.` });
        } else if (kellyRec > 0.005) { // e.g., > 0.5% bankroll
             recommendations.push({ priority: 'MEDIUM', type: 'STAKE', message: `Modest edge. Recommended stake: ${(kellyRec * 100).toFixed(1)}% bankroll.` });
        } else {
             recommendations.push({ priority: 'LOW', type: 'STAKE', message: `Minimal edge. Consider minimum stake or passing. Recommended: ${(kellyRec * 100).toFixed(1)}% bankroll.` });
        }

        // Risk Based
        if (riskLevel === 'HIGH') {
             recommendations.push({ priority: 'HIGH', type: 'RISK', message: `High risk factors identified. ${riskAssessment.risks.filter(r=>r.severity ==='HIGH').map(r=>r.type).join(', ')}`, action: 'Reduce stake significantly or avoid.' });
        } else if (riskLevel === 'MEDIUM') {
             recommendations.push({ priority: 'MEDIUM', type: 'RISK', message: `Medium risk factors present. ${riskAssessment.risks.filter(r=>r.severity ==='MEDIUM').map(r=>r.type).join(', ')}`, action: 'Consider slightly reduced stake.' });
        }

        // Specific Actionable Items from Risks
         riskAssessment.risks.forEach(risk => {
             if (risk.type === 'INJURY' && risk.severity === 'HIGH') {
                 recommendations.push({ priority: 'HIGH', type: 'ACTION', message: 'Re-evaluate parlay once injury statuses are final.', action: 'WAIT/CHECK INJURIES' });
             }
              if (risk.type === 'DATA_STALE') {
                 recommendations.push({ priority: 'MEDIUM', type: 'ACTION', message: 'Odds may be stale. Verify current prices before betting.', action: 'CHECK CURRENT ODDS' });
             }
              if (risk.type === 'MARKET_SIGNAL' && risk.severity === 'MEDIUM') {
                 recommendations.push({ priority: 'MEDIUM', type: 'ACTION', message: 'Sharp money may conflict with model. Consider reducing stake.', action: 'REDUCE STAKE' });
             }
         });


        // Combine Actionable Advice
        let primaryAction = "Review risks and stake recommendations.";
        if (riskLevel === 'REJECTED') primaryAction = "DO NOT BET.";
        else if (recommendations.some(r => r.action === 'WAIT/CHECK INJURIES')) primaryAction = "WAIT for injury updates before betting.";
        else if (ev <= 0) primaryAction = "AVOID due to negative EV.";
        else if (riskLevel === 'HIGH') primaryAction = "REDUCE STAKE significantly due to high risk.";
        else if (kellyRec > 0.005) primaryAction = `Consider betting ${(kellyRec * 100).toFixed(1)}% of bankroll.`;
        else primaryAction = "Consider minimum stake or pass due to low edge.";


        // Sort by priority (CRITICAL > HIGH > MEDIUM > LOW)
         const priorityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
         recommendations.sort((a, b) => (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0));


        return {
            list: recommendations.slice(0, 5), // Limit to top 5 recommendations
            primaryAction: primaryAction
        };
    }

} // End RecommendationEngine


// --- Main Quantitative Service Class ---
// Updated to use the AI's provided probabilities and structure
class QuantitativeService {
  constructor(deps = {}) {
    // Calibration factors are less relevant now, AI provides calibrated prob
    this.logger = deps.logger || { info: (...args) => console.log(...args), warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) };
    // Kelly Cap Policy
    this.kellyCap = 0.25; // e.g., Quarter Kelly
    console.log(`📈 Quantitative Service Initialized (Kelly Cap: ${this.kellyCap * 100}%)`);
  }

  /**
   * Evaluates a parlay based on detailed leg data provided by the AI.
   * @param {Array<object>} legs - Array of leg objects matching the AI output contract.
   * @returns {Promise<object>} - Evaluation result including metrics, risks, and recommendations.
   */
  async evaluateParlay(legs) {
    this.logger.info(`🔬 Evaluating parlay with ${legs?.length || 0} legs...`);

    // --- 1. Input Validation ---
    if (!Array.isArray(legs) || legs.length < 2) { // Require at least 2 legs for a parlay
      this.logger.error('❌ evaluateParlay: Invalid input - legs array must have at least 2 elements.');
      return {
        error: 'Invalid input: Parlay must have at least 2 legs.',
        summary: { verdict: 'INVALID', primaryAction: 'Provide at least 2 valid legs.' },
        combined_parlay_metrics: null, riskAssessment: null, recommendations: null
      };
    }

    // Validate structure of each leg (basic check)
    const invalidLegs = legs.filter(leg =>
        typeof leg.price !== 'number' ||
        typeof leg.model_probability !== 'number' ||
        typeof leg.implied_probability !== 'number' ||
        typeof leg.ev_per_100 !== 'number'
        // Add more checks if needed (e.g., market_type, selection)
    );
    if (invalidLegs.length > 0) {
        this.logger.error(`❌ evaluateParlay: ${invalidLegs.length} leg(s) have missing/invalid required fields (price, model_probability, etc.).`);
         sentryService.captureError(new Error("Invalid leg structure in evaluateParlay"), { component: 'quantitativeService', operation: 'evaluateParlay_InputValidation', invalidLegsSample: invalidLegs.slice(0,1), level: 'warning' });
        return {
             error: `Invalid leg structure: ${invalidLegs.length} leg(s) missing required numeric fields (price, model_probability, etc.).`,
             summary: { verdict: 'INVALID', primaryAction: 'Ensure AI provides all required fields per leg.' },
             combined_parlay_metrics: null, riskAssessment: null, recommendations: null
        };
    }


    try {
        // --- 2. Calculate Combined Metrics ---
        let combinedDecimalOdds = 1.0;
        let combinedModelProbability = 1.0;
        let correlationAdjustmentFactor = 1.0; // Start with no adjustment

        legs.forEach(leg => {
            const decimalOdds = ProbabilityCalculator.americanToDecimal(leg.price);
            if (decimalOdds <= 1) {
                this.logger.warn(`⚠️ Leg with invalid decimal odds (${decimalOdds} from ${leg.price}) skipped in combined calculation.`);
                // Optionally handle this more strictly (e.g., reject parlay)
                return; // Skip this leg in combined calculation
            }
            combinedDecimalOdds *= decimalOdds;
            combinedModelProbability *= ProbabilityCalculator.clampProb(leg.model_probability);

            // Simple correlation adjustment based on AI notes (can be refined)
            if (/high positive/i.test(leg.correlation_notes || '')) {
                correlationAdjustmentFactor *= 0.98; // Apply a small penalty per high correlation note
            }
            // Note: Negative correlation should ideally lead to rejection earlier
        });

        // Apply correlation adjustment
        const adjustedCombinedModelProbability = ProbabilityCalculator.clampProb(combinedModelProbability * correlationAdjustmentFactor);

        const combinedAmericanOdds = ProbabilityCalculator.decimalToAmerican(combinedDecimalOdds);
        const parlayEV = ProbabilityCalculator.calculateEVPercentage(combinedDecimalOdds, adjustedCombinedModelProbability);
        const fullKelly = ProbabilityCalculator.kellyFraction(combinedDecimalOdds, adjustedCombinedModelProbability);

        const parlayMetrics = {
            combined_decimal_odds: parseFloat(combinedDecimalOdds.toFixed(4)),
            combined_american_odds: combinedAmericanOdds ? (combinedAmericanOdds > 0 ? `+${combinedAmericanOdds}`: `${combinedAmericanOdds}`) : 'N/A',
            // Use adjusted probability for final metrics
            combined_probability_product: parseFloat(adjustedCombinedModelProbability.toFixed(4)),
            parlay_ev_per_100: parseFloat(parlayEV.toFixed(2)),
            kelly_stake: {
                full_kelly_fraction: parseFloat(fullKelly.toFixed(4)),
                half_kelly_fraction: parseFloat((fullKelly / 2).toFixed(4)),
                quarter_kelly_fraction: parseFloat((fullKelly / 4).toFixed(4)),
                // Apply the cap policy
                recommended_fraction: parseFloat(Math.min(fullKelly * this.kellyCap, 0.10).toFixed(4)), // Apply cap, max 10%
                bankroll_allocation_percent: parseFloat((Math.min(fullKelly * this.kellyCap, 0.10) * 100).toFixed(2))
            },
            // Include correlation score if provided by AI or calculated here
            correlation_score: legs[0]?.correlation_score ?? null, // Placeholder - needs actual calculation or AI input
             rejection_reason: null // Will be set by risk assessment if needed
        };


        // --- 3. Assess Risks ---
        // Pass the calculated parlay metrics to risk assessment
        const riskAssessment = RiskAssessmentEngine.assessRisks(legs, parlayMetrics);
        parlayMetrics.overall_risk_assessment = riskAssessment.overallRisk; // Add risk level to metrics
        if (riskAssessment.overallRisk === 'REJECTED') {
             parlayMetrics.rejection_reason = riskAssessment.risks.find(r => r.severity === 'CRITICAL')?.message || 'Critical risk factors identified.';
        }


        // --- 4. Generate Recommendations ---
        const recommendations = RecommendationEngine.generateRecommendations(parlayMetrics, riskAssessment);


        // --- 5. Generate Summary ---
        const summary = this.generateSummary(parlayMetrics, riskAssessment, recommendations);

        this.logger.info(`✅ Parlay evaluation complete. Verdict: ${summary.verdict}, EV: ${parlayMetrics.parlay_ev_per_100}%, Risk: ${riskAssessment.overallRisk}`);

        return {
            // Return the structure expected by aiService
            legs: legs, // Return the input legs (potentially annotated by AI)
            combined_parlay_metrics: parlayMetrics,
            riskAssessment: riskAssessment,
            recommendations: recommendations,
            summary: summary,
            error: null
        };

    } catch (error) {
      this.logger.error('❌ Quantitative analysis failed critically:', error);
       sentryService.captureError(error, { component: 'quantitativeService', operation: 'evaluateParlay_Overall', level: 'error' });
      return {
        error: `Analysis failed: ${error.message}`,
        summary: { verdict: 'ERROR', primaryAction: 'Internal analysis error occurred.' },
        combined_parlay_metrics: null, riskAssessment: null, recommendations: null
      };
    }
  }

  // Simplified summary generation
  generateSummary(parlayMetrics, riskAssessment, recommendations) {
    const verdict = riskAssessment.overallRisk === 'REJECTED' ? 'REJECTED' :
                    (parlayMetrics.parlay_ev_per_100 > 0 ? 'POSITIVE_EV' : 'NEGATIVE_EV');

    let confidence = 'MEDIUM';
    if (riskAssessment.overallRisk === 'LOW' && parlayMetrics.parlay_ev_per_100 > 5) confidence = 'HIGH';
    if (riskAssessment.overallRisk === 'HIGH' || riskAssessment.overallRisk === 'REJECTED' || parlayMetrics.parlay_ev_per_100 <= 0) confidence = 'LOW';

    return {
      verdict: verdict, // REJECTED, POSITIVE_EV, NEGATIVE_EV
      confidence: confidence, // LOW, MEDIUM, HIGH
      keyMetric: `EV: ${parlayMetrics?.parlay_ev_per_100?.toFixed(1)}%`,
      riskLevel: riskAssessment?.overallRisk ?? 'UNKNOWN',
      primaryAction: recommendations?.primaryAction || 'Review details carefully.'
    };
  }


    // --- Deprecated/Placeholder Methods ---
    // These are kept for reference or if needed later but are not the primary focus now

    async evaluateParlayWithValidation(legs, parlayDecimalOdds, sportKey) {
       console.warn("evaluateParlayWithValidation is deprecated; validation should be part of the leg data passed to evaluateParlay.");
       // Simple pass-through, assuming validation flags are already in legs
       return this.evaluateParlay(legs);
    }


    async sensitivityAnalysis(legs, parlayDecimalOdds) {
       console.warn("sensitivityAnalysis is not fully implemented with the new EV structure.");
       // Basic structure, needs rework to use model_probability from legs
       return {
           message: "Sensitivity analysis needs update for the new data structure.",
           baseEvaluation: await this.evaluateParlay(legs), // Evaluate as-is
           breakEvenAnalysis: [],
           mostVulnerableLeg: null
       };
    }

   async runMonteCarloSimulation(legs, simulations = 1000) { // Reduced default sims
       console.warn("runMonteCarloSimulation is a placeholder.");
       const evalResult = await this.evaluateParlay(legs);
       return {
           message: "Monte Carlo simulation is a basic placeholder.",
           simulations,
           estimatedWinProbability: evalResult?.combined_parlay_metrics?.combined_probability_product ?? 0, // Use calculated prob
           estimatedEV: evalResult?.combined_parlay_metrics?.parlay_ev_per_100 ?? 0
       };
   }

   async processFeedback(feedback) {
       console.log("Feedback received (placeholder):", feedback);
       // In a real implementation: store feedback linked to parlay ID/legs
       return true;
   }

    async quickEvaluate(legs) {
        console.warn("quickEvaluate is deprecated; use evaluateParlay and extract summary.");
        try {
            const fullAnalysis = await this.evaluateParlay(legs);
            if (fullAnalysis.error) return { error: fullAnalysis.error, verdict: 'ERROR' };

             return {
                verdict: fullAnalysis.summary.verdict,
                confidence: fullAnalysis.summary.confidence,
                calibratedEV: fullAnalysis.combined_parlay_metrics?.parlay_ev_per_100,
                jointProbability: fullAnalysis.combined_parlay_metrics?.combined_probability_product,
                riskLevel: fullAnalysis.riskAssessment?.overallRisk,
                recommendedStakeFraction: fullAnalysis.combined_parlay_metrics?.kelly_stake?.recommended_fraction,
                primaryRecommendation: fullAnalysis.summary.primaryAction
            };
        } catch (error) {
             console.error('❌ Quick evaluation failed:', error.message);
             return { error: `Quick evaluation failed: ${error.message}`, verdict: 'ERROR' };
        }
    }


} // End QuantitativeService Class

// Create and export singleton instance
const quantitativeServiceInstance = new QuantitativeService();

export default quantitativeServiceInstance;

// Export internal classes if needed for testing or direct use elsewhere (optional)
export {
  ProbabilityCalculator,
  RiskAssessmentEngine,
  RecommendationEngine,
  QuantitativeService // Export the class itself too
};
