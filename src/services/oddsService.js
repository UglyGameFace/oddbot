// src/services/oddsService.js - PROVEN ODDS SERVICE WITH DYNAMIC SPORT SUPPORT

import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentryService from './sentryService.js';

class ProvenOddsService {
  constructor() {
    this.providers = [];
    if (env.THE_ODDS_API_KEY) {
      this.providers.push({
        name: 'the-odds-api',
        url: 'https://api.the-odds-api.com/v4/sports',
        apiKey: env.THE_ODDS_API_KEY
      });
    }
    if (env.SPORTRADAR_API_KEY) {
      this.providers.push({
        name: 'sportradar',
        url: 'https://api.sportradar.com',
        apiKey: env.SPORTRADAR_API_KEY
      });
    }
    console.log('✅ Proven Odds Service Initialized:', this.providers.map(p => p.name).join(', '));
  }

  /**
   * NEW: Fetches a list of all available sports from the provider and caches it for 24 hours.
   * @returns {Promise<Array<{key: string, title: string}>>} A list of supported sports.
   */
  async getSupportedSports() {
    const cacheKey = 'supported_sports_list';
    const CACHE_TTL = 86400; // Cache for 24 hours

    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_sports_cache_read' });
    }

    const provider = this.providers.find(p => p.name === 'the-odds-api');
    if (!provider) {
        console.error('The Odds API provider not configured for dynamic sport fetching.');
        return [];
    }

    try {
      const response = await axios.get(provider.url, {
        params: { apiKey: provider.apiKey }
      });

      if (response.data && Array.isArray(response.data)) {
        const sports = response.data
          .filter(sport => sport.active === true) // Only include active sports
          .map(sport => ({
            key: sport.key,
            title: sport.title
          }));

        await redis.set(cacheKey, JSON.stringify(sports), 'EX', CACHE_TTL);
        return sports;
      }
      return [];
    } catch (error) {
      sentryService.captureError(error, { component: 'odds_fetch_supported_sports' });
      console.error('Failed to fetch supported sports from API:', error.message);
      return [];
    }
  }

  /**
   * Returns the best provider's odds for the sportKey, or falls back to alternatives as needed.
   */
  async getSportOdds(sportKey) {
    const cacheKey = `odds_${sportKey}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read', sportKey });
    }

    for (const provider of this.providers) {
      try {
        let games = [];
        if (provider.name === 'the-odds-api') {
          const res = await axios.get(
            `${provider.url}/${sportKey}/odds`,
            {
              params: {
                apiKey: provider.apiKey,
                regions: 'us',
                markets: 'h2h,spreads,totals',
                oddsFormat: 'american'
              }
            }
          );
          if (Array.isArray(res.data) && res.data.length) {
            games = res.data.map(g => ({
              id: g.id,
              home_team: g.home_team,
              away_team: g.away_team,
              commence_time: g.commence_time,
              sport_key: g.sport_key,
              sport_title: g.sport_title,
              bookmakers: g.bookmakers
            }));
            await redis.set(cacheKey, JSON.stringify(games), 'EX', 300); // 5-minute expiry for odds
            return games;
          }
        } else if (provider.name === 'sportradar') {
          // This is an example endpoint; you'd need to adapt it for Sportradar's specific structure.
          const endpoint = `${provider.url}/odds/${sportKey}/live.json?api_key=${provider.apiKey}`;
          const res = await axios.get(endpoint);
          if (res.data && Array.isArray(res.data.games) && res.data.games.length) {
            games = res.data.games.map(g => ({
              id: g.id,
              home_team: g.home_name,
              away_team: g.away_name,
              commence_time: g.scheduled,
              sport_key: sportKey,
              sport_title: g.sport || sportKey,
              bookmakers: g.odds
            }));
            await redis.set(cacheKey, JSON.stringify(games), 'EX', 300);
            return games;
          }
        }
      } catch (err) {
        sentryService.captureError(err, { component: `odds_${provider.name}_fetch`, sportKey });
        console.warn(`Odds fetch failed for provider ${provider.name} sportKey ${sportKey}: ${err?.message || 'Unknown error'}`);
      }
    }
    await redis.set(cacheKey, '[]', 'EX', 60); // Cache empty result for 1 minute
    return [];
  }

  /**
   * Returns a flat, deduplicated odds list for all popular US sports/leagues.
   */
  async getAllSportsOdds() {
    const sports = await this.getSupportedSports();
    const allSupportedKeys = sports.map(s => s.key);
    
    const promises = allSupportedKeys.map(sportKey => this.getSportOdds(sportKey));
    const results = await Promise.allSettled(promises);

    const allOdds = results
      .filter(res => res.status === 'fulfilled' && res.value?.length > 0)
      .flatMap(res => res.value);
      
    return this.processAndDeduplicateOdds(allOdds);
  }

  /**
   * Deduplicates games based on a composite key and sorts them by start time.
   */
  processAndDeduplicateOdds(games) {
    const deduped = new Map();
    for (const g of games) {
      const key = `${g.home_team}_${g.away_team}_${g.commence_time}`;
      if (!deduped.has(key)) {
        deduped.set(key, g);
      }
    }
    const uniqueGames = Array.from(deduped.values());
    uniqueGames.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    return uniqueGames;
  }
}

export default new ProvenOddsService();
