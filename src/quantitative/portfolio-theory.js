// src/quantitative/portfolio-theory.js - INSTITUTIONAL PORTFOLIO OPTIMIZATION ENGINE
import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import { gaussian, uniform } from 'distributions';
import { mean, variance, covariance } from 'stats';

class PortfolioOptimizer {
  constructor(config) {
    this.assets = config.assets;
    this.constraints = config.constraints;
    this.objective = config.objective;
    this.riskFreeRate = config.riskFreeRate || 0.02;
    
    this.initializeOptimizationEngine();
  }

  initializeOptimizationEngine() {
    this.covarianceMatrix = this.calculateCovarianceMatrix();
    this.expectedReturns = this.calculateExpectedReturns();
    this.correlationMatrix = this.calculateCorrelationMatrix();
  }

  calculateCovarianceMatrix() {
    const returnsMatrix = this.assets.map(asset => asset.historicalReturns);
    const covMatrix = new Matrix(returnsMatrix).covariance();
    
    // Apply shrinkage estimator for better out-of-sample performance
    return this.applyLedoitWolfShrinkage(covMatrix);
  }

  applyLedoitWolfShrinkage(covMatrix) {
    // Ledoit-Wolf shrinkage estimator for covariance matrix
    const n = this.assets.length;
    const sampleMean = covMatrix.mean();
    const shrinkageTarget = Matrix.identity(n).mul(sampleMean);
    
    const shrinkageIntensity = this.calculateShrinkageIntensity(covMatrix);
    return covMatrix.mul(1 - shrinkageIntensity).add(shrinkageTarget.mul(shrinkageIntensity));
  }

  calculateExpectedReturns() {
    // Multiple methods for expected return estimation
    const methods = {
      historical: this.calculateHistoricalReturns(),
      capm: this.calculateCAPMReturns(),
      blackLitterman: this.calculateBlackLittermanReturns(),
      machineLearning: this.calculateMLReturns()
    };

    // Bayesian model averaging
    return this.bayesianModelAveraging(methods);
  }

  calculateEfficientFrontier(numPortfolios = 1000) {
    const frontiers = [];
    
    for (let i = 0; i < numPortfolios; i++) {
      try {
        const weights = this.generateFeasibleWeights();
        const portfolio = this.calculatePortfolioMetrics(weights);
        
        if (this.isEfficient(portfolio, frontiers)) {
          frontiers.push(portfolio);
        }
      } catch (error) {
        console.warn('Failed to calculate portfolio:', error);
      }
    }
    
    return this.sortEfficientFrontier(frontiers);
  }

  generateFeasibleWeights() {
    // Generate weights satisfying all constraints
    const weights = new Array(this.assets.length).fill(0);
    let remaining = 1.0;
    
    // Minimum variance starting point
    for (let i = 0; i < this.assets.length; i++) {
      const minWeight = this.constraints.minWeights?.[i] || 0;
      const maxWeight = this.constraints.maxWeights?.[i] || 1;
      
      const weight = Math.max(minWeight, Math.random() * (maxWeight - minWeight));
      weights[i] = weight;
      remaining -= weight;
    }
    
    // Redistribute remaining weight
    if (remaining !== 0) {
      this.redistributeWeight(weights, remaining);
    }
    
    return this.normalizeWeights(weights);
  }

  calculatePortfolioMetrics(weights) {
    const expectedReturn = this.calculatePortfolioReturn(weights);
    const variance = this.calculatePortfolioVariance(weights);
    const volatility = Math.sqrt(variance);
    const sharpeRatio = (expectedReturn - this.riskFreeRate) / volatility;
    
    return {
      weights,
      expectedReturn,
      variance,
      volatility,
      sharpeRatio,
      valueAtRisk: this.calculatePortfolioVaR(weights, volatility),
      conditionalVaR: this.calculatePortfolioCVaR(weights),
      maxDrawdown: this.estimateMaxDrawdown(weights),
      diversificationRatio: this.calculateDiversificationRatio(weights)
    };
  }

  calculatePortfolioVaR(weights, volatility, confidence = 0.95) {
    // Parametric VaR calculation
    const zScore = gaussian(0, 1).inv(confidence);
    return zScore * volatility;
  }

  calculatePortfolioCVaR(weights, confidence = 0.95) {
    // Monte Carlo simulation for CVaR
    const simulations = 10000;
    const returns = this.simulatePortfolioReturns(weights, simulations);
    const varThreshold = this.calculateHistoricalVaR(returns, confidence);
    
    const tailReturns = returns.filter(r => r <= varThreshold);
    return tailReturns.reduce((a, b) => a + b, 0) / tailReturns.length;
  }

  simulatePortfolioReturns(weights, simulations) {
    const returns = [];
    const chol = new CholeskyDecomposition(this.covarianceMatrix);
    
    for (let i = 0; i < simulations; i++) {
      const randomShocks = this.generateCorrelatedShocks(chol);
      const portfolioReturn = weights.reduce((sum, weight, j) => 
        sum + weight * (this.expectedReturns[j] + randomShocks[j]), 0);
      
      returns.push(portfolioReturn);
    }
    
    return returns;
  }

