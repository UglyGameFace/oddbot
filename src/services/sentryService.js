// src/services/sentryService.js - ENTERPRISE-GRADE ERROR MONITORING & PERFORMANCE TRACKING
import * as Sentry from '@sentry/node';
import { ProfilingIntegration } from '@sentry/profiling-node';
import env from '../config/env.js';

class EnterpriseSentryService {
  constructor() {
    this.initialized = false;
    this.performanceTransactions = new Map();
    this.userSessions = new Map();
    
    this.initializeSentry();
    this.setupPerformanceMonitoring();
    this.initializeUserTracking();
  }

  initializeSentry() {
    if (!env.SENTRY_DSN || env.SENTRY_DSN.includes('mock')) {
      console.warn('🚨 Sentry DSN not configured - running without error monitoring');
      this.setupMockErrorHandling();
      return;
    }

    try {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        release: this.getReleaseVersion(),
        integrations: [
          new Sentry.Integrations.Http({ tracing: true }),
          new Sentry.Integrations.OnUncaughtException(),
          new Sentry.Integrations.OnUnhandledRejection(),
          new ProfilingIntegration(),
          new Sentry.Integrations.Modules(),
          new Sentry.Integrations.FunctionToString(),
          new Sentry.Integrations.LinkedErrors(),
          new Sentry.Integrations.Transaction()
        ],
        tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
        profilesSampleRate: 0.1, // 10% profiling for performance analysis
        
        // Enterprise features
        attachStacktrace: true,
        sendDefaultPii: false, // Don't send personal data
        maxBreadcrumbs: 100,
        
        beforeSend: (event) => this.beforeSendEvent(event),
        beforeBreadcrumb: (breadcrumb) => this.beforeSendBreadcrumb(breadcrumb),
        
        // Performance monitoring
        _experiments: {
          // Enable continuous profiling
          continuousProfiling: true,
        }
      });

