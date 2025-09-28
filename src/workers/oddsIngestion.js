// src/workers/oddsIngestion.js - INSTITUTIONAL GRADE TRADING ENGINE
import cron from 'node-cron';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
import gamesService from '../services/gamesService.js';
import redisClient from '../services/redisService.js'; // Import the Redis client

// FIX: Added a top-level, process-wide error catcher.
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION IN ODDS WORKER:', reason);
  sentryService.captureError(new Error(`Unhandled Rejection in odds worker: ${reason}`), { extra: { promise } });
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class InstitutionalOddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    this.initializeScheduling();
    this.initializeManualTrigger(); // <-- NEW: Initialize the manual trigger listener
  }

  initializeScheduling() {
    cron.schedule('*/15 * * * *', () => this.runIngestionCycle('cron'), { timezone: env.TIMEZONE });
    console.log('✅ Odds Ingestion Engine scheduled to run every 15 minutes.');
    // Run once on startup, after a brief delay.
    setTimeout(() => this.runIngestionCycle('startup'), 5000); 
  }

  // --- NEW FUNCTION to listen for manual triggers via Redis ---
  async initializeManualTrigger() {
    try {
      const redis = await redisClient;
      // Create a duplicate client for subscribing to avoid blocking other commands
      const subscriber = redis.duplicate(); 
      await subscriber.connect();
      
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
      const sports = await gamesService.getAvailableSports();
      
      if (!sports || sports.length === 0) {
        console.warn('ODDS WORKER: No sports available from GamesService. Cycle will try again later.');
        this.isJobRunning = false;
        return;
      }

      // Process in batches to avoid rate limits
      const batchSize = 5;
      for (let i = 0; i < sports.length; i += batchSize) {
        const batch = sports.slice(i, i + batchSize);
        console.log(` -> Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(sports.length / batchSize)}...`);
        
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

        if (i + batchSize < sports.length) {
            console.log(` -> Batch complete. Waiting for 2 seconds before next batch...`);
            await delay(2000);
        }
      }

      if (totalUpsertedCount > 0) {
        console.log(`✅ Ingestion cycle complete. Total upserted games: ${totalUpsertedCount}.`);
      } else {
        console.log('Ingestion cycle complete. No new odds were found across all sports.');
      }
      
    } catch (error) {
      console.error('❌ A critical error occurred during the main ingestion cycle:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_main' });
    } finally {
      this.isJobRunning = false;
    }
  }
}

new InstitutionalOddsIngestionEngine();
