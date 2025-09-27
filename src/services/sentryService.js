// src/services/sentryService.js

import * as Sentry from '@sentry/node';
import env from '../config/env.js';

let profilingIntegration = null;

// FIX: Only attempt to import and enable the profiler if it's explicitly turned on.
// This prevents the native module from running and crashing the application in incompatible environments.
if (env.SENTRY_ENABLE_PROFILING) {
  try {
    // Dynamically import to avoid issues if @sentry/profiling-node is not installed
    const { NodeProfiler } = await import('@sentry/profiling-node');
    profilingIntegration = new NodeProfiler();
    console.log('Sentry profiling integration has been enabled.');
  } catch (e) {
    // Profiling support may not be enabled, which is acceptable.
    console.log('Sentry profiling integration could not be loaded.');
  }
}

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // FIX: Use the correct environment variable for the profiles sample rate.
    profilesSampleRate: env.PROFILES_SAMPLE_RATE,
    integrations: [
      // This will now correctly add the integration only if it was successfully loaded and enabled.
      ...(profilingIntegration ? [profilingIntegration] : [])
    ],
  });
  console.log('✅ Sentry Initialized.');
}

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
        console.error("Sentry Capture (DSN not set):", { error: error.message, context });
    }
  },
};