      this.initialized = true;
      console.log('✅ Sentry Enterprise Monitoring Initialized');
      
    } catch (error) {
      console.error('❌ Sentry initialization failed:', error);
      this.setupMockErrorHandling();
    }
  }

  setupPerformanceMonitoring() {
    // Automated performance monitoring for key operations
    this.monitoredOperations = [
      'parlay_generation',
      'odds_ingestion',
      'user_authentication',
      'database_query',
      'ai_processing'
    ];

    this.monitoredOperations.forEach(operation => {
      this.setupOperationMonitoring(operation);
    });
  }

  setupOperationMonitoring(operation) {
    const originalMethods = this.getOperationMethods(operation);
    
    originalMethods.forEach(method => {
      const original = method.fn;
      
      method.fn = async (...args) => {
        const transaction = Sentry.startTransaction({
          op: operation,
          name: `${operation}_${method.name}`,
          data: {
            args: this.sanitizeOperationArgs(args),
            timestamp: new Date().toISOString()
          }
        });

        Sentry.getCurrentHub().configureScope(scope => {
          scope.setSpan(transaction);
        });

        try {
          const result = await original.apply(this, args);
          transaction.finish();
          return result;
        } catch (error) {
          transaction.setStatus('internal_error');
          transaction.finish();
          this.captureError(error, {
            operation,
            method: method.name,
            args: this.sanitizeOperationArgs(args)
          });
          throw error;
        }
      };
    });
  }

  // ENHANCED ERROR CAPTURE WITH CONTEXT
  captureError(error, context = {}) {
    if (!this.initialized) {
      this.mockErrorHandling(error, context);
      return;
    }

    const eventId = Sentry.captureException(error, {
      level: this.determineErrorLevel(error),
      extra: {
        ...context,
        nodeEnv: env.NODE_ENV,
        timestamp: new Date().toISOString(),
        processUptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      },
      tags: {
        errorType: this.classifyErrorType(error),
        component: context.component || 'unknown',
        severity: this.determineSeverity(error)
      },
      user: context.user ? this.sanitizeUserData(context.user) : undefined,
      contexts: {
        runtime: {
          name: 'node',
          version: process.version
        },
        os: {
          name: process.platform,
          version: process.arch
        }
      }
    });

    this.logErrorEvent(eventId, error, context);
    return eventId;
  }

  // PERFORMANCE MONITORING
  startPerformanceTransaction(name, operation, context = {}) {
    if (!this.initialized) return null;

    const transaction = Sentry.startTransaction({
      name,
      op: operation,
      data: context,
      tags: {
        environment: env.NODE_ENV,
        component: context.component || 'general'
      }
    });

    this.performanceTransactions.set(transaction.spanId, {
      transaction,
      startTime: Date.now(),
      context
    });

    return transaction;
  }

  endPerformanceTransaction(spanId, status = 'ok') {
    if (!this.initialized) return;

    const transactionInfo = this.performanceTransactions.get(spanId);
    if (transactionInfo) {
      transactionInfo.transaction.setStatus(status);
      transactionInfo.transaction.finish();
      
      this.recordPerformanceMetrics(transactionInfo);
      this.performanceTransactions.delete(spanId);
    }
  }

  recordPerformanceMetrics(transactionInfo) {
    const duration = Date.now() - transactionInfo.startTime;
    
    Sentry.metrics.distribution('performance.transaction.duration', duration, {
      unit: 'millisecond',
      tags: {
        operation: transactionInfo.transaction.op,
        status: transactionInfo.transaction.status,
        environment: env.NODE_ENV
      }
    });

    // Alert on slow transactions
    if (duration > 5000) { // 5 seconds threshold
      this.captureMessage(`Slow transaction detected: ${transactionInfo.transaction.name}`, {
        level: 'warning',
        extra: {
          duration,
          context: transactionInfo.context
        }
      });
    }
  }

  // USER BEHAVIOR ANALYTICS
  identifyUser(userId, traits = {}) {
    if (!this.initialized) return;

    Sentry.setUser({
      id: userId.toString(),
      ...this.sanitizeUserData(traits)
    });

    this.userSessions.set(userId, {
      identifiedAt: new Date(),
      traits,
      sessionStart: Date.now()
    });
  }

  trackUserEvent(userId, eventName, properties = {}) {
    if (!this.initialized) return;

    Sentry.addBreadcrumb({
      category: 'user',
      message: eventName,
      level: 'info',
      data: {
        userId,
        ...properties,
        timestamp: new Date().toISOString()
      }
    });

    // Record custom metric for user engagement
    Sentry.metrics.increment('user.event.count', 1, {
      tags: {
        eventName,
        userId: userId.toString(),
        environment: env.NODE_ENV
      }
    });
  }

  // BUSINESS METRICS TRACKING
  trackBusinessMetric(metricName, value, tags = {}) {
    if (!this.initialized) return;

    Sentry.metrics.distribution(`business.${metricName}`, value, {
      unit: 'none',
      tags: {
        ...tags,
        environment: env.NODE_ENV
      }
    });
  }

  trackParlayGeneration(parlayData) {
    this.trackBusinessMetric('parlay.generated', 1, {
      strategy: parlayData.strategy,
      legCount: parlayData.legs.length,
      totalOdds: parlayData.totalOdds > 0 ? 'positive' : 'negative'
    });
  }

  trackUserConversion(userId, eventType) {
    this.trackBusinessMetric('user.conversion', 1, {
      userId: userId.toString(),
      eventType,
      environment: env.NODE_ENV
    });
  }

  // SECURITY EVENT MONITORING
  captureSecurityEvent(eventType, severity, details = {}) {
    if (!this.initialized) return;

    Sentry.captureMessage(`Security Event: ${eventType}`, {
      level: this.mapSeverityToLevel(severity),
      contexts: {
        security: {
          eventType,
          severity,
          timestamp: new Date().toISOString(),
          ...details
        }
      },
      tags: {
        type: 'security',
        severity,
        eventType
      }
    });
  }

  // ENTERPRISE ALERTING
  setupCustomAlerts() {
    // Alert on error rate spikes
    Sentry.addEventProcessor((event) => {
      if (event.level === 'error') {
        this.checkErrorRateSpike();
      }
      return event;
    });

    // Alert on performance degradation
    setInterval(() => {
      this.checkPerformanceDegradation();
    }, 60000); // Check every minute
  }

  checkErrorRateSpike() {
    // Implement error rate spike detection
    const recentErrors = this.getRecentErrorCount(5 * 60 * 1000); // 5 minutes
    if (recentErrors > 10) { // More than 10 errors in 5 minutes
      this.captureMessage('Error rate spike detected', {
        level: 'warning',
        extra: { recentErrors, timeframe: '5m' }
      });
    }
  }

  // UTILITY METHODS
  beforeSendEvent(event) {
    // Sanitize sensitive data
    event = this.sanitizeEventData(event);
    
    // Add custom fingerprint for better grouping
    event.fingerprint = this.generateEventFingerprint(event);
    
    return event;
  }

  sanitizeEventData(event) {
    // Remove sensitive information
    if (event.request) {
      event.request.headers = this.sanitizeHeaders(event.request.headers);
      event.request.data = this.sanitizeRequestBody(event.request.data);
    }
    
    if (event.extra) {
      event.extra = this.sanitizeExtraData(event.extra);
    }
    
    return event;
  }

  generateEventFingerprint(event) {
    // Custom fingerprinting for better error grouping
    if (event.exception) {
      return [
        '{{ default }}',
        event.exception.values[0]?.type,
        event.exception.values[0]?.value?.substring(0, 100)
      ];
    }
    return ['{{ default }}'];
  }

  // MOCK HANDLING FOR WHEN SENTRY ISN'T CONFIGURED
  setupMockErrorHandling() {
    this.mockErrorHandling = (error, context) => {
      console.error('📛 MOCK SENTRY - Error captured:', {
        error: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString()
      });
    };

    this.mockPerformanceTracking = (name, duration) => {
      console.log('📊 MOCK SENTRY - Performance tracked:', { name, duration });
    };
  }

  // HEALTH CHECKS
  async healthCheck() {
    if (!this.initialized) {
      return { status: 'disabled', message: 'Sentry not initialized' };
    }

    try {
      // Test Sentry configuration by capturing a test event
      const testEventId = Sentry.captureMessage('Sentry Health Check', {
        level: 'info',
        tags: { type: 'health_check' }
      });

      return {
        status: 'healthy',
        eventId: testEventId,
        dsn: env.SENTRY_DSN ? 'configured' : 'missing',
        environment: env.NODE_ENV
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        dsn: env.SENTRY_DSN ? 'configured' : 'missing'
      };
    }
  }
}

// Create singleton instance
const sentryService = new EnterpriseSentryService();
export default sentryService;

// Export Sentry for direct use when needed
export { Sentry };