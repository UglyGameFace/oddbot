// src/services/sentryService.js - ENTERPRISE-GRADE ERROR MONITORING & PERFORMANCE TRACKING (stable)
import * as Sentry from '@sentry/node';
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

      // Global process-level safety nets
      process.on('unhandledRejection', (reason) => {
        Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
        console.error('UnhandledRejection:', reason);
      });
      process.on('uncaughtException', (err) => {
        Sentry.captureException(err);
        console.error('UncaughtException:', err);
      });
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
    }
  }

  // Express middleware hooks (order per Sentry docs)
  attachExpressPreRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.requestHandler) app.use(Sentry.Handlers.requestHandler());
    if (Sentry.Handlers?.tracingHandler) app.use(Sentry.Handlers.tracingHandler());
  }
  attachExpressPostRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.errorHandler) app.use(Sentry.Handlers.errorHandler());
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
      delete event.request.data.token;
    }
    return event;
  }
}

const sentryService = new EnterpriseSentryService();
export default sentryService;
