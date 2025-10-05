// src/workers/oddsIngestion.js - Manages on-demand ingestion of sports odds via a Redis trigger.
// FIX: Uses dedicated Redis clients to prevent connection state pollution.

import Redis from 'ioredis';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { sentryService } from '../services/sentryService.js';
import gamesService from '../services/gamesService.js';
import env from '../config/env.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION IN ODDS WORKER:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection in odds worker: ${reason}`), { extra: { promise } });
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class OddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    this.redisClient = null;
    this.subscriberClient = null;
    this.initialize();
  }

  async initialize() {
    try {
      // FIX: Create dedicated clients for this worker to ensure isolation.
      // This is the guaranteed fix for the "(P)SUBSCRIBE" context errors.
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
          console.log(' MANUAL TRIGGER RECEIVED! Starting ingestion cycle...');
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
      console.warn(`Ingestion cycle skipped (source: ${source}): Previous cycle still running.`);
      return;
    }
    this.isJobRunning = true;
    console.log(`🚀 Starting odds ingestion cycle (source: ${source})...`);
    let totalUpsertedCount = 0;

    try {
      const sportsToFetch = await gamesService.getAvailableSports();
      
      if (!sportsToFetch || !sportsToFetch.length) {
        console.warn('ODDS WORKER: Could not fetch the list of available sports. Cycle ending.');
        this.isJobRunning = false;
        return;
      }
      
      console.log(`Dynamically fetched ${sportsToFetch.length} sports to process.`);
      const batchSize = env.ODDS_INGESTION_BATCH_SIZE;
      const interBatchDelay = env.ODDS_INGESTION_DELAY_MS;

      for (let i = 0; i < sportsToFetch.length; i += batchSize) {
        const batch = sportsToFetch.slice(i, i + batchSize);
        console.log(` -> Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(sportsToFetch.length / batchSize)}...`);
        
        await Promise.all(batch.map(async (sport) => {
          try {
            const oddsForSport = await OddsService.getSportOdds(sport.sport_key);
            if (oddsForSport && oddsForSport.length > 0) {
              console.log(`    -> Fetched ${oddsForSport.length} games for ${sport.sport_key}.`);
              await DatabaseService.upsertGames(oddsForSport);
              totalUpsertedCount += oddsForSport.length;
            }
          } catch (e) {
              console.error(`    -> Failed to process odds for ${sport.sport_key}:`, e.message);
              sentryService.captureError(e, { component: 'odds_ingestion_worker_sport_failure', sport_key: sport.sport_key });
          }
        }));

        if (i + batchSize < sportsToFetch.length) {
            console.log(` -> Batch complete. Waiting for ${interBatchDelay / 1000} seconds before next batch...`);
            await delay(interBatchDelay);
        }
      }

      if (totalUpsertedCount > 0) {
        console.log(`✅ Ingestion cycle complete. Total upserted games: ${totalUpsertedCount}.`);
      } else {
        console.log('Ingestion cycle complete. No new odds were found across all sports.');
      }
      
      await this.redisClient.set('meta:last_successful_ingestion', new Date().toISOString());

    } catch (error) {
      console.error('❌ A critical error occurred during the main ingestion cycle:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_main' });
    } finally {
      this.isJobRunning = false;
    }
  }
}

new OddsIngestionEngine();
