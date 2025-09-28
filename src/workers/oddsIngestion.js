// src/workers/oddsIngestion.js - INSTITUTIONAL GRADE TRADING ENGINE
import cron from 'node-cron';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
import gamesService from '../services/gamesService.js'; 
import redisClient from '../services/redisService.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION IN ODDS WORKER:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection in odds worker: ${reason}`), { extra: { promise } });
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class InstitutionalOddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    this.initializeManualTrigger();
  }

  async initializeManualTrigger() {
    try {
      const redis = await redisClient;
      const subscriber = redis.duplicate();
      
      const channel = 'odds_ingestion_trigger';
      await subscriber.subscribe(channel);
      console.log(`✅ Worker listening for manual triggers on Redis channel: ${channel}`);

      subscriber.on('message', (ch, message) => {
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
    console.log(`🚀 Starting institutional odds ingestion cycle (source: ${source})...`);
    let totalUpsertedCount = 0;

    try {
      const sportsToFetch = await gamesService.getAvailableSports();
      
      if (!sportsToFetch || !sportsToFetch.length) {
        console.warn('ODDS WORKER: Could not fetch the list of available sports. Cycle ending.');
        this.isJobRunning = false;
        return;
      }
      
      console.log(`Dynamically fetched ${sportsToFetch.length} sports to process.`);
      const batchSize = 5;
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
            console.log(` -> Batch complete. Waiting for 2 seconds before next batch...`);
            await delay(2000);
        }
      }

      if (totalUpsertedCount > 0) {
        console.log(`✅ Ingestion cycle complete. Total upserted games: ${totalUpsertedCount}.`);
      } else {
        console.log('Ingestion cycle complete. No new odds were found across all sports.');
      }
      
      // **NEW:** Save timestamp of successful run to Redis
      const redis = await redisClient;
      await redis.set('meta:last_successful_ingestion', new Date().toISOString());

    } catch (error) {
      console.error('❌ A critical error occurred during the main ingestion cycle:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_main' });
    } finally {
      this.isJobRunning = false;
    }
  }
}

new InstitutionalOddsIngestionEngine();
