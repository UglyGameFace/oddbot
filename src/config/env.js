// src/config/env.js
import dotenv from 'dotenv';
import { cleanEnv, str, num, url, bool } from 'envalid';
import * as Sentry from '@sentry/node';

dotenv.config();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    beforeSend: (event) => {
      if (event.exception?.values?.[0]?.value?.includes('Environment variable')) return null;
      return event;
    },
  });
}

const env = cleanEnv(process.env, {
  TELEGRAM_BOT_TOKEN: str(),
  NODE_ENV: str({ choices: ['development','production','staging','test'], default: 'production' }),
  TIMEZONE: str({ default: 'America/New_York' }),

  SUPABASE_URL: url(),
  SUPABASE_ANON_KEY: str(),
  SUPABASE_SERVICE_KEY: str({ default: '' }),

  GOOGLE_GEMINI_API_KEY: str(),
  PERPLEXITY_API_KEY: str(),
  THE_ODDS_API_KEY: str(),
  SPORTRADAR_API_KEY: str(),
  API_SPORTS_KEY: str(),

  SENTRY_DSN: str({ default: '' }),
  SENTRY_ENVIRONMENT: str({ default: '' }),
  SENTRY_TRACES_SAMPLE_RATE: num({ default: 0.2 }),
  SENTRY_ENABLE_PROFILING: bool({ default: false }),
  PROFILES_SAMPLE_RATE: num({ default: 0.25 }),

  // Prefer platform-injected PORT; devDefault for local runs
  PORT: num({ devDefault: 3000 }),
  HOST: str({ default: '0.0.0.0' }),
  APP_URL: url({ default: 'http://localhost:3000' }),

  // Optional aliases for the Telegram webhook secret
  TELEGRAM_WEBHOOK_SECRET: str({ default: process.env.TG_WEBHOOK_SECRET || '' }),
  TG_WEBHOOK_SECRET: str({ default: process.env.TELEGRAM_WEBHOOK_SECRET || '' }),

  RATE_LIMIT_REQUESTS: num({ default: 100 }),
  RATE_LIMIT_TIME_WINDOW: num({ default: 900000 }),
  TELEGRAM_POLLING_INTERVAL: num({ default: 300 }),
  REDIS_URL: url({ default: 'redis://localhost:6379' }),
  CACHE_TTL_DEFAULT: num({ default: 300 }),
  ENCRYPTION_KEY: str({ default: 'default-encryption-key-change-in-production' }),
  JWT_SECRET: str({ default: 'default-jwt-secret-change-in-production' }),

  FEATURE_QUANTITATIVE_ANALYTICS: bool({ default: true }),
  FEATURE_BEHAVIORAL_INSIGHTS: bool({ default: true }),
  FEATURE_REAL_TIME_ODDS: bool({ default: true }),
  FEATURE_ADVANCED_NOTIFICATIONS: bool({ default: true }),

  WORKER_POOL_SIZE: num({ default: 4 }),
  DATABASE_POOL_SIZE: num({ default: 10 }),
  MAX_EVENT_LOOP_DELAY: num({ default: 1000 }),
  LOG_LEVEL: str({ choices: ['error','warn','info','debug','trace'], default: 'info' }),
}, {
  strict: true,
  dotEnvPath: '.env',
  reporter: ({ errors }) => {
    if (Object.keys(errors).length > 0) {
      console.error('❌ ENVIRONMENT VALIDATION FAILED:');
      Object.entries(errors).forEach(([k, e]) => console.error(`   ${k}: ${e.message}`));
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(new Error('Environment validation failed'), {
          extra: { errors: JSON.stringify(errors, null, 2) },
          tags: { type: 'environment_config' },
        });
      }
      process.exit(1);
    }
  },
});

// Normalize and export helpful flags
const normalized = Object.freeze({
  ...env,
  WEBHOOK_SECRET: (env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim(),
  USE_WEBHOOK: (env.APP_URL || '').startsWith('https'),
});

export default normalized;
