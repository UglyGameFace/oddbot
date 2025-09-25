// src/services/oddsService.js - PROVEN ODDS PROVIDER FOR ALL SPORTS
import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentryService from './sentryService.js';

class ProvenOddsService {
  constructor() {
    this.providers = ['the-odds-api']; // Add 'sportradar', 'api-sports' if keys are provided
    console.log('✅ Proven Odds Service Initialized.');
  }

  async getAllSportsOdds() {
    const sports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
    const allOddsPromises = sports.map(sport => this.getSportOdds(sport));
    const results = await Promise.allSettled(allOddsPromises);
    const allOdds = results
      .filter(res => res.status === 'fulfilled' && res.value)
      .flatMap(res => res.value);
    return this.processAndDeduplicateOdds(allOdds);
  }

  async getSportOdds(sportKey) {
    const cacheKey = `odds:${sportKey}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read' });
    }

    // If not cached, fetch from providers
    for (const provider of this.providers) {
        try {
            if (provider === 'the-odds-api' && env.THE_ODDS_API_KEY) {
                const oddsData = await this.fetchFromTheOddsAPI(sportKey);
                if (oddsData && oddsData.length > 0) {
                    await redis.set(cacheKey, JSON.stringify(oddsData), 'EX', 900); // 15-min cache
                    return oddsData;
                }
            }
            // Add other provider fetch logic here
        } catch (error) {
            console.warn(`Provider ${provider} failed for ${sportKey}: ${error.message}`);
            sentryService.captureError(error, { component: 'odds_fetch', provider, sportKey });
        }
    }
    return []; // Return empty array if all providers fail
  }

  async fetchFromTheOddsAPI(sportKey) {
    const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
      params: {
        apiKey: env.THE_ODDS_API_KEY,
        regions: 'us',
        markets: 'h2h,spreads,totals',
        oddsFormat: 'american',
      },
      timeout: 10000
    });
    return this.transformTheOddsData(response.data, sportKey);
  }

  transformTheOddsData(apiData, sportKey) {
    return (apiData || []).map(game => ({
      game_id: game.id,
      sport_key: sportKey,
      sport_title: game.sport_title,
      commence_time: game.commence_time,
      home_team: game.home_team,
      away_team: game.away_team,
      bookmakers: game.bookmakers || [],
    }));
  }
  
  processAndDeduplicateOdds(oddsArray) {
    const uniqueGames = new Map();
    oddsArray.forEach(game => {
      const key = `${game.home_team}-${game.away_team}-${game.commence_time}`;
      if (!uniqueGames.has(key)) {
        uniqueGames.set(key, game);
      }
    });
    return Array.from(uniqueGames.values());
  }
}

export default new ProvenOddsService();
