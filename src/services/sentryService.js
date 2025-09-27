// src/services/sentryService.js
import * as Sentry from '@sentry/node';
import '@sentry/profiling-node';
import env from '../config/env.js';

let sentryInstance;

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV || 'development',
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
  console.log('✅ Sentry initialized');

  sentryInstance = {
    getInstance: () => Sentry,
    captureError: (error, context = {}) => {
      Sentry.withScope(scope => {
        if (context.tags) {
          Object.keys(context.tags).forEach(key => scope.setTag(key, context.tags[key]));
        }
        if (context.extra) {
          Object.keys(context.extra).forEach(key => scope.setExtra(key, context.extra[key]));
        }
        if (context.component) scope.setTag('component', context.component);
        Sentry.captureException(error);
      });
    },
    attachExpressPreRoutes: (app) => {
      app.use(Sentry.Handlers.requestHandler());
      app.use(Sentry.Handlers.tracingHandler());
    },
    attachExpressPostRoutes: (app) => {
      app.use(Sentry.Handlers.errorHandler());
    }
  };
} else {
  console.log(' Sentry disabled: SENTRY_DSN not set.');
  sentryInstance = {
    getInstance: () => null,
    captureError: (error, context = {}) => {
        console.error('Sentry Capture:', {
            error: error.message,
            context
        });
    },
    attachExpressPreRoutes: () => {},
    attachExpressPostRoutes: () => {}
  };
}

// FIX: Use a named export
export const sentryService = sentryInstance;
