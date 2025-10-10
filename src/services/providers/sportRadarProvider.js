// src/services/providers/sportRadarProvider.js
import axios from 'axios';
// FIXED: Import the named export correctly
import { rateLimitService } from '../rateLimitService.js';
import { withTimeout } from '../../utils/asyncUtils.js';
import { sentryService } from '../sentryService.js';

const SPORTRADAR_BASE = 'https://api.sportradar.com/odds/v1/en/us/sports';

export class SportRadarProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sportradar';
    this.priority = 2;
  }

  async fetchSportOdds(sportKey, options = {}) {
    const radarSportKey = this.mapToSportRadarKey(sportKey);
    const url = `${SPORTRADAR_BASE}/${radarSportKey}/schedule.json`;
    
    const response = await withTimeout(
      axios.get(url, { 
        params: { 
          api_key: this.apiKey 
        } 
      }),
      10000,
      `sportradar_${sportKey}`
    );

    await rateLimitService.saveProviderQuota(this.name, response.headers);
    return this.transformData(response.data?.sport_events, sportKey);
  }

  mapToSportRadarKey(sportKey) {
    const mapping = {
      'americanfootball_nfl': 'nfl',
      'americanfootball_ncaaf': 'ncaafb',
      'basketball_nba': 'nba',
      'basketball_wnba': 'wnba',
      'basketball_ncaab': 'ncaamb',
      'baseball_mlb': 'mlb',
      'icehockey_nhl': 'nhl',
      'soccer_england_premier_league': 'epl'
    };
    return mapping[sportKey] || sportKey.split('_')[1] || 'nfl';
  }

  transformData(events, sportKey) {
    if (!Array.isArray(events)) {
      console.warn('⚠️ SportRadar returned non-array data');
      return [];
    }

    return events.reduce((acc, event) => {
      if (!event?.id || !event?.start_time) {
        console.warn(`[Data Validation] Discarding invalid SportRadar event: ${event?.id}`);
        return acc;
      }

      const title = event?.sport_event_context?.competition?.name || this.titleFromKey(sportKey);
      const competitors = event?.competitors || [];
      
      const enhancedGame = {
        event_id: `sr_${event.id}`,
        sport_key: sportKey,
        league_key: title,
        commence_time: event.start_time,
        home_team: competitors.find(c => c.qualifier === 'home')?.name || 'N/A',
        away_team: competitors.find(c => c.qualifier === 'away')?.name || 'N/A',
        market_data: { 
          bookmakers: this.extractMarketsFromEvent(event),
          last_updated: new Date().toISOString()
        },
        sport_title: title,
        data_quality: this.assessGameDataQuality(event),
        source: 'sportradar'
      };

      acc.push(enhancedGame);
      return acc;
    }, []);
  }

  extractMarketsFromEvent(event) {
    // SportRadar has different market structure - convert to common format
    const markets = [];
    
    if (event?.odds) {
      // Convert SportRadar odds to common format
      Object.entries(event.odds).forEach(([bookmaker, oddsData]) => {
        const bookmakerMarkets = {
          key: bookmaker,
          title: bookmaker,
          markets: []
        };

        // Add moneyline markets if available
        if (oddsData.moneyline) {
          bookmakerMarkets.markets.push({
            key: 'h2h',
            outcomes: Object.entries(oddsData.moneyline).map(([team, price]) => ({
              name: team,
              price: this.convertToAmericanOdds(price)
            }))
          });
        }

        markets.push(bookmakerMarkets);
      });
    }

    return markets;
  }

  convertToAmericanOdds(decimalOdds) {
    if (decimalOdds >= 2.0) {
      return Math.round((decimalOdds - 1) * 100);
    } else {
      return Math.round(-100 / (decimalOdds - 1));
    }
  }

  assessGameDataQuality(game) {
    return {
      score: 60, // SportRadar typically has good data quality but limited markets
      factors: ['sportradar_source', 'official_data'],
      rating: 'good'
    };
  }

  titleFromKey(key) {
    const sportMapping = {
      'americanfootball_nfl': 'NFL',
      'americanfootball_ncaaf': 'NCAAF',
      'basketball_nba': 'NBA',
      'basketball_wnba': 'WNBA',
      'baseball_mlb': 'MLB',
      'icehockey_nhl': 'NHL',
      'soccer_england_premier_league': 'Premier League'
    };
    return sportMapping[key] || key.split('_').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }

  async getProviderStatus() {
    try {
      const quota = await rateLimitService.getProviderQuota(this.name);
      return {
        name: this.name,
        status: quota ? 'active' : 'unknown',
        priority: this.priority,
        last_quota_check: quota?.at ? new Date(quota.at).toISOString() : null,
        remaining_requests: quota?.remaining,
        should_bypass: await rateLimitService.shouldBypassLive(this.name)
      };
    } catch (error) {
      return {
        name: this.name,
        status: 'error',
        error: error.message
      };
    }
  }
}
