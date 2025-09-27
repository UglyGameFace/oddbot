// src/config/env.js - ENTERPRISE ENVIRONMENT MANAGEMENT WITH SENTRY INTEGRATION
import dotenv from 'dotenv';
import { cleanEnv, str, num, url, bool } from 'envalid';
import * as Sentry from '@sentry/node';

dotenv.config();

// Pre-validation Sentry (non-breaking; mock DSN fallback)
Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://mock@sentry.io/0',
  environment: process.env.NODE_ENV || 'development',
  beforeSend: (event) => {
    // Ignore validation-time “Environment variable …” noise
    if (event.exception?.values?.[0]?.value?.includes('Environment variable')) return null;
    return event;
  },
});

// Strict schema; supply sane defaults so optional flags don’t break with envalid
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
    SENTRY_TRACES_SAMPLE_RATE: num({ default: 0.2 }),
    // New: safe profiling flags so later code can read them without envalid errors
    SENTRY_ENABLE_PROFILING: bool({ default: false }),
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

    // Public URL + webhook secret (used for Telegram webhooks)
    APP_URL: url({ default: 'http://localhost:3000' }),
    TELEGRAM_WEBHOOK_SECRET: str({ default: '' }),
  },
  {
    strict: true,
    dotEnvPath: '.env',
    reporter: ({ errors }) => {
      if (Object.keys(errors).length > 0) {
        console.error('❌ ENVIRONMENT VALIDATION FAILED:');
        Object.entries(errors).forEach(([key, error]) => {
          console.error(`   ${key}: ${error.message}`);
        });
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

// Post-validation: avoid full Sentry app init here; Sentry is initialized in the dedicated service per best practice
// This prevents double initialization and keeps Express middleware ordering correct in the main entrypoint. [Sentry docs]

// --- UTILITY HELPERS ---
export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isStaging = env.NODE_ENV === 'staging';
export const isTest = env.NODE_ENV === 'test';

export function getFeatureFlags() {
  return {
    quantitativeAnalytics: env.FEATURE_QUANTITATIVE_ANALYTICS,
    behavioralInsights: env.FEATURE_BEHAVIORAL_INSIGHTS,
    realTimeOdds: env.FEATURE_REAL_TIME_ODDS,
    advancedNotifications: env.FEATURE_ADVANCED_NOTIFICATIONS,
  };
}

export function validateServiceConfiguration() {
  const warnings = [];

  if (isProduction) {
    if (env.ENCRYPTION_KEY.includes('default')) {
      warnings.push('SECURITY WARNING: Using default encryption key in production');
    }
    if (env.JWT_SECRET.includes('default')) {
      warnings.push('SECURITY WARNING: Using default JWT secret in production');
    }
    if (env.APP_URL.includes('localhost')) {
      warnings.push('APP_URL points to localhost in production; set public https:// URL for webhook');
    }
  }

  if (env.TELEGRAM_BOT_TOKEN.length < 30) {
    warnings.push('Telegram bot token appears invalid');
  }

  if (warnings.length > 0) {
    warnings.forEach((warning) => {
      console.warn('⚠️', warning);
      // Defer real Sentry capture to the main Sentry service to avoid double init
    });
  }

  return warnings;
}

// Run config validation once
validateServiceConfiguration();

export default Object.freeze(env);
