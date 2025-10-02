// src/services/dataQualityService.js
import { sentryService } from './sentryService.js';

export class DataQualityService {
  static assessGameDataQuality(game) {
    let score = 0;
    let factors = [];

    if (game.home_team && game.away_team) {
      score += 30;
      factors.push('teams_available');
    }

    if (game.commence_time) {
      score += 20;
      factors.push('start_time_available');
    }

    if (game.bookmakers && game.bookmakers.length > 0) {
      score += 30;
      factors.push(`odds_from_${game.bookmakers.length}_books`);
    }

    if (game.bookmakers && game.bookmakers.length >= 3) {
      score += 20;
      factors.push('multiple_sources');
    }

    // Additional quality checks
    if (game.home_team !== 'N/A' && game.away_team !== 'N/A') {
      score += 10;
      factors.push('valid_team_names');
    }

    if (game.market_data?.last_updated) {
      const lastUpdated = new Date(game.market_data.last_updated);
      const now = new Date();
      const hoursSinceUpdate = (now - lastUpdated) / (1000 * 60 * 60);
      
      if (hoursSinceUpdate < 1) {
        score += 10;
        factors.push('recently_updated');
      } else if (hoursSinceUpdate < 6) {
        score += 5;
        factors.push('moderately_fresh');
      }
    }

    return {
      score: Math.min(100, score),
      factors,
      rating: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor',
      timestamp: new Date().toISOString()
    };
  }

  static assessDataQuality(games) {
    if (!games || games.length === 0) {
      return { score: 0, rating: 'poor', total_games: 0, assessment: 'no_data' };
    }

    const totalScore = games.reduce((sum, game) => sum + (game.data_quality?.score || 0), 0);
    const averageScore = totalScore / games.length;

    // Assess distribution
    const qualityDistribution = {
      excellent: games.filter(g => g.data_quality?.rating === 'excellent').length,
      good: games.filter(g => g.data_quality?.rating === 'good').length,
      fair: games.filter(g => g.data_quality?.rating === 'fair').length,
      poor: games.filter(g => g.data_quality?.rating === 'poor').length
    };

    const overallRating = averageScore >= 80 ? 'excellent' : 
                         averageScore >= 60 ? 'good' : 
                         averageScore >= 40 ? 'fair' : 'poor';

    return {
      score: Math.round(averageScore),
      rating: overallRating,
      total_games: games.length,
      quality_distribution: qualityDistribution,
      games_with_odds: games.filter(g => g.bookmakers && g.bookmakers.length > 0).length,
      games_with_multiple_books: games.filter(g => g.bookmakers && g.bookmakers.length >= 3).length,
      average_books_per_game: games.reduce((sum, g) => sum + (g.bookmakers?.length || 0), 0) / games.length
    };
  }

  static isGameReadyForAnalysis(game) {
    const basicRequirements = game.home_team && 
                             game.away_team && 
                             game.commence_time;
    
    const oddsRequirements = game.bookmakers && 
                            game.bookmakers.length >= 2 &&
                            this.hasValidMarkets(game);

    return basicRequirements && oddsRequirements;
  }

  static hasValidMarkets(game) {
    if (!game.bookmakers) return false;
    
    for (const bookmaker of game.bookmakers) {
      if (bookmaker.markets && bookmaker.markets.length > 0) {
        for (const market of bookmaker.markets) {
          if (market.outcomes && market.outcomes.length >= 2) {
            return true;
          }
        }
      }
    }
    return false;
  }

  static countMarkets(game) {
    if (!game.bookmakers) return 0;
    
    const markets = new Set();
    game.bookmakers.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        markets.add(market.key);
      });
    });
    
    return markets.size;
  }

  static assessMarketDepth(game) {
    if (!game.bookmakers) return { depth: 'none', markets: 0, books: 0 };

    const marketCount = this.countMarkets(game);
    const bookmakerCount = game.bookmakers.length;

    let depth = 'shallow';
    if (marketCount >= 5 && bookmakerCount >= 5) depth = 'deep';
    else if (marketCount >= 3 && bookmakerCount >= 3) depth = 'moderate';
    else if (marketCount >= 1 && bookmakerCount >= 1) depth = 'basic';

    return {
      depth,
      markets: marketCount,
      books: bookmakerCount,
      has_moneyline: this.hasMarketType(game, 'h2h'),
      has_spreads: this.hasMarketType(game, 'spreads'),
      has_totals: this.hasMarketType(game, 'totals')
    };
  }

  static hasMarketType(game, marketType) {
    if (!game.bookmakers) return false;
    
    for (const bookmaker of game.bookmakers) {
      if (bookmaker.markets?.some(market => market.key === marketType)) {
        return true;
      }
    }
    return false;
  }

  static validatePlayerPropsData(props) {
    if (!props || !Array.isArray(props)) return false;
    
    return props.length > 0 && props.every(bookmaker => {
      return bookmaker?.key && 
             bookmaker?.title && 
             Array.isArray(bookmaker.markets) &&
             bookmaker.markets.every(market => 
               market.key && Array.isArray(market.outcomes)
             );
    });
  }

  static assessProviderDataFreshness(providerData) {
    const now = new Date();
    let freshness = {
      overall: 'current',
      details: {},
      recommendations: []
    };

    if (providerData.timestamp) {
      const dataTime = new Date(providerData.timestamp);
      const hoursOld = (now - dataTime) / (1000 * 60 * 60);
      
      if (hoursOld < 1) {
        freshness.details.age = 'very_fresh';
        freshness.details.hours_old = hoursOld.toFixed(2);
      } else if (hoursOld < 6) {
        freshness.details.age = 'fresh';
        freshness.details.hours_old = hoursOld.toFixed(2);
      } else if (hoursOld < 24) {
        freshness.details.age = 'stale';
        freshness.details.hours_old = hoursOld.toFixed(2);
        freshness.recommendations.push('Consider refreshing data');
      } else {
        freshness.overall = 'outdated';
        freshness.details.age = 'very_stale';
        freshness.details.hours_old = hoursOld.toFixed(2);
        freshness.recommendations.push('Data needs immediate refresh');
      }
    }

    return freshness;
  }
}

export default DataQualityService;
