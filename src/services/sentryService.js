// src/services/sentryService.js — ENTERPRISE-GRADE ERROR + PROFILING + EXPRESS MIDDLEWARE
import * as Sentry from '@sentry/node';
import env, { isProduction } from '../config/env.js';
// Optional CPU profiling (requires native module). Toggle with SENTRY_ENABLE_PROFILING.
import { nodeProfilingIntegration } from '@sentry/profiling-node';

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.errorHandler = null; // Express error middleware (mount after routes)
    this.initializeSentry();
  }

  initializeSentry() {
    // Allow override via SENTRY_ENABLED, default true; still require DSN and prod by default.
    const enabled = (env.SENTRY_ENABLED ?? 'true').toString().toLowerCase() !== 'false';
    if (!enabled || !env.SENTRY_DSN || !isProduction) {
      console.warn('🚨 Sentry disabled (no DSN, not production, or SENTRY_ENABLED=false).');
      return;
    }

    const enableProfiling = (env.SENTRY_ENABLE_PROFILING ?? 'true').toString().toLowerCase() !== 'false';

    try {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
        release: `parlay-bot@${process.env.npm_package_version || '1.0.0'}`,

        // Modern integrations API for Node/Express + optional profiling
        integrations: [
          Sentry.httpIntegration(), // inbound/outbound HTTP instrumentation [web:705]
          // Capture global unhandled rejections with configurable mode (warn|strict|none) [web:706]
          Sentry.onUnhandledRejectionIntegration?.({
            mode: env.SENTRY_UNHANDLED_REJECTION_MODE || 'warn',
          }),
          Sentry.onUncaughtExceptionIntegration?.(), // capture uncaught exceptions [web:705]
          ...(enableProfiling ? [nodeProfilingIntegration()] : []), // CPU profiles attached to traces [web:727][web:728]
        ].filter(Boolean),

        // Performance + profiling sampling
        tracesSampleRate: Number(env.TRACES_SAMPLE_RATE ?? env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0), // 100% by default; tune in prod [web:705]
        // profilesSampleRate remains supported in Node SDK; optional newer fields: profileSessionSampleRate/profileLifecycle [web:728]
        profilesSampleRate: Number(env.PROFILES_SAMPLE_RATE ?? env.SENTRY_PROFILES_SAMPLE_RATE ?? 1.0), // 100% profiles by default [web:728]

        attachStacktrace: true,
        sendDefaultPii: false,
        maxBreadcrumbs: 100,

        beforeSend: (event) => this.beforeSendEvent(event),
      });

      // Redundant process-level safety nets for silent async failures [web:706]
      process.on('unhandledRejection', (reason) => {
        Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
        console.error('UnhandledRejection:', reason);
      });
      process.on('uncaughtException', (err) => {
        Sentry.captureException(err);
        console.error('UncaughtException:', err);
      });

      this.initialized = true;
      console.log(`✅ Sentry Enterprise Monitoring Initialized (${enableProfiling ? 'Profiler Enabled' : 'Profiler Disabled'})`);
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
    }
  }

  // Mount BEFORE routes: requestHandler + tracingHandler [web:705]
  attachExpressPreRoutes(app) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.requestHandler) app.use(Sentry.Handlers.requestHandler()); // per-request scope [web:705]
    if (Sentry.Handlers?.tracingHandler) app.use(Sentry.Handlers.tracingHandler()); // request traces [web:705]
  }

  // Mount AFTER routes: errorHandler (configurable which errors to send) [web:705]
  attachExpressPostRoutes(app, options = {}) {
    if (!this.initialized) return;
    const errMw = Sentry.Handlers?.errorHandler?.({
      shouldHandleError(error) {
        // Capture 5xx by default; optionally 404s too
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
      console.error('Sentry Capture (disabled):', error, context);
      return;
    }
    Sentry.captureException(error, { extra: context });
  }

  captureMessage(message, level = 'info', context = {}) {
    if (!this.initialized) {
      console.log(`Sentry Message (disabled) [${level}]:`, message, context);
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
    // Scrub sensitive request payload fields
    if (event.request?.data) {
      delete event.request.data.password;
      delete event.request.data.token;
    }
    return event;
  }
}

const sentryService = new EnterpriseSentryService();
export default sentryService;
