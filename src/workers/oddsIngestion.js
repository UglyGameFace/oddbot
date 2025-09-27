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
    // FIX: Wrap the initialization in a try/catch to prevent startup crashes.
    try {
      this.initializeScheduling();
    } catch (error) {
      console.error('❌ FATAL: Failed to initialize the odds ingestion engine scheduling.', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker_initialization' });
    }
  }

  initializeScheduling() {
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', () => this.runIngestionCycle(), { timezone: env.TIMEZONE });
    console.log('✅ Odds Ingestion Engine scheduled to run every 15 minutes.');
    
    // Run once on startup, but with a small delay to allow other services to initialize.
    setTimeout(() => this.runIngestionCycle(), 5000); 
  }

  async runIngestionCycle() {
    if (this.isJobRunning) {
      console.warn('Ingestion cycle skipped: Previous cycle still running.');
      return;
    }
    this.isJobRunning = true;
    console.log('🚀 Starting institutional odds ingestion cycle...');

    try {
      const sports = await gamesService.getAvailableSports();
      if (!sports || sports.length === 0) {
        console.log('Ingestion cycle complete. No sports available in DB to process.');
        this.isJobRunning = false;
        return;
      }

      const allOdds = [];
      for (const sport of sports) {
        // Individual try/catch for each sport to ensure one failing sport doesn't stop others.
        try {
          const odds = await OddsService.getSportOdds(sport.sport_key);
          if (odds && odds.length > 0) {
            allOdds.push(...odds);
          }
        } catch (e) {
            console.error(`Failed to fetch odds for ${sport.sport_key} during ingestion:`, e.message);
            sentryService.captureError(e, { component: 'odds_ingestion_worker', sport_key: sport.sport_key });
        }
      }

      if (allOdds.length > 0) {
        await DatabaseService.upsertGames(allOdds);
        console.log(`✅ Ingestion cycle complete. Upserted data for ${allOdds.length} games.`);
      } else {
        console.log('Ingestion cycle complete. No new odds found across all sports.');
      }
      
    } catch (error) {
      console.error('❌ A critical error occurred during the ingestion cycle:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker' });
    } finally {
      this.isJobRunning = false;
    }
  }
}

new InstitutionalOddsIngestionEngine();
