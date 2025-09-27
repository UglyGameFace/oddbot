// src/services/sentryService.js

import * as Sentry from '@sentry/node';
import env from '../config/env.js';

let profilingIntegration = null;
try {
  // Dynamically import to avoid issues if @sentry/profiling-node is not installed
  const { NodeProfiler } = await import('@sentry/profiling-node');
  profilingIntegration = new NodeProfiler();
} catch (e) {
  // Profiling support may not be enabled, which is acceptable.
  console.log('Sentry profiling integration not available.');
}

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0, // Enable profiling
    integrations: [
      ...(profilingIntegration ? [profilingIntegration] : [])
    ],
  });
  console.log('✅ Sentry Initialized.');
}

// FIX: Changed "export default" to "export const sentryService ="
// This creates a named export that matches the import statements in all your other files.
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