  findOptimalPortfolio(efficientFrontier, objective = 'max_sharpe') {
    switch (objective) {
      case 'max_sharpe':
        return efficientFrontier.reduce((best, current) => 
          current.sharpeRatio > best.sharpeRatio ? current : best);
      
      case 'min_variance':
        return efficientFrontier.reduce((best, current) => 
          current.variance < best.variance ? current : best);
      
      case 'max_return':
        return efficientFrontier.reduce((best, current) => 
          current.expectedReturn > best.expectedReturn ? current : best);
      
      case 'risk_parity':
        return this.calculateRiskParityPortfolio();
      
      default:
        throw new Error(`Unknown objective: ${objective}`);
    }
  }

  calculateRiskParityPortfolio() {
    // Risk parity portfolio optimization
    const riskContributions = this.assets.map(asset => 
      this.calculateRiskContribution(asset));
    
    const totalRisk = riskContributions.reduce((sum, rc) => sum + rc, 0);
    const targetRisk = totalRisk / this.assets.length;
    
    return this.optimizeForRiskParity(targetRisk);
  }

  optimizeForRiskParity(targetRisk) {
    // Numerical optimization for risk parity
    const objectiveFunction = (weights) => {
      const riskContributions = weights.map((w, i) => 
        this.calculateAssetRiskContribution(w, i));
      
      const deviations = riskContributions.map(rc => 
        Math.pow(rc - targetRisk, 2));
      
      return deviations.reduce((sum, dev) => sum + dev, 0);
    };

    return this.numericalOptimization(objectiveFunction);
  }
}

class RiskManager {
  static applyRiskOverlay(portfolio, riskProfile) {
    const riskAdjusted = { ...portfolio };
    
    // Value at Risk constraints
    if (riskProfile.varLimit) {
      riskAdjusted.weights = this.applyVaRConstraint(
        portfolio.weights, 
        riskProfile.varLimit
      );
    }
    
    // Drawdown constraints
    if (riskProfile.maxDrawdown) {
      riskAdjusted.weights = this.applyDrawdownConstraint(
        portfolio.weights,
        riskProfile.maxDrawdown
      );
    }
    
    // Concentration limits
    if (riskProfile.concentrationLimits) {
      riskAdjusted.weights = this.applyConcentrationLimits(
        portfolio.weights,
        riskProfile.concentrationLimits
      );
    }
    
    // Liquidity constraints
    if (riskProfile.liquidityRequirements) {
      riskAdjusted.weights = this.applyLiquidityConstraints(
        portfolio.weights,
        riskProfile.liquidityRequirements
      );
    }
    
    return this.recalculatePortfolioMetrics(riskAdjusted);
  }

  static applyVaRConstraint(weights, varLimit) {
    // Adjust weights to meet VaR constraint
    const currentVaR = this.calculatePortfolioVaR(weights);
    
    if (currentVaR > varLimit) {
      return this.reducePortfolioRisk(weights, currentVaR, varLimit);
    }
    
    return weights;
  }

  static reducePortfolioRisk(weights, currentVaR, targetVaR) {
    const reductionFactor = targetVaR / currentVaR;
    const riskFreeWeight = 1 - reductionFactor;
    
    // Shift portion to risk-free asset
    const adjustedWeights = weights.map(w => w * reductionFactor);
    adjustedWeights.push(riskFreeWeight); // Add risk-free asset
    
    return this.normalizeWeights(adjustedWeights);
  }

  static stressTestPortfolio(portfolio, scenarios) {
    const stressResults = scenarios.map(scenario => 
      this.applyStressScenario(portfolio, scenario));
    
    return {
      original: portfolio,
      stressTests: stressResults,
      worstCase: stressResults.reduce((worst, current) => 
        current.loss > worst.loss ? current : worst),
      scenarioAnalysis: this.analyzeStressScenarios(stressResults)
    };
  }

  static applyStressScenario(portfolio, scenario) {
    const stressedReturns = portfolio.assets.map(asset => 
      asset.expectedReturn * scenario.impactFactors[asset.id]);
    
    const stressedCovariance = this.applyStressToCovariance(
      portfolio.covarianceMatrix,
      scenario.volatilityShock
    );
    
    return this.calculatePortfolioMetricsUnderStress(
      portfolio.weights,
      stressedReturns,
      stressedCovariance
    );
  }
}

// Supporting mathematical classes
class CholeskyDecomposition {
  constructor(matrix) {
    this.matrix = matrix;
    this.decompose();
  }

  decompose() {
    const n = this.matrix.rows;
    this.L = Matrix.zeros(n, n);
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        
        for (let k = 0; k < j; k++) {
          sum += this.L.get(i, k) * this.L.get(j, k);
        }
        
        if (i === j) {
          this.L.set(i, j, Math.sqrt(this.matrix.get(i, i) - sum));
        } else {
          this.L.set(i, j, (this.matrix.get(i, j) - sum) / this.L.get(j, j));
        }
      }
    }
  }

  generateCorrelatedShocks() {
    const n = this.L.rows;
    const independentShocks = Array.from({ length: n }, () => 
      gaussian(0, 1).sample());
    
    return this.L.mmul(Matrix.columnVector(independentShocks)).getColumn(0);
  }
}

export { PortfolioOptimizer, RiskManager, CholeskyDecomposition };