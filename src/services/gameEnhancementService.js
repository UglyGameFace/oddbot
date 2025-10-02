// src/services/gameEnhancementService.js
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import { DataQualityService } from './dataQualityService.js';

export class GameEnhancementService {
  static enhanceGameData(games, sportKey, source) {
    if (!games || !Array.isArray(games)) return [];
    return games.map(game => this.enhanceSingleGame(game, sportKey, source));
  }

  static enhanceSingleGame(game, sportKey = null, source = 'unknown') {
    const enhanced = { ...game };
    
    // Add core enhancement fields
    enhanced.id = game.id || game.event_id || `${sportKey}_${game.commence_time}_${game.home_team}_${game.away_team}`.replace(/\s+/g, '_');
    enhanced.sport_key = sportKey || game.sport_key;
    enhanced.sport_title = COMPREHENSIVE_SPORTS[sportKey]?.title || game.sport_title || sportKey;
    
    // Add AI analysis fields
    enhanced.display_name = `${game.away_team} @ ${game.home_team}`;
    enhanced.short_name = `${this.abbreviateTeam(game.away_team)} @ ${this.abbreviateTeam(game.home_team)}`;
    enhanced.time_until = this.calculateTimeUntil(game.commence_time);
    
    // Add data quality assessment
    enhanced.data_quality = DataQualityService.assessGameDataQuality(game);
    enhanced.analysis_ready = DataQualityService.isGameReadyForAnalysis(game);
    enhanced.market_depth = DataQualityService.assessMarketDepth(game);
    
    // Add odds availability info
    enhanced.odds_available = !!(game.bookmakers && game.bookmakers.length > 0);
    enhanced.market_variety = DataQualityService.countMarkets(game);
    enhanced.best_odds = this.extractBestOdds(game);
    
    // Add team cleaning
    enhanced.home_team_clean = this.cleanTeamName(game.home_team);
    enhanced.away_team_clean = this.cleanTeamName(game.away_team);
    enhanced.tournament = game.tournament || this.inferTournament(sportKey, game);
    
    // Add metadata
    enhanced.source = source;
    enhanced.last_updated = game.last_updated || new Date().toISOString();
    enhanced.enhancement_version = '2.0';
    
    return enhanced;
  }

  static calculateTimeUntil(commenceTime) {
    if (!commenceTime) return null;
    
    const now = new Date();
    const gameTime = new Date(commenceTime);
    const diffMs = gameTime - now;
    
    if (diffMs < 0) return 'started';
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    
    if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
    if (diffHours > 0) return `${diffHours}h ${diffMinutes % 60}m`;
    if (diffMinutes > 0) return `${diffMinutes}m`;
    
    return 'soon';
  }

  static extractBestOdds(game) {
    if (!game.bookmakers || game.bookmakers.length === 0) return null;

    const bestOdds = {
      moneyline: { home: null, away: null },
      spread: { home: null, away: null },
      total: { over: null, under: null }
    };

    game.bookmakers.forEach(bookmaker => {
      bookmaker.markets?.forEach(market => {
        if (market.key === 'h2h' && market.outcomes) {
          market.outcomes.forEach(outcome => {
            const teamType = outcome.name === game.home_team ? 'home' : 'away';
            const current = bestOdds.moneyline[teamType];
            if (!current || outcome.price > current.price) {
              bestOdds.moneyline[teamType] = {
                price: outcome.price,
                bookmaker: bookmaker.title,
                point: outcome.point,
                price_decimal: this.americanToDecimal(outcome.price)
              };
            }
          });
        } else if (market.key === 'spreads' && market.outcomes) {
          market.outcomes.forEach(outcome => {
            const teamType = outcome.name === game.home_team ? 'home' : 'away';
            const current = bestOdds.spread[teamType];
            if (!current || outcome.price > current.price) {
              bestOdds.spread[teamType] = {
                price: outcome.price,
                point: outcome.point,
                bookmaker: bookmaker.title,
                price_decimal: this.americanToDecimal(outcome.price)
              };
            }
          });
        } else if (market.key === 'totals' && market.outcomes) {
          market.outcomes.forEach(outcome => {
            const overUnder = outcome.name.toLowerCase().includes('over') ? 'over' : 'under';
            const current = bestOdds.total[overUnder];
            if (!current || outcome.price > current.price) {
              bestOdds.total[overUnder] = {
                price: outcome.price,
                point: outcome.point,
                bookmaker: bookmaker.title,
                price_decimal: this.americanToDecimal(outcome.price)
              };
            }
          });
        }
      });
    });

    return bestOdds;
  }

  static americanToDecimal(americanOdds) {
    if (americanOdds > 0) {
      return (americanOdds / 100) + 1;
    } else {
      return (100 / Math.abs(americanOdds)) + 1;
    }
  }

  static cleanTeamName(teamName) {
    if (!teamName) return '';
    
    return teamName
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\./, '')
      .replace(/\.$/, '')
      .replace(/\s*\([^)]*\)$/, '') // Remove trailing parentheses
      .replace(/^[^a-zA-Z0-9]*/, '') // Remove leading non-alphanumeric
      .replace(/[^a-zA-Z0-9]*$/, ''); // Remove trailing non-alphanumeric
  }

  static abbreviateTeam(teamName) {
    if (!teamName) return '';
    
    const abbreviations = {
      'san francisco': 'SF',
      'los angeles': 'LA',
      'new york': 'NY',
      'chicago': 'CHI',
      'boston': 'BOS',
      'philadelphia': 'PHI',
      'dallas': 'DAL',
      'miami': 'MIA',
      'atlanta': 'ATL',
      'houston': 'HOU',
      'detroit': 'DET',
      'phoenix': 'PHX',
      'seattle': 'SEA',
      'minnesota': 'MIN',
      'denver': 'DEN',
      'cleveland': 'CLE',
      'tampa bay': 'TB',
      'carolina': 'CAR',
      'new england': 'NE',
      'green bay': 'GB',
      'kansas city': 'KC',
      'las vegas': 'LV',
      'los angeles lakers': 'LAL',
      'los angeles clippers': 'LAC',
      'golden state': 'GSW',
      'san antonio': 'SAS',
      'oklahoma city': 'OKC',
      'new orleans': 'NO'
    };

    const lowerName = teamName.toLowerCase();
    for (const [full, abbr] of Object.entries(abbreviations)) {
      if (lowerName.includes(full)) {
        return abbr;
      }
    }

    // Return first 3-4 characters if no abbreviation found
    const words = teamName.split(' ');
    if (words.length > 1) {
      return words.map(word => word.charAt(0).toUpperCase()).join('');
    }
    
    return teamName.substring(0, 3).toUpperCase();
  }

  static inferTournament(sportKey, game) {
    const sport = COMPREHENSIVE_SPORTS[sportKey];
    if (!sport) return sportKey.replace(/_/g, ' ').toUpperCase();

    if (sportKey.includes('nfl')) return 'NFL';
    if (sportKey.includes('nba')) return 'NBA';
    if (sportKey.includes('mlb')) return 'MLB';
    if (sportKey.includes('nhl')) return 'NHL';
    if (sportKey.includes('ncaaf')) return 'NCAAF';
    if (sportKey.includes('ncaab')) return 'NCAAB';
    if (sportKey.includes('premier_league')) return 'Premier League';
    if (sportKey.includes('champions_league')) return 'Champions League';
    if (sportKey.includes('world_cup')) return 'World Cup';
    if (sportKey.includes('euro')) return 'European Championship';
    
    return sport.title;
  }

  static groupGamesByTournament(games) {
    const grouped = {};
    
    games.forEach(game => {
      const tournament = game.tournament || 'Other';
      if (!grouped[tournament]) {
        grouped[tournament] = {
          tournament,
          games: [],
          count: 0,
          start_time: game.commence_time,
          sports: new Set()
        };
      }
      
      grouped[tournament].games.push(game);
      grouped[tournament].count++;
      grouped[tournament].sports.add(game.sport_key);
      
      // Update earliest start time
      if (new Date(game.commence_time) < new Date(grouped[tournament].start_time)) {
        grouped[tournament].start_time = game.commence_time;
      }
    });

    // Convert to array and add metadata
    return Object.values(grouped).map(group => ({
      ...group,
      sports: Array.from(group.sports),
      display_name: `${group.tournament} (${group.count} games)`
    })).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  }

  static filterGamesByTime(games, hoursAhead = 24, includeLive = true) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    
    return games.filter(game => {
      if (!game.commence_time) return false;
      const gameTime = new Date(game.commence_time);
      
      if (includeLive && gameTime < now) {
        // Include games that started recently (last 3 hours)
        return (now - gameTime) < (3 * 60 * 60 * 1000);
      }
      
      return gameTime >= now && gameTime <= cutoff;
    });
  }

  static sortGames(games, sortBy = 'commence_time') {
    const sorted = [...games];
    
    switch (sortBy) {
      case 'commence_time':
        return sorted.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
      
      case 'data_quality':
        return sorted.sort((a, b) => (b.data_quality?.score || 0) - (a.data_quality?.score || 0));
      
      case 'market_depth':
        return sorted.sort((a, b) => (b.market_depth?.books || 0) - (a.market_depth?.books || 0));
      
      case 'team_name':
        return sorted.sort((a, b) => a.display_name.localeCompare(b.display_name));
      
      default:
        return sorted;
    }
  }

  static createGameSummary(games) {
    const summary = {
      total_games: games.length,
      games_by_sport: {},
      games_by_quality: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0
      },
      time_range: {
        earliest: null,
        latest: null
      },
      markets_available: new Set()
    };

    games.forEach(game => {
      // Count by sport
      const sport = game.sport_key;
      summary.games_by_sport[sport] = (summary.games_by_sport[sport] || 0) + 1;
      
      // Count by quality
      const quality = game.data_quality?.rating || 'poor';
      summary.games_by_quality[quality]++;
      
      // Track time range
      if (game.commence_time) {
        const gameTime = new Date(game.commence_time);
        if (!summary.time_range.earliest || gameTime < new Date(summary.time_range.earliest)) {
          summary.time_range.earliest = game.commence_time;
        }
        if (!summary.time_range.latest || gameTime > new Date(summary.time_range.latest)) {
          summary.time_range.latest = game.commence_time;
        }
      }
      
      // Track markets
      if (game.bookmakers) {
        game.bookmakers.forEach(bookmaker => {
          bookmaker.markets?.forEach(market => {
            summary.markets_available.add(market.key);
          });
        });
      }
    });

    summary.markets_available = Array.from(summary.markets_available);
    summary.games_with_odds = games.filter(g => g.odds_available).length;
    summary.analysis_ready_games = games.filter(g => g.analysis_ready).length;

    return summary;
  }
}

export default GameEnhancementService;
