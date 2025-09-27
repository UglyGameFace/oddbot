<<<<<<< HEAD
// src/services/sentryService.js
import * as Sentry from '@sentry/node';
import { NodeProfiler } from '@sentry/profiling-node';
import env from '../config/env.js';

Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  integrations: [
    new NodeProfiler({
      profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
    }),
  ],
  beforeSend(event) {
    if (event.exception?.values?.[0]?.value?.includes('Environment variable')) {
      return null;
    }
    return event;
  },
});

export default {
  attachExpressPreRoutes(app) {
    if (Sentry.Handlers && Sentry.Handlers.requestHandler) {
      app.use(Sentry.Handlers.requestHandler());
    }
    if (Sentry.Handlers && Sentry.Handlers.tracingHandler) {
      app.use(Sentry.Handlers.tracingHandler());
    }
  },

  attachExpressPostRoutes(app) {
    if (Sentry.Handlers && Sentry.Handlers.errorHandler) {
      app.use(Sentry.Handlers.errorHandler());
    }
  },
};
=======
// src/services/sentryService.js — FULL: Express middleware + helpers + optional profiling (ESM-safe)
import * as Sentry from '@sentry/node';
import env, { isProduction } from '../config/env.js';

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.errorHandler = null; // retained for introspection if needed
    void this.initializeSentry();
  }

  async initializeSentry() {
    if (!env.SENTRY_DSN || !isProduction) {
      console.warn('🚨 Sentry is disabled (DSN not found or not in production).');
      return;
    }

    // Optional profiling: enable via env.SENTRY_ENABLE_PROFILING (validated in env.js)
    const enableProfiling = !!env.SENTRY_ENABLE_PROFILING;
    let profilingIntegrationFn = null;

    if (enableProfiling) {
      try {
        const mod = await import('@sentry/profiling-node'); // ESM-safe dynamic import [Sentry profiling]
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
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV, // both keys are validated now
        release: `parlay-bot@${process.env.npm_package_version || '1.0.0'}`,

        // Modern SDK integrations + optional profiling
        integrations: [
          Sentry.httpIntegration(),
          Sentry.onUnhandledRejectionIntegration?.(),
          Sentry.onUncaughtExceptionIntegration?.(),
          ...(profilingIntegrationFn ? [profilingIntegrationFn()] : []),
        ].filter(Boolean),

        // Performance + profiling sample rates
        tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),
        profilesSampleRate: Number(env.PROFILES_SAMPLE_RATE ?? 0.25),

        attachStacktrace: true,
        sendDefaultPii: false,
        maxBreadcrumbs: 100,

        // Scrub payloads
        beforeSend: (event) => this.beforeSendEvent(event),
      });

      // Global process-level safety nets (keep in addition to SDK integrations)
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

  // Install BEFORE routes, per Sentry Express docs
  attachExpressPreRoutes(app, requestOptions = {}) {
    if (!this.initialized) return;
    if (Sentry.Handlers?.requestHandler) {
      app.use(
        Sentry.Handlers.requestHandler({
          // example: include only specific user fields, suppress serverName, tweak transaction naming, etc.
          // user: ['id', 'username'],
          // serverName: false,
          // transaction: 'methodPath',
          ...requestOptions,
        })
      );
    }
    if (Sentry.Handlers?.tracingHandler) {
      app.use(Sentry.Handlers.tracingHandler());
    }
  }

  // Install AFTER routes, with configurable error capture policy
  attachExpressPostRoutes(app, { capture404 = false, shouldHandleError } = {}) {
    if (!this.initialized) return;
    const errMw = Sentry.Handlers?.errorHandler?.({
      shouldHandleError:
        typeof shouldHandleError === 'function'
          ? shouldHandleError
          : (error) => {
              if (capture404 && error?.status === 404) return true;
              return error?.status >= 500; // default to 5xx
            },
    });
    if (errMw) {
      this.errorHandler = errMw;
      app.use(errMw);
    }
  }

  // Convenience helpers retained
  captureError(error, context = {}) {
    if (!this.initialized) return console.error('Sentry Capture:', error, context);
    Sentry.captureException(error, { extra: context });
  }

  captureMessage(message, level = 'info', context = {}) {
    if (!this.initialized) return console.log(`Sentry Message [${level}]:`, message, context);
    Sentry.captureMessage(message, { level, extra: context });
  }

  identifyUser(user) {
    if (!this.initialized || !user) return;
    // Example expects tg_id + username; adjust to your user model as needed
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
>>>>>>> 118ed9165c0330494b5de9ff720ec5bdf87a4116
