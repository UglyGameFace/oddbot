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
      return null; // Don't send env validation errors to Sentry
    }
    return event;
  }
});

const env = cleanEnv(process.env, {
  // === TELEGRAM CONFIGURATION ===
  TELEGRAM_BOT_TOKEN: str({
    desc: 'Telegram Bot API Token - Get from @BotFather',
    example: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
    docs: 'https://core.telegram.org/bots#how-do-i-create-a-bot'
  }),
  
  // === DATABASE CONFIGURATION (Supabase) ===
  SUPABASE_URL: url({
    desc: 'Supabase Project URL - From project settings',
    example: 'https://your-project-ref.supabase.co'
  }),
  SUPABASE_ANON_KEY: str({
    desc: 'Supabase Anonymous Key - From project API settings',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  }),
  SUPABASE_SERVICE_KEY: str({
    desc: 'Supabase Service Key - For server-side operations',
    default: '',
    docs: 'https://supabase.com/docs/guides/api#api-keys'
  }),
  
  // === AI API CONFIGURATION ===
  GOOGLE_GEMINI_API_KEY: str({
    desc: 'Google Gemini API Key - From Google AI Studio',
    example: 'AIzaSyB...',
    docs: 'https://ai.google.dev/'
  }),
  PERPLEXITY_API_KEY: str({
    desc: 'Perplexity AI API Key - From Perplexity AI dashboard',
    example: 'pplx-...',
    docs: 'https://www.perplexity.ai/'
  }),
  
  // === SPORTS DATA APIs (Free Tier) ===
  THE_ODDS_API_KEY: str({
    desc: 'The Odds API Key - Free tier from theoddsapi.com',
    example: '1234567890abcdef...',
    docs: 'https://the-odds-api.com/'
  }),
  SPORTRADAR_API_KEY: str({
    desc: 'Sportradar API Key - Free tier from sportradar.com',
    example: 'abc123def456...',
    docs: 'https://developer.sportradar.com/'
  }),
  API_SPORTS_KEY: str({
    desc: 'API-Sports Key - Free tier from api-sports.io',
    example: '1234567890abcdef...',
    docs: 'https://api-sports.io/'
  }),
  
  // === ENTERPRISE MONITORING ===
  SENTRY_DSN: str({
    desc: 'Sentry DSN for error tracking and performance monitoring',
    example: 'https://key@sentry.io/project-id',
    docs: 'https://docs.sentry.io/'
  }),
  SENTRY_TRACES_SAMPLE_RATE: num({
    desc: 'Sentry transaction sampling rate (0.0 to 1.0)',
    default: 0.2,
    docs: 'https://docs.sentry.io/platforms/node/performance/'
  }),
  
  // === APPLICATION RUNTIME ===
  NODE_ENV: str({
    choices: ['development', 'production', 'staging', 'test'],
    default: 'development',
    desc: 'Application environment'
  }),
  PORT: num({
    default: 3000,
    desc: 'Port for HTTP server (if needed)'
  }),
  HOST: str({
    default: '0.0.0.0',
    desc: 'Host binding for HTTP server'
  }),
  
  // === ENTERPRISE RATE LIMITING ===
  RATE_LIMIT_REQUESTS: num({
    default: 100,
    desc: 'Maximum requests per time window'
  }),
  RATE_LIMIT_TIME_WINDOW: num({
    default: 900000, // 15 minutes
    desc: 'Rate limit window in milliseconds'
  }),
  TELEGRAM_POLLING_INTERVAL: num({
    default: 300,
    desc: 'Telegram polling interval in milliseconds'
  }),
  
  // === CACHE AND PERFORMANCE ===
  REDIS_URL: url({
    default: 'redis://localhost:6379',
    desc: 'Redis connection URL for caching'
  }),
  CACHE_TTL_DEFAULT: num({
    default: 300, // 5 minutes
    desc: 'Default cache TTL in seconds'
  }),
  
  // === SECURITY CONFIGURATION ===
  ENCRYPTION_KEY: str({
    default: 'default-encryption-key-change-in-production',
    desc: 'Key for encrypting sensitive data'
  }),
  JWT_SECRET: str({
    default: 'default-jwt-secret-change-in-production',
    desc: 'Secret for JWT token signing'
  }),
  
  // === ENTERPRISE FEATURE TOGGLES ===
  FEATURE_QUANTITATIVE_ANALYTICS: bool({
    default: true,
    desc: 'Enable quantitative portfolio analytics'
  }),
  FEATURE_BEHAVIORAL_INSIGHTS: bool({
    default: true,
    desc: 'Enable behavioral finance insights'
  }),
  FEATURE_REAL_TIME_ODDS: bool({
    default: true,
    desc: 'Enable real-time odds streaming'
  }),
  FEATURE_ADVANCED_NOTIFICATIONS: bool({
    default: true,
    desc: 'Enable intelligent notification system'
  }),
  
  // === PERFORMANCE TUNING ===
  WORKER_POOL_SIZE: num({
    default: 4,
    desc: 'Number of worker processes to spawn'
  }),
  DATABASE_POOL_SIZE: num({
    default: 10,
    desc: 'Database connection pool size'
  }),
  MAX_EVENT_LOOP_DELAY: num({
    default: 1000,
    desc: 'Maximum event loop delay in milliseconds before alerting'
  }),
  
  // === EXTERNAL SERVICE CONFIGURATION ===
  LOG_LEVEL: str({
    choices: ['error', 'warn', 'info', 'debug', 'trace'],
    default: 'info',
    desc: 'Logging verbosity level'
  }),
  TIMEZONE: str({
    default: 'America/New_York',
    desc: 'Default timezone for sports events'
  })
}, {
  // Enhanced validation options
  strict: true,
  dotEnvPath: '.env',
  reporter: ({ errors, env }) => {
    if (Object.keys(errors).length > 0) {
      console.error('❌ ENVIRONMENT VALIDATION FAILED:');
      Object.entries(errors).forEach(([key, error]) => {
        console.error(`   ${key}: ${error.message}`);
      });
      
      // Send critical environment errors to Sentry (after init)
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
        event.request.headers = this.sanitizeHeaders(event.request.headers);
      }
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => {
      // Filter sensitive breadcrumbs
      if (breadcrumb.category === 'console' && breadcrumb.message.includes('password')) {
        return null;
      }
      return breadcrumb;
    }
  });
}

