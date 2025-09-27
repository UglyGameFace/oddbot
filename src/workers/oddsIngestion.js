// src/workers/oddsIngestion.js - INSTITUTIONAL GRADE TRADING ENGINE
import cron from 'node-cron';
import DatabaseService from '../services/databaseService.js';
import OddsService from '../services/oddsService.js';
import sentryService from '../services/sentryService.js';
import env from '../config/env.js';

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
    const transaction = sentryService.startTransaction({ op: 'worker', name: 'odds_ingestion_cycle' });

    try {
      const allOdds = await OddsService.getAllSportsOdds();
      if (allOdds && allOdds.length > 0) {
        await DatabaseService.upsertGamesBatch(allOdds);
        console.log(`✅ Ingestion cycle complete. Upserted ${allOdds.length} games.`);
      } else {
        console.log('Ingestion cycle complete. No new odds found.');
      }
      transaction.setStatus('ok');
    } catch (error) {
      console.error('❌ Ingestion cycle failed:', error);
      sentryService.captureError(error, { component: 'odds_ingestion_worker' });
      transaction.setStatus('internal_error');
    } finally {
      transaction.finish();
      this.isJobRunning = false;
    }
  }
}

new InstitutionalOddsIngestionEngine();
