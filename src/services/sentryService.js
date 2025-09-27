// src/services/sentryService.js — ENTERPRISE-GRADE ERROR + PROFILING (simplified, no new env vars)
import * as Sentry from '@sentry/node';
import env, { isProduction } from '../config/env.js';

// Import @sentry/profiling-node using CommonJS interop pattern for ESM
import profilingPkg from '@sentry/profiling-node';
const { nodeProfilingIntegration } = profilingPkg;

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.errorHandler = null; // Express error middleware (mount after routes)
    this.initializeSentry();
  }

  initializeSentry() {
    // Keep original logic: just check DSN and production like before
    if (!env.SENTRY_DSN || !isProduction) {
      console.warn('🚨 Sentry is disabled (DSN not found or not in production).');
      return;
    }

    // Check optional profiling flag directly from process.env (bypass envalid)
    const enableProfiling = process.env.SENTRY_ENABLE_PROFILING !== 'false';

    try {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        release: `parlay-bot@${process.env.npm_package_version || '1.0.0'}`,
        
        integrations: [
          Sentry.httpIntegration(),                                                   // HTTP instrumentation
          Sentry.onUnhandledRejectionIntegration?.(),                                // unhandled rejections  
          Sentry.onUncaughtExceptionIntegration?.(),                                 // uncaught exceptions
          ...(enableProfiling ? [nodeProfilingIntegration()] : []),                 // optional profiling
        ].filter(Boolean),

        // Use existing env vars that are already validated
        tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
        // Use process.env directly for optional profiling rate (bypass envalid)
        profilesSampleRate: Number(process.env.PROFILES_SAMPLE_RATE || process.env.SENTRY_PROFILES_SAMPLE_RATE || 1.0),
        
        attachStacktrace: true,
        sendDefaultPii: false,
        maxBreadcrumbs: 100,
        beforeSend: (event) => this.beforeSendEvent(event),
      });

      // Global process-level safety nets
      process.on('unhandledRejection', (reason) => {
        Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
        console.error('UnhandledRejection:', reason);
      });
      process.on('uncaughtException', (err) => {
        Sentry.captureException(err);
        console.error('UncaughtException:', err);
      });

      this.initialized = true;
      console.log(`✅ Sentry Enterprise Monitoring Initialized (${enableProfiling ? 'Profiler Enabled' : 'Profiler Disabled for Compatibility'})`);
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
    }
  }

  // Mount BEFORE routes: requestHandler + tracingHandler
  attachExpressPreRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.requestHandler) app.use(Sentry.Handlers.requestHandler());
    if (Sentry.Handlers?.tracingHandler) app.use(Sentry.Handlers.tracingHandler());
  }

  // Mount AFTER routes: errorHandler
  attachExpressPostRoutes(app, options = {}) {
    if (!this.initialized) return;
    const errMw = Sentry.Handlers?.errorHandler?.({
      shouldHandleError(error) {
        if (error?.status >= 500) return true;
        if (options.capture404 && error?.status === 404) return true;
        return false;
      },
    });
    if (errMw) {
      this.errorHandler = errMw;
      app.use(errMw);
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
        delete event.request.data.token;
    }
    return event;
  }
}

const sentryService = new EnterpriseSentryService();
export default sentryService;
