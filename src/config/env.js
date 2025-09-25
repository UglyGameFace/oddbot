// src/config/env.js - ENTERPRISE ENVIRONMENT MANAGEMENT WITH SENTRY INTEGRATION
import dotenv from 'dotenv';
import { cleanEnv, str, num, url, bool, json } from 'envalid';
import * as Sentry from '@sentry/node';

dotenv.config();

// Pre-validation Sentry initialization for environment errors
Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://mock@sentry.io/0', // Mock for validation phase
  environment: process.env.NODE_ENV || 'development',
  beforeSend: (event) => {
    // Filter out environment configuration errors during validation
    if (event.exception?.values?.[0]?.value?.includes('Environment variable')) {
      return null;
    }
    return event;
  }
});

const env = cleanEnv(process.env, {
  TELEGRAM_BOT_TOKEN: str(),
  SUPABASE_URL: url(),
  SUPABASE_ANON_KEY: str(),
  SUPABASE_SERVICE_KEY: str({ default: '' }),
  GOOGLE_GEMINI_API_KEY: str(),
  PERPLEXITY_API_KEY: str(),
  THE_ODDS_API_KEY: str(),
  SPORTRADAR_API_KEY: str(),
  API_SPORTS_KEY: str(),
  SENTRY_DSN: str(),
  SENTRY_TRACES_SAMPLE_RATE: num({ default: 0.2 }),
  NODE_ENV: str({ choices: ['development', 'production', 'staging', 'test'], default: 'development' }),
  PORT: num({ default: 3000 }),
  HOST: str({ default: '0.0.0.0' }),
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
  LOG_LEVEL: str({ choices: ['error', 'warn', 'info', 'debug', 'trace'], default: 'info' }),
  TIMEZONE: str({ default: 'America/New_York' }),
}, {
  strict: true,
  dotEnvPath: '.env',
  reporter: ({ errors, env }) => {
    if (Object.keys(errors).length > 0) {
      console.error('❌ ENVIRONMENT VALIDATION FAILED:');
      Object.entries(errors).forEach(([key, error]) => {
        console.error(`   ${key}: ${error.message}`);
      });
      if (process.env.SENTRY_DSN && process.env.SENTRY_DSN !== 'https://mock@sentry.io/0') {
        Sentry.captureException(new Error('Environment validation failed'), {
          extra: { errors: JSON.stringify(errors, null, 2) },
          tags: { type: 'environment_config' }
        });
      }
      process.exit(1);
    }
  }
});

// Post-validation Sentry reinitialization with actual DSN
if (env.SENTRY_DSN && env.SENTRY_DSN !== 'https://mock@sentry.io/0') {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.OnUncaughtException(),
      new Sentry.Integrations.OnUnhandledRejection(),
    ],
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend: (event) => {
      // Filter out sensitive information
      if (event.request) {
        event.request.headers = {};
      }
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === 'console' && breadcrumb.message.includes('password')) {
        return null;
      }
      return breadcrumb;
    }
  });
}

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
    advancedNotifications: env.FEATURE_ADVANCED_NOTIFICATIONS
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
  }

  if (env.TELEGRAM_BOT_TOKEN.length < 30) {
    warnings.push('Telegram bot token appears invalid');
  }

  if (warnings.length > 0) {
    warnings.forEach(warning => {
      console.warn('⚠️', warning);
      Sentry.captureMessage(warning, {
        level: 'warning',
        tags: { type: 'configuration_warning' }
      });
    });
  }

  return warnings;
}

// Run config validation once
validateServiceConfiguration();

// Export the frozen env object and all helpers for safe usage everywhere else
export default Object.freeze(env);
