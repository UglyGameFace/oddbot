// src/services/sentryService.js

import * as Sentry from '@sentry/node';
import env from '../config/env.js';

let profilingIntegration = null;

async function init() {
  if (!env.SENTRY_DSN) return;
  try {
    if (env.SENTRY_ENABLE_PROFILING) {
      try {
        const { NodeProfiler } = await import('@sentry/profiling-node');
        profilingIntegration = new NodeProfiler();
        console.log('Sentry profiling integration has been enabled.');
      } catch (e) {
        console.log('Sentry profiling integration could not be loaded.');
      }
    }

    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      profilesSampleRate: Number(env.PROFILES_SAMPLE_RATE ?? 0),
      integrations: [...(profilingIntegration ? [profilingIntegration] : [])],
    });
    console.log('✅ Sentry Initialized.');
  } catch (e) {
    console.warn('Sentry initialization skipped:', e?.message || e);
  }
}
void init();

export const sentryService = {
  attachExpressPreRoutes(app) {
    if (Sentry.Handlers?.requestHandler) {
      app.use(Sentry.Handlers.requestHandler());
    }
    if (Sentry.Handlers?.tracingHandler) {
      app.use(Sentry.Handlers.tracingHandler());
    }
  },

  attachExpressPostRoutes(app) {
    if (Sentry.Handlers?.errorHandler) {
      app.use(Sentry.Handlers.errorHandler());
    }
  },

  captureError(error, context = {}) {
    if (env.SENTRY_DSN) {
      Sentry.captureException(error, { extra: context });
    } else {
      console.error('Sentry Capture (DSN not set):', { error: error?.message || String(error), context });
    }
  },
};
