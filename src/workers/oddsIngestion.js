// src/workers/oddsIngestion.js - INSTITUTIONAL GRADE TRADING ENGINE
import cron from 'node-cron';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import { sentryService } from '../services/sentryService.js'; // Corrected import
import env from '../config/env.js';
import gamesService from '../services/gamesService.js';

class InstitutionalOddsIngestionEngine {
  constructor() {
    this.isJobRunning = false;
    this.initializeScheduling();
  }

  initializeScheduling() {
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', () => this.runIngestionCycle(), { timezone: env.TIMEZONE });
    console.log('✅ Odds Ingestion Engine scheduled to run every 15 minutes.');
    this.runIngestionCycle(); // Run once on startup
  }

  async runIngestionCycle() {
    if (this.isJobRunning) {
      console.warn('Ingestion cycle skipped: Previous cycle still running.');
      return;
    }
    this.isJobRunning = true;
    console.log('🚀 Starting institutional odds ingestion cycle...');
    const transaction = sentryService.startTransaction ? sentryService.startTransaction({ op: 'worker', name: 'odds_ingestion_cycle' }) : null;

    try {
      // FIX: The function `getAllSportsOdds` does not exist. The correct approach is to
      // get the list of sports and then fetch odds for each one individually.
      const sports = await gamesService.getAvailableSports();
      if (!sports || sports.length === 0) {
        console.log('Ingestion cycle complete. No sports available to process.');
        if (transaction) transaction.setStatus('ok');
        return;
      }

      const allOdds = [];
      for (const sport of sports) {
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
        // Assuming your database service has a method for batch upserting.
        // If not, this part would need adjustment.
        await DatabaseService.upsertGames(allOdds);
        console.log(`✅ Ingestion cycle complete. Upserted data for ${allOdds.length} games.`);
      } else {
        console.log('Ingestion cycle complete. No new odds found across all sports.');
      }
      
      if (transaction) transaction.setStatus('ok');
    } catch (error) {
      console.error('❌ Ingestion cycle failed:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker' });
      if (transaction) transaction.setStatus('internal_error');
    } finally {
      if (transaction) transaction.finish();
      this.isJobRunning = false;
    }
  }
}

new InstitutionalOddsIngestionEngine();
