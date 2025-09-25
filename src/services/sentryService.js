// src/services/sentryService.js - ENTERPRISE-GRADE ERROR MONITORING & PERFORMANCE TRACKING
import * as Sentry from '@sentry/node';
// The ProfilingIntegration has been intentionally removed to fix compatibility issues with Termux
import env, { isProduction } from '../config/env.js';

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.initializeSentry();
  }

  initializeSentry() {
    if (!env.SENTRY_DSN || !isProduction) {
      console.warn('🚨 Sentry is disabled (DSN not found or not in production).');
      return;
    }

    try {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        release: `parlay-bot@${process.env.npm_package_version || '1.0.0'}`,
        integrations: [
          new Sentry.Integrations.Http({ tracing: true }),
          new Sentry.Integrations.OnUncaughtException(),
          new Sentry.Integrations.OnUnhandledRejection(),
        ],
        tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
        attachStacktrace: true,
        sendDefaultPii: false,
        maxBreadcrumbs: 100,
        beforeSend: (event) => this.beforeSendEvent(event),
      });
      this.initialized = true;
      console.log('✅ Sentry Enterprise Monitoring Initialized (Profiler Disabled for Compatibility)');
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
    }
  }

  captureError(error, context = {}) {
    if (!this.initialized) {
      console.error('Sentry Capture:', error, context);
      return;
    }
    Sentry.captureException(error, { extra: context });
  }

  captureMessage(message, level = 'info', context = {}) {
    if (!this.initialized) {
        console.log(`Sentry Message [${level}]:`, message, context);
        return;
    }
    Sentry.captureMessage(message, { level, extra: context });
  }

  identifyUser(user) {
    if (!this.initialized || !user) return;
    Sentry.setUser({ id: user.tg_id, username: user.username });
  }

  startTransaction(options) {
      if (!this.initialized) {
          return { finish: () => {}, setStatus: () => {} };
      }
      return Sentry.startTransaction(options);
  }
  
  beforeSendEvent(event) {
    if (event.request?.data) {
        delete event.request.data.password;
    }
    return event;
  }
}

const sentryService = new EnterpriseSentryService();
export default sentryService;
