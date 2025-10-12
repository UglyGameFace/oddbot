// src/workers/oddsIngestion.js - COMPLETE FIXED VERSION
import Redis from 'ioredis';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { rateLimitService } from '../services/rateLimitService.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
// --- CHANGE START ---
// Import the high-priority list instead of the full gamesService
import { HIGH_PRIORITY_SPORTS } from '../config/sportDefinitions.js';
// --- CHANGE END ---


process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION IN ODDS WORKER:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection in odds worker: ${reason}`), { extra: { promise } });
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add this to your odds ingestion worker - DISABLED_SPORTS array
const DISABLED_SPORTS = [
  'soccer_england_premier_league',
  'soccer_uefa_champions_league', 
  'mma_ufc'
];

// Then filter sports before processing
const sportsToProcess = highPrioritySports.filter(sport => 
  !DISABLED_SPORTS.includes(sport.sport_key)
);

class OddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    this.redisClient = null;
    this.subscriberClient = null;
    this.initialize();
  }

  async initialize() {
    try {
      this.redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
      this.subscriberClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
      console.log('✅ Odds worker created dedicated Redis clients.');
      this.initializeManualTrigger();
    } catch (error) {
      console.error('❌ Failed to initialize dedicated Redis clients for the worker:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_redis_init' });
    }
  }

  async initializeManualTrigger() {
    const channel = 'odds_ingestion_trigger';
    try {
      await this.subscriberClient.subscribe(channel);
      console.log(`✅ Worker listening for manual triggers on Redis channel: ${channel}`);

      this.subscriberClient.on('message', (ch, message) => {
        if (ch === channel && message === 'run') {
          console.log('🎯 MANUAL TRIGGER RECEIVED! Starting ingestion cycle...');
          this.runIngestionCycle('manual');
        }
      });
    } catch (error) {
        console.error('❌ Failed to initialize Redis subscriber for manual triggers:', error);
        sentryService.captureError(error, { component: 'odds_ingestion_worker_redis_subscriber' });
    }
  }

  async runIngestionCycle(source = 'unknown') {
    if (this.isJobRunning) {
      console.warn(`⏸️ Ingestion cycle skipped (source: ${source}): Previous cycle still running.`);
      return;
    }
    this.isJobRunning = true;
    console.log(`🚀 Starting odds ingestion cycle (source: ${source})...`);
    let totalUpsertedCount = 0;

    try {
      // --- CHANGE START ---
      // The worker now uses the predefined high-priority list instead of fetching all sports.
      const sportsToFetch = HIGH_PRIORITY_SPORTS.map(key => ({ sport_key: key }));
      // --- CHANGE END ---
      
      if (!sportsToFetch || !sportsToFetch.length) {
        console.warn('⚠️ ODDS WORKER: No high-priority sports configured. Cycle ending.');
        this.isJobRunning = false;
        return;
      }
      
      console.log(`📋 Processing ${sportsToFetch.length} high-priority sports.`);
      const batchSize = env.ODDS_INGESTION_BATCH_SIZE || 5;
      const interBatchDelay = env.ODDS_INGESTION_DELAY_MS || 2000;

      const providerUsage = {
        theodds: { calls: 0, lastHeaders: null },
        sportradar: { calls: 0, lastHeaders: null },
        apisports: { calls: 0, lastHeaders: null }
      };

      for (let i = 0; i < sportsToFetch.length; i += batchSize) {
        const batch = sportsToFetch.slice(i, i + batchSize);
        console.log(`🔄 Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(sportsToFetch.length / batchSize)}...`);
        
        await Promise.all(batch.map(async (sport) => {
          try {
            console.log(`   📥 Fetching odds for ${sport.sport_key}...`);
            // This call will now also update the cache for these popular sports
            const oddsForSport = await OddsService.getSportOdds(sport.sport_key, { useCache: false });
            
            if (oddsForSport && oddsForSport._headers) {
              const provider = this._detectProviderFromResponse(oddsForSport._headers);
              if (provider) {
                providerUsage[provider].calls++;
                providerUsage[provider].lastHeaders = oddsForSport._headers;
                console.log(`   📊 ${provider} call #${providerUsage[provider].calls} for ${sport.sport_key}`);
              }
              delete oddsForSport._headers;
            }

            if (oddsForSport && oddsForSport.length > 0) {
              console.log(`   ✅ Fetched ${oddsForSport.length} games for ${sport.sport_key}.`);
              const result = await DatabaseService.upsertGames(oddsForSport);
              if (result.data) {
                totalUpsertedCount += result.data.length;
              }
            } else {
              console.log(`   ⚠️ No odds found for ${sport.sport_key}`);
            }
          } catch (e) {
              console.error(`   ❌ Failed to process odds for ${sport.sport_key}:`, e.message);
              sentryService.captureError(e, { 
                component: 'odds_ingestion_worker_sport_failure', 
                sport_key: sport.sport_key 
              });
          }
        }));

        await this._saveProviderQuotas(providerUsage);

        if (i + batchSize < sportsToFetch.length) {
            console.log(`   ⏳ Batch complete. Waiting for ${interBatchDelay / 1000} seconds before next batch...`);
            await delay(interBatchDelay);
        }
      }

      await this._saveProviderQuotas(providerUsage);

      if (totalUpsertedCount > 0) {
        console.log(`✅ Ingestion cycle complete. Total upserted games: ${totalUpsertedCount}.`);
      } else {
        console.log('ℹ️ Ingestion cycle complete. No new odds were found across all sports.');
      }
      
      await this.redisClient.set('meta:last_successful_ingestion', new Date().toISOString());
      console.log('📅 Last successful ingestion timestamp updated.');

    } catch (error) {
      console.error('❌ A critical error occurred during the main ingestion cycle:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_main' });
    } finally {
      this.isJobRunning = false;
      console.log('🏁 Ingestion cycle finished.');
    }
  }

  async _saveProviderQuotas(providerUsage) {
    console.log('💾 Saving provider quota data...');
    
    for (const [provider, data] of Object.entries(providerUsage)) {
      if (data.calls > 0 && data.lastHeaders) {
        try {
          await rateLimitService.saveProviderQuota(provider, data.lastHeaders);
          console.log(`   ✅ Saved quota data for ${provider} (${data.calls} calls)`);
        } catch (error) {
          console.error(`   ❌ Failed to save quota data for ${provider}:`, error.message);
        }
      }
    }
  }

  _detectProviderFromResponse(headers) {
    if (headers['x-requests-remaining']) return 'theodds';
    if (headers['x-ratelimit-requests-remaining']) return 'apisports';
    if (headers['server'] && headers['server'].includes('sportradar')) return 'sportradar';
    
    if (headers['x-provider'] === 'theodds') return 'theodds';
    if (headers['x-provider'] === 'sportradar') return 'sportradar';
    if (headers['x-provider'] === 'apisports') return 'apisports';
    
    return null;
  }
}

console.log('🎯 Odds Ingestion Worker Initializing...');
const worker = new OddsIngestionEngine();

setTimeout(() => {
  console.log('⏰ Auto-starting initial ingestion cycle...');
  worker.runIngestionCycle('auto-start');
}, 5000);

export default worker;
