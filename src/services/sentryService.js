// src/services/sentryService.js — ERROR MONITORING + OPTIONAL PROFILING (ESM-safe, non-breaking)
import * as Sentry from '@sentry/node';
import env, { isProduction } from '../config/env.js';

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.errorHandler = null;
    // Fire and forget; Sentry init can happen early without blocking app
    void this.initializeSentry();
  }

  async initializeSentry() {
    if (!env.SENTRY_DSN || !isProduction) {
      console.warn('🚨 Sentry is disabled (DSN not found or not in production).');
      return;
    }

    // Optional profiling toggle (off by default unless explicitly true)
    const enableProfiling = (process.env.SENTRY_ENABLE_PROFILING || 'false').toLowerCase() === 'true';

    // Try to load profiling integration safely in ESM context
    let profilingIntegrationFn = null;
    if (enableProfiling) {
      try {
        const mod = await import('@sentry/profiling-node'); // CommonJS under ESM: use property fallbacks
        profilingIntegrationFn =
          mod.nodeProfilingIntegration ||
          mod.default?.nodeProfilingIntegration ||
          null;
      } catch (e) {
        console.warn(`⚠️ Sentry profiling not available: ${e?.message || e}`);
      }
    }

    try {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
        release: `parlay-bot@${process.env.npm_package_version || '1.0.0'}`,
        integrations: [
          // Modern helpers; available under @sentry/node v7+
          Sentry.httpIntegration(),
          Sentry.onUnhandledRejectionIntegration?.(),
          Sentry.onUncaughtExceptionIntegration?.(),
          ...(profilingIntegrationFn ? [profilingIntegrationFn()] : []),
        ].filter(Boolean),
        // Performance + profiling sampling
        tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),
        profilesSampleRate: Number(process.env.PROFILES_SAMPLE_RATE ?? 0.25),
        attachStacktrace: true,
        sendDefaultPii: false,
        maxBreadcrumbs: 100,
        beforeSend: (event) => this.beforeSendEvent(event),
      });

      // Global safety nets
      process.on('unhandledRejection', (reason) => {
        Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
        console.error('UnhandledRejection:', reason);
      });
      process.on('uncaughtException', (err) => {
        Sentry.captureException(err);
        console.error('UncaughtException:', err);
      });

      this.initialized = true;
      console.log(
        `✅ Sentry Enterprise Monitoring Initialized (${profilingIntegrationFn ? 'Profiler Enabled' : 'Profiler Disabled for Compatibility'})`
      );
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
    }
  }

  attachExpressPreRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.requestHandler) app.use(Sentry.Handlers.requestHandler()); // per-request scope [web:705]
    if (Sentry.Handlers?.tracingHandler) app.use(Sentry.Handlers.tracingHandler()); // request traces [web:705]
  }

  attachExpressPostRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.errorHandler) app.use(Sentry.Handlers.errorHandler()); // error capture [web:705]
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
    if (!this.initialized) return { finish: () => {}, setStatus: () => {} };
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
