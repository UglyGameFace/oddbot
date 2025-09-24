// src/utils/enterpriseUtilities.js - COMPLETE ENTERPRISE UTILITY LIBRARY
import crypto from 'crypto';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

class EnterpriseCryptography {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.key = this.deriveKey(env.ENCRYPTION_SECRET);
    this.ivLength = 16;
    this.authTagLength = 16;
  }

  deriveKey(secret) {
    return crypto.createHash('sha256').update(secret).digest();
  }

  async encryptData(data) {
    const iv = randomBytes(this.ivLength);
    const cipher = createCipheriv(this.algorithm, this.key, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      data: encrypted,
      authTag: authTag.toString('hex'),
      timestamp: Date.now()
    };
  }

  async decryptData(encryptedData) {
    try {
      const decipher = createDecipheriv(
        this.algorithm, 
        this.key, 
        Buffer.from(encryptedData.iv, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
      
      let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  async createDigitalSignature(data) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(JSON.stringify(data));
    sign.end();
    
    return sign.sign(this.privateKey, 'hex');
  }

  verifyDigitalSignature(data, signature, publicKey) {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(JSON.stringify(data));
    verify.end();
    
    return verify.verify(publicKey, signature, 'hex');
  }

  async hashData(data, algorithm = 'sha256') {
    const hash = crypto.createHash(algorithm);
    hash.update(JSON.stringify(data));
    return hash.digest('hex');
  }

  async generateSecureRandom(length = 32) {
    return randomBytes(length).toString('hex');
  }
}

class EnterpriseCompression {
  constructor() {
    this.compressionLevel = 9;
  }

  async compressData(data) {
    try {
      const compressed = await gzipAsync(JSON.stringify(data), {
        level: this.compressionLevel
      });
      return compressed.toString('base64');
    } catch (error) {
      throw new Error(`Compression failed: ${error.message}`);
    }
  }

  async decompressData(compressedData) {
    try {
      const buffer = Buffer.from(compressedData, 'base64');
      const decompressed = await gunzipAsync(buffer);
      return JSON.parse(decompressed.toString());
    } catch (error) {
      throw new Error(`Decompression failed: ${error.message}`);
    }
  }

  async optimizeForNetwork(data, targetSize = 1024) {
    let optimizedData = data;
    let currentSize = JSON.stringify(data).length;
    
    while (currentSize > targetSize) {
      optimizedData = this.applyOptimization(optimizedData);
      currentSize = JSON.stringify(optimizedData).length;
      
      if (currentSize <= targetSize) break;
      
      // Apply more aggressive compression
      optimizedData = await this.compressData(optimizedData);
      currentSize = optimizedData.length;
    }
    
    return optimizedData;
  }

  applyOptimization(data) {
    // Remove unnecessary metadata for size reduction
    const optimized = { ...data };
    
    if (optimized.metadata) {
      delete optimized.metadata.timestamp;
      delete optimized.metadata.processId;
      delete optimized.metadata.debugInfo;
    }
    
    // Shorten field names for common fields
    if (optimized.userInformation) {
      optimized.ui = optimized.userInformation;
      delete optimized.userInformation;
    }
    
    return optimized;
  }
}

class EnterpriseValidation {
  constructor() {
    this.schemas = new Map();
    this.customValidators = new Map();
    this.initializeDefaultSchemas();
  }

  initializeDefaultSchemas() {
    this.schemas.set('userData', {
      type: 'object',
      properties: {
        tg_id: { type: 'number', minimum: 1 },
        username: { type: 'string', maxLength: 255 },
        first_name: { type: 'string', maxLength: 255 },
        last_name: { type: 'string', maxLength: 255 },
        settings: { type: 'object' }
      },
      required: ['tg_id']
    });

    this.schemas.set('parlayData', {
      type: 'object',
      properties: {
        legs: { 
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sport: { type: 'string' },
              teams: { type: 'string' },
              selection: { type: 'string' },
              odds: { type: 'number' },
              confidence: { type: 'number', minimum: 0, maximum: 100 }
            },
            required: ['sport', 'teams', 'selection', 'odds']
          },
          minItems: 1,
          maxItems: 10
        },
        total_odds: { type: 'number' },
        strategy: { type: 'string' }
      },
      required: ['legs', 'total_odds']
    });
  }

  validateData(data, schemaName) {
    const schema = this.schemas.get(schemaName);
    if (!schema) {
      throw new Error(`Schema not found: ${schemaName}`);
    }

    const errors = [];
    
    // Type validation
    if (schema.type && typeof data !== schema.type) {
      errors.push(`Expected type ${schema.type}, got ${typeof data}`);
    }

    // Required fields validation
    if (schema.required) {
      for (const field of schema.required) {
        if (data[field] === undefined || data[field] === null) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Properties validation
    if (schema.properties) {
      for (const [field, rules] of Object.entries(schema.properties)) {
        if (data[field] !== undefined && data[field] !== null) {
          const fieldErrors = this.validateField(data[field], rules, field);
          errors.push(...fieldErrors);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors,
      sanitizedData: this.sanitizeData(data, schema)
    };
  }

  validateField(value, rules, fieldName) {
    const errors = [];

    if (rules.type && typeof value !== rules.type) {
      errors.push(`${fieldName}: expected type ${rules.type}, got ${typeof value}`);
    }

    if (rules.minimum !== undefined && value < rules.minimum) {
      errors.push(`${fieldName}: value ${value} is less than minimum ${rules.minimum}`);
    }

    if (rules.maximum !== undefined && value > rules.maximum) {
      errors.push(`${fieldName}: value ${value} is greater than maximum ${rules.maximum}`);
    }

    if (rules.maxLength && value.length > rules.maxLength) {
      errors.push(`${fieldName}: length ${value.length} exceeds maximum ${rules.maxLength}`);
    }

    if (rules.pattern && !rules.pattern.test(value)) {
      errors.push(`${fieldName}: value does not match pattern ${rules.pattern}`);
    }

    return errors;
  }

  sanitizeData(data, schema) {
    const sanitized = { ...data };
    
    if (schema.properties) {
      for (const [field, rules] of Object.entries(schema.properties)) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
          sanitized[field] = this.sanitizeField(sanitized[field], rules);
        }
      }
    }
    
    return sanitized;
  }

  sanitizeField(value, rules) {
    let sanitized = value;

    // Trim strings
    if (typeof sanitized === 'string') {
      sanitized = sanitized.trim();
      
      // Enforce max length
      if (rules.maxLength && sanitized.length > rules.maxLength) {
        sanitized = sanitized.substring(0, rules.maxLength);
      }
      
      // Remove potentially dangerous characters
      sanitized = sanitized.replace(/[<>]/g, '');
    }

    // Ensure numbers are within bounds
    if (typeof sanitized === 'number') {
      if (rules.minimum !== undefined && sanitized < rules.minimum) {
        sanitized = rules.minimum;
      }
      if (rules.maximum !== undefined && sanitized > rules.maximum) {
        sanitized = rules.maximum;
      }
    }

    return sanitized;
  }

  async validateRealTime(data, schemaName) {
    const validationResult = this.validateData(data, schemaName);
    
    if (!validationResult.isValid) {
      await this.logValidationFailure(validationResult.errors, data, schemaName);
    }
    
    return validationResult;
  }

  async logValidationFailure(errors, data, schemaName) {
    const failureLog = {
      timestamp: new Date().toISOString(),
      schema: schemaName,
      errors: errors,
      dataSample: this.sampleDataForLogging(data),
      severity: this.determineValidationSeverity(errors)
    };

    await DatabaseService.logValidationFailure(failureLog);
    Sentry.captureMessage(`Validation failed for ${schemaName}`, {
      extra: failureLog
    });
  }

  determineValidationSeverity(errors) {
    const criticalKeywords = ['password', 'token', 'secret', 'authorization'];
    
    for (const error of errors) {
      for (const keyword of criticalKeywords) {
        if (error.toLowerCase().includes(keyword)) {
          return 'critical';
        }
      }
    }
    
    return errors.length > 5 ? 'high' : 'medium';
  }
}

class EnterpriseLogger {
  constructor() {
    this.logLevels = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3,
      TRACE: 4
    };
    
    this.currentLevel = this.logLevels[env.LOG_LEVEL || 'INFO'];
    this.transports = this.initializeTransports();
  }

  initializeTransports() {
    return {
      console: new ConsoleTransport(),
      file: new FileTransport('./logs/enterprise.log'),
      database: new DatabaseTransport(),
      external: new ExternalLoggingService()
    };
  }

  error(message, context = {}) {
    this.log('ERROR', message, context);
  }

  warn(message, context = {}) {
    this.log('WARN', message, context);
  }

  info(message, context = {}) {
    this.log('INFO', message, context);
  }

  debug(message, context = {}) {
    this.log('DEBUG', message, context);
  }

  trace(message, context = {}) {
    this.log('TRACE', message, context);
  }

  log(level, message, context) {
    if (this.logLevels[level] > this.currentLevel) return;

    const logEntry = this.createLogEntry(level, message, context);
    
    // Async logging to all transports
    Object.values(this.transports).forEach(transport => {
      transport.log(logEntry).catch(error => {
        // Fallback to console if other transports fail
        console.error(`Logging transport failed:`, error);
      });
    });

    // Special handling for errors
    if (level === 'ERROR') {
      this.handleErrorLogging(logEntry);
    }
  }

  createLogEntry(level, message, context) {
    return {
      timestamp: new Date().toISOString(),
      level: level,
      message: message,
      context: context,
      pid: process.pid,
      hostname: require('os').hostname(),
      version: process.env.npm_package_version || '1.0.0'
    };
  }

  handleErrorLogging(logEntry) {
    // Send to Sentry for error tracking
    Sentry.captureMessage(logEntry.message, {
      level: 'error',
      extra: logEntry.context
    });

    // Alert on critical errors
    if (this.isCriticalError(logEntry)) {
      this.triggerCriticalAlert(logEntry);
    }
  }

  isCriticalError(logEntry) {
    const criticalPatterns = [
      /database connection failed/i,
      /authentication error/i,
      /payment processing failed/i,
      /security violation/i
    ];

    return criticalPatterns.some(pattern => pattern.test(logEntry.message));
  }

  async queryLogs(query) {
    const results = await Promise.all(
      Object.values(this.transports).map(transport => 
        transport.query(query).catch(() => [])
      )
    );
    
    return results.flat().sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  async performanceLog(operation, startTime, additionalContext = {}) {
    const duration = Date.now() - startTime;
    
    this.info(`${operation} completed`, {
      ...additionalContext,
      duration: duration,
      performance: this.assessPerformance(duration, operation)
    });
  }

  assessPerformance(duration, operation) {
    const benchmarks = {
      database_query: 100,
      api_call: 500,
      ai_processing: 2000,
      file_operation: 50
    };

    const benchmark = benchmarks[operation] || 1000;
    
    if (duration > benchmark * 2) return 'poor';
    if (duration > benchmark) return 'acceptable';
    return 'excellent';
  }
}

// Transport implementations
class ConsoleTransport {
  async log(entry) {
    const color = this.getColorForLevel(entry.level);
    console.log(
      `${this.formatTimestamp(entry.timestamp)} [${entry.level}] ${entry.message}`,
      entry.context
    );
  }

  getColorForLevel(level) {
    const colors = {
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
      DEBUG: '\x1b[35m', // Magenta
      TRACE: '\x1b[90m'  // Gray
    };
    return colors[level] || '\x1b[0m';
  }

  formatTimestamp(timestamp) {
    return new Date(timestamp).toISOString();
  }
}

class FileTransport {
  constructor(filePath) {
    this.filePath = filePath;
    this.fs = require('fs').promises;
    this.ensureLogDirectory();
  }

  async ensureLogDirectory() {
    const dir = require('path').dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });
  }

  async log(entry) {
    const line = JSON.stringify(entry) + '\n';
    await this.fs.appendFile(this.filePath, line, 'utf8');
  }

  async query(query) {
    const content = await this.fs.readFile(this.filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    return lines.map(line => JSON.parse(line)).filter(entry => 
      this.matchesQuery(entry, query)
    );
  }

  matchesQuery(entry, query) {
    if (query.level && entry.level !== query.level) return false;
    if (query.message && !entry.message.includes(query.message)) return false;
    if (query.startDate && new Date(entry.timestamp) < new Date(query.startDate)) return false;
    if (query.endDate && new Date(entry.timestamp) > new Date(query.endDate)) return false;
    
    return true;
  }
}

class DatabaseTransport {
  async log(entry) {
    await DatabaseService.insertLogEntry(entry);
  }

  async query(query) {
    return await DatabaseService.queryLogs(query);
  }
}

export { 
  EnterpriseCryptography, 
  EnterpriseCompression, 
  EnterpriseValidation, 
  EnterpriseLogger 
};