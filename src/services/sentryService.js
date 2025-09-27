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
