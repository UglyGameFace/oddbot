// src/services/gamesService.js - INSTITUTIONAL MARKET DATA ENGINE
import oddsService from './oddsService.js';
import advancedOddsModel from './advancedOddsModel.js';
import sentryService from './sentryService.js';

class InstitutionalMarketDataEngine {
  constructor() {
    console.log('✅ Institutional Market Data Engine Initialized.');
  }

  /**
   * Provides a fully enhanced market data set for a given sport.
   * @param {string} sportKey The key for the sport (e.g., 'americanfootball_nfl').
   * @returns {Promise<Array>} A list of game objects enhanced with quantitative metrics.
   */
  async getEnhancedMarketData(sportKey) {
    const transaction = sentryService.startTransaction({ op: 'service', name: 'get_enhanced_market_data' });
    try {
      // 1. Fetch base odds data
      const baseGames = await oddsService.getSportOdds(sportKey);
      if (!baseGames || baseGames.length === 0) {
        return [];
      }

      // 2. Enhance each game with advanced models
      const enhancedGames = baseGames.map(game => this.enhanceWithDerivatives(game));
      
      transaction.setStatus('ok');
      return enhancedGames;

    } catch (error) {
      transaction.setStatus('internal_error');
      sentryService.captureError(error, { component: 'games_service' });
      throw new Error('Failed to acquire and enhance market data.');
    } finally {
        transaction.finish();
    }
  }
  
  /**
   * Enhances a single game object with calculated derivatives and metrics.
   * @param {object} game The basic game object from oddsService.
   * @returns {object} The game object with an added 'derivatives' property.
   */
  enhanceWithDerivatives(game) {
    // This is where various quantitative models are applied to the raw odds.
    const derivatives = {
      impliedProbabilities: advancedOddsModel.calculateImpliedProbabilities(game),
      featureEngineering: advancedOddsModel.engineerGameFeatures(game),
      // In a full HFT system, volatility, correlation, etc., would be calculated here.
    };
    return { ...game, derivatives };
  }
}

export default new InstitutionalMarketDataEngine();
