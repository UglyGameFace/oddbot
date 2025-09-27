// src/workers/oddsIngestion.js - INSTITUTIONAL GRADE TRADING ENGINE
import cron from 'node-cron';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { sentryService } from '../services/sentryService.js';
import env from '../config/env.js';
import gamesService from '../services/gamesService.js';

class InstitutionalOddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    try {
      this.initializeScheduling();
    } catch (error) {
      console.error('❌ FATAL: Failed to initialize the odds ingestion engine scheduling.', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_initialization' });
    }
  }

  initializeScheduling() {
    cron.schedule('*/15 * * * *', () => this.runIngestionCycle(), { timezone: env.TIMEZONE });
    console.log('✅ Odds Ingestion Engine scheduled to run every 15 minutes.');
    setTimeout(() => this.runIngestionCycle(), 5000); 
  }

  async runIngestionCycle() {
    if (this.isJobRunning) {
      console.warn('Ingestion cycle skipped: Previous cycle still running.');
      return;
    }
    this.isJobRunning = true;
    console.log('🚀 Starting institutional odds ingestion cycle...');
    let totalUpsertedCount = 0;

    try {
      const sports = await gamesService.getAvailableSports();
      if (!sports || sports.length === 0) {
        console.log('Ingestion cycle complete. No sports available in DB to process.');
        this.isJobRunning = false;
        return;
      }

      // FIX: Process and upsert data one sport at a time to keep memory usage low and stable.
      // This prevents the application from exceeding resource limits on startup.
      for (const sport of sports) {
        try {
          const oddsForSport = await OddsService.getSportOdds(sport.sport_key);
          if (oddsForSport && oddsForSport.length > 0) {
            console.log(`  -> Fetched ${oddsForSport.length} games for ${sport.sport_key}. Upserting now...`);
            await DatabaseService.upsertGames(oddsForSport);
            totalUpsertedCount += oddsForSport.length;
          }
        } catch (e) {
            console.error(`Failed to process odds for ${sport.sport_key} during ingestion:`, e.message);
            sentryService.captureError(e, { component: 'odds_ingestion_worker_sport_failure', sport_key: sport.sport_key });
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