// Environment utility methods
env.isProduction = () => env.NODE_ENV === 'production';
env.isDevelopment = () => env.NODE_ENV === 'development';
env.isStaging = () => env.NODE_ENV === 'staging';
env.isTest = () => env.NODE_ENV === 'test';

env.getFeatureFlags = () => ({
  quantitativeAnalytics: env.FEATURE_QUANTITATIVE_ANALYTICS,
  behavioralInsights: env.FEATURE_BEHAVIORAL_INSIGHTS,
  realTimeOdds: env.FEATURE_REAL_TIME_ODDS,
  advancedNotifications: env.FEATURE_ADVANCED_NOTIFICATIONS
});

env.validateServiceConfiguration = () => {
  const warnings = [];
  
  // Check for default security values in production
  if (env.isProduction()) {
    if (env.ENCRYPTION_KEY.includes('default')) {
      warnings.push('SECURITY WARNING: Using default encryption key in production');
    }
    if (env.JWT_SECRET.includes('default')) {
      warnings.push('SECURITY WARNING: Using default JWT secret in production');
    }
  }
  
  // Check API key formats
  if (env.TELEGRAM_BOT_TOKEN.length < 30) {
    warnings.push('Telegram bot token appears invalid');
  }
  
  if (warnings.length > 0) {
    warnings.forEach(warning => {
      console.warn('⚠️', warning);
      
      // Send configuration warnings to Sentry
      Sentry.captureMessage(warning, {
        level: 'warning',
        tags: { type: 'configuration_warning' }
      });
    });
  }
  
  return warnings;
};

// Initialize environment validation
env.validateServiceConfiguration();

// Export with enhanced capabilities
export default Object.freeze(env);