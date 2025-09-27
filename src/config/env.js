// src/config/env.js — strict schema + validated Sentry keys
import dotenv from 'dotenv';
import { cleanEnv, str, num, url, bool } from 'envalid';
import * as Sentry from '@sentry/node';

dotenv.config();

// Pre-validation Sentry (non-breaking)
Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://mock@sentry.io/0',
  environment: process.env.NODE_ENV || 'production',
  beforeSend: (event) => {
    if (event.exception?.values?.[0]?.value?.includes('Environment variable')) return null;
    return event;
  },
});

const env = cleanEnv(
  process.env,
  {
    TELEGRAM_BOT_TOKEN: str(),
    SUPABASE_URL: url(),
    SUPABASE_ANON_KEY: str(),
    SUPABASE_SERVICE_KEY: str({ default: '' }),

    GOOGLE_GEMINI_API_KEY: str(),
    PERPLEXITY_API_KEY: str(),
    THE_ODDS_API_KEY: str(),
    SPORTRADAR_API_KEY: str(),
    API_SPORTS_KEY: str(),

    // Sentry
    SENTRY_DSN: str(),
    SENTRY_ENVIRONMENT: str({ default: '' }),            // ADDED: validate to avoid envalid error [envalid]
    SENTRY_TRACES_SAMPLE_RATE: num({ default: 0.2 }),
    SENTRY_ENABLE_PROFILING: bool({ default: false }),   // validated flag the service reads
    PROFILES_SAMPLE_RATE: num({ default: 0.25 }),

    // Runtime
    NODE_ENV: str({ choices: ['development', 'production', 'staging', 'test'], default: 'development' }),
    PORT: num({ default: 3000 }),
    HOST: str({ default: '0.0.0.0' }),

    // Rate limiting
    RATE_LIMIT_REQUESTS: num({ default: 100 }),
    RATE_LIMIT_TIME_WINDOW: num({ default: 900000 }),

    // Bot config
    TELEGRAM_POLLING_INTERVAL: num({ default: 300 }),

    // Redis & caching
    REDIS_URL: url({ default: 'redis://localhost:6379' }),
    CACHE_TTL_DEFAULT: num({ default: 300 }),

    // Security
    ENCRYPTION_KEY: str({ default: 'default-encryption-key-change-in-production' }),
    JWT_SECRET: str({ default: 'default-jwt-secret-change-in-production' }),

    // Feature flags
    FEATURE_QUANTITATIVE_ANALYTICS: bool({ default: true }),
    FEATURE_BEHAVIORAL_INSIGHTS: bool({ default: true }),
    FEATURE_REAL_TIME_ODDS: bool({ default: true }),
    FEATURE_ADVANCED_NOTIFICATIONS: bool({ default: true }),

    // Pools & performance
    WORKER_POOL_SIZE: num({ default: 4 }),
    DATABASE_POOL_SIZE: num({ default: 10 }),
    MAX_EVENT_LOOP_DELAY: num({ default: 1000 }),

    // Logging/Region
    LOG_LEVEL: str({ choices: ['error', 'warn', 'info', 'debug', 'trace'], default: 'info' }),
    TIMEZONE: str({ default: 'America/New_York' }),

    // Webhooks
    APP_URL: url({ default: 'http://localhost:3000' }),
    TELEGRAM_WEBHOOK_SECRET: str({ default: '' }),
  },
  {
    strict: true,
    dotEnvPath: '.env',
    reporter: ({ errors }) => {
      if (Object.keys(errors).length > 0) {
        console.error('❌ ENVIRONMENT VALIDATION FAILED:');
        Object.entries(errors).forEach(([key, error]) => console.error(`   ${key}: ${error.message}`));
        if (process.env.SENTRY_DSN && process.env.SENTRY_DSN !== 'https://mock@sentry.io/0') {
          Sentry.captureException(new Error('Environment validation failed'), {
            extra: { errors: JSON.stringify(errors, null, 2) },
            tags: { type: 'environment_config' },
          });
        }
        process.exit(1);
      }
    },
  }
);

// Utility exports (no Sentry re-init here; main service handles middleware order) [Sentry Express]
export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isStaging = env.NODE_ENV === 'staging';
export const isTest = env.NODE_ENV === 'test';

export function validateServiceConfiguration() {
  const warnings = [];
  const fatals = [];

  if (isProduction) {
    if (!env.APP_URL.startsWith('https://') || env.APP_URL.includes('localhost')) {
      fatals.push('APP_URL must be a public HTTPS URL in production for Telegram webhooks.');
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      fatals.push('TELEGRAM_WEBHOOK_SECRET is required in production to verify Telegram webhook requests.');
    }
  }
  if (env.TELEGRAM_BOT_TOKEN.length < 30) warnings.push('Telegram bot token appears invalid (length check).');

  warnings.forEach((w) => console.warn('⚠️', w));
  if (fatals.length) {
    const msg = `ENV FATAL: ${fatals.join(' | ')}`;
    console.error(msg);
    try {
      if (env.SENTRY_DSN) Sentry.captureException(new Error(msg), { tags: { type: 'environment_config' } });
    } finally {
      process.exit(1);
    }
  }
  return { warnings, fatals };
}

validateServiceConfiguration();
export default Object.freeze(env);
