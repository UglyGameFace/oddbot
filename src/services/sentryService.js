// src/services/sentryService.js
import * as Sentry from '@sentry/node';
import '@sentry/profiling-node';
import env from '../config/env.js';

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
} else {
    console.log(' Sentry disabled: SENTRY_DSN not set.');
}

export default {
  ...Sentry,
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
    if (!env.SENTRY_DSN) return;
    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.tracingHandler());
  },
  attachExpressPostRoutes: (app) => {
    if (!env.SENTRY_DSN) return;
    app.use(Sentry.Handlers.errorHandler());
  }
};
