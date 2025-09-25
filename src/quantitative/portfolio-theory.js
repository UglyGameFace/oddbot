// src/quantitative/portfolio-theory.js - INSTITUTIONAL PORTFOLIO OPTIMIZATION ENGINE
import { Matrix } from 'ml-matrix';
import { randomBytes } from 'crypto';

/**
 * Generates a cryptographically secure random floating-point number between 0 (inclusive) and 1 (exclusive).
 * This replaces the less reliable Math.random() for all quantitative simulations.
 * @returns {number} A secure random number.
 */
function secureRandom() {
  const buffer = randomBytes(4); // 4 bytes provides 2^32 possible values
  return buffer.readUInt32BE(0) / 0x100000000; // Divide by 2^32 to get a value in [0, 1)
}

class PortfolioOptimizer {
  constructor(config) {
    this.assets = config.assets; // Assets should be signals/bets
    this.constraints = config.constraints || {};
    this.riskFreeRate = config.riskFreeRate || 0.02; // e.g., 2%
    
    // Pre-computation
    this.expectedReturns = new Matrix([this.assets.map(a => a.expectedReturn)]);
    this.covarianceMatrix = this.calculateCovarianceMatrix();
  }

  calculateCovarianceMatrix() {
    // In a real system, this would be derived from historical return series.
    // Here, we simulate a plausible covariance matrix based on asset correlations.
    const numAssets = this.assets.length;
    const matrix = Matrix.zeros(numAssets, numAssets);
    for (let i = 0; i < numAssets; i++) {
      for (let j = 0; j < numAssets; j++) {
        if (i === j) {
          matrix.set(i, j, Math.pow(this.assets[i].volatility, 2));
        } else {
          // Use provided correlation, or assume a default
          const correlation = this.assets[i].correlations[this.assets[j].id] || 0.2;
          const covariance = correlation * this.assets[i].volatility * this.assets[j].volatility;
          matrix.set(i, j, covariance);
        }
      }
    }
    return matrix;
  }

  /**
   * Finds the single portfolio on the efficient frontier with the maximum Sharpe ratio.
   * @returns {object} The portfolio with the highest risk-adjusted return.
   */
  findOptimalPortfolio() {
    // This is a simplified Monte Carlo approach to find the max Sharpe portfolio.
    // A production system would use quadratic programming (e.g., via a Python microservice).
    let optimalPortfolio = null;
    let maxSharpe = -Infinity;

    for (let i = 0; i < 5000; i++) { // 5000 random portfolios
      const weights = this.generateRandomWeights();
      const metrics = this.calculatePortfolioMetrics(weights);
      if (metrics.sharpeRatio > maxSharpe) {
        maxSharpe = metrics.sharpeRatio;
        optimalPortfolio = metrics;
      }
    }
    // Add the selected assets to the final portfolio object for easy reference
    if (optimalPortfolio) {
        optimalPortfolio.assets = this.assets;
    }
    return optimalPortfolio;
  }
  
  generateRandomWeights() {
    const numAssets = this.assets.length;
    // --- MODIFICATION: Using secureRandom() instead of Math.random() ---
    let weights = Array.from({ length: numAssets }, () => secureRandom());
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    // Normalize to sum to 1
    weights = weights.map(w => w / totalWeight); 
    return weights;
  }

  calculatePortfolioMetrics(weights) {
    const weightsMatrix = new Matrix([weights]);
    const expectedReturn = weightsMatrix.mmul(this.expectedReturns.transpose()).get(0, 0);
    
    const portfolioVariance = weightsMatrix.mmul(this.covarianceMatrix).mmul(weightsMatrix.transpose()).get(0, 0);
    const volatility = Math.sqrt(portfolioVariance);
    const sharpeRatio = volatility > 0 ? (expectedReturn - this.riskFreeRate) / volatility : 0;

    return { weights, expectedReturn, volatility, sharpeRatio };
  }
}

class RiskManager {
    /**
     * Applies risk constraints to an optimized portfolio.
     * @param {object} portfolio The optimized portfolio.
     * @param {object} riskProfile User's risk settings.
     * @returns {object} A risk-adjusted portfolio.
     */
    static applyRiskOverlay(portfolio, riskProfile) {
        if (!portfolio) return null;
        let riskAdjustedPortfolio = { ...portfolio };
        
        // Example: Cap volatility
        if (riskProfile.maxVolatility && portfolio.volatility > riskProfile.maxVolatility) {
            const reductionFactor = riskProfile.maxVolatility / portfolio.volatility;
            const riskyAssetWeight = reductionFactor;
            const riskFreeAssetWeight = 1 - riskyAssetWeight;

            riskAdjustedPortfolio.weights = portfolio.weights.map(w => w * riskyAssetWeight);
            riskAdjustedPortfolio.note = `Volatility capped at ${(riskProfile.maxVolatility * 100).toFixed(1)}%. ${(riskFreeAssetWeight*100).toFixed(1)}% of capital should be held back (risk-free).`;
        }

        return riskAdjustedPortfolio;
    }
}

export { PortfolioOptimizer, RiskManager };
