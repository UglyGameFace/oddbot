import * as Sentry from '@sentry/node';
import env from '../config/env.js';

// Profiling integration, dynamic import for ESM safety.
let profilingIntegration = null;
try {
  const { NodeProfiler } = await import('@sentry/profiling-node');
  profilingIntegration = new NodeProfiler({
    profilesSampleRate: Number(env.SENTRY_PROFILES_SAMPLE_RATE || 0.1)
  });
} catch (e) {
  // Profiling support may not be enabled, that's OK
}

// Sentry SDK initialization
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),
  integrations: [
    ...(profilingIntegration ? [profilingIntegration] : [])
  ],
  beforeSend(event) {
    if (event.exception?.values?.[0]?.value?.includes('Environment variable')) {
      return null;
    }
    if (event.request?.data) {
      delete event.request.data.password;
      delete event.request.data.token;
    }
    return event;
  }
});

// Middleware helpers for Express
export default {
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
    Sentry.captureException(error, { extra: context });
  },

  captureMessage(message, level = 'info', context = {}) {
    Sentry.captureMessage(message, { level, extra: context });
  },
  
  setUser(user) {
    if (!user) return;
    Sentry.setUser({ id: user.id, username: user.username });
  }
};
