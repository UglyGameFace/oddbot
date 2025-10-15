// src/config/env.js - COMPLETE FIXED VERSION
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

  // 🚨 ALL API KEYS - FIXED & COMPLETE
  GOOGLE_GEMINI_API_KEY: str(),
  PERPLEXITY_API_KEY: str(),
  THE_ODDS_API_KEY: str(),
  SPORTRADAR_API_KEY: str(),
  API_SPORTS_API_KEY: str(), // FIXED: API-Sports is BACK!
  ODDS_API_NINJA_KEY: str({ default: '' }), // NEW: Backup provider
  BETTING_API_KEY: str({ default: '' }), // NEW: Another backup

  SENTRY_DSN: str({ default: '' }),
  SENTRY_ENVIRONMENT: str({ default: '' }),
  SENTRY_TRACES_SAMPLE_RATE: num({ default: 0.2 }),
  SENTRY_ENABLE_PROFILING: bool({ default: false }),
  PROFILES_SAMPLE_RATE: num({ default: 0.25 }),

  PORT: num({ devDefault: 8080 }),
  HOST: str({ default: '0.0.0.0' }),
  APP_URL: url({ default: 'http://localhost:8080' }),

  TELEGRAM_WEBHOOK_SECRET: str({ default: process.env.TG_WEBHOOK_SECRET || '' }),
  TG_WEBHOOK_SECRET: str({ default: process.env.TELEGRAM_WEBHOOK_SECRET || '' }),

  RATE_LIMIT_REQUESTS: num({ default: 100 }),
  RATE_LIMIT_TIME_WINDOW: num({ default: 900000 }),
  TELEGRAM_POLLING_INTERVAL: num({ default: 300 }),
  REDIS_URL: str({ default: '' }),
  CACHE_TTL_DEFAULT: num({ default: 300 }),
  ENCRYPTION_KEY: str({ default: 'default-encryption-key-change-in-production' }),
  JWT_SECRET: str({ default: 'default-jwt-secret-change-in-production' }),

  // Worker & Performance Tuning
  WORKER_POOL_SIZE: num({ default: 4 }),
  DATABASE_POOL_SIZE: num({ default: 10 }),
  MAX_EVENT_LOOP_DELAY: num({ default: 1000 }),
  ODDS_INGESTION_BATCH_SIZE: num({ default: 5 }),
  ODDS_INGESTION_DELAY_MS: num({ default: 2000 }),
  LOG_LEVEL: str({ choices: ['error','warn','info','debug','trace'], default: 'info' }),
  
  // Feature Flags
  FEATURE_QUANTITATIVE_ANALYTICS: bool({ default: true }),
  FEATURE_BEHAVIORAL_INSIGHTS: bool({ default: true }),
  FEATURE_REAL_TIME_ODDS: bool({ default: true }),
  FEATURE_ADVANCED_NOTIFICATIONS: bool({ default: true }),
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

// 🚨 NEW: API Key Validation & Fallback System
function validateAndWarnApiKeys(env) {
  const warnings = [];
  const critical = [];
  
  // Check CRITICAL APIs
  if (!env.THE_ODDS_API_KEY || env.THE_ODDS_API_KEY.includes('expired') || env.THE_ODDS_API_KEY.length < 20) {
    critical.push('THE_ODDS_API_KEY - GET NEW KEY: https://the-odds-api.com/');
  }
  
  if (!env.GOOGLE_GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY.includes('expired') || env.GOOGLE_GEMINI_API_KEY.length < 20) {
    critical.push('GOOGLE_GEMINI_API_KEY - GET NEW KEY: https://aistudio.google.com/');
  }
  
  // Check IMPORTANT APIs
  if (!env.SPORTRADAR_API_KEY || env.SPORTRADAR_API_KEY.includes('expired') || env.SPORTRADAR_API_KEY.length < 10) {
    warnings.push('SPORTRADAR_API_KEY - GET KEY: https://sportradar.com/');
  }
  
  if (!env.APISPORTS_API_KEY || env.APISPORTS_API_KEY.includes('expired') || env.APISPORTS_API_KEY.length < 10) {
    warnings.push('APISPORTS_API_KEY - GET KEY: https://api-sports.io/');
  }
  
  if (!env.PERPLEXITY_API_KEY || env.PERPLEXITY_API_KEY.includes('expired') || env.PERPLEXITY_API_KEY.length < 10) {
    warnings.push('PERPLEXITY_API_KEY - GET KEY: https://www.perplexity.ai/');
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('🔐 API KEY WARNINGS (Bot will work with limited features):');
    warnings.forEach(warning => console.warn(`   ⚠️ ${warning}`));
  }
  
  // Log critical errors
  if (critical.length > 0) {
    console.error('🚨 CRITICAL API KEY ERRORS (Bot may not function):');
    critical.forEach(error => console.error(`   ❌ ${error}`));
    
    if (env.SENTRY_DSN) {
      Sentry.captureMessage('Critical API Key Errors', {
        level: 'error',
        extra: { critical, warnings }
      });
    }
  }
  
  return {
    hasCriticalErrors: critical.length > 0,
    hasWarnings: warnings.length > 0,
    criticalErrors: critical,
    warnings: warnings
  };
}

// Run validation
const apiKeyStatus = validateAndWarnApiKeys(env);

// Export everything
const normalized = Object.freeze({
  ...env,
  WEBHOOK_SECRET: (env.TELEGRAM_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET || '').trim(),
  USE_WEBHOOK: (env.APP_URL || '').startsWith('https'),
  API_KEY_STATUS: apiKeyStatus
});

export default normalized;
export { apiKeyStatus, validateAndWarnApiKeys };
