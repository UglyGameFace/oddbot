// src/utils/asyncUtils.js - ABSOLUTE FINAL FIXED SCRIPT (Resolving Duplicate Export)

// Define a custom error type for timeouts to ensure it can be specifically handled.
export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => 
      // We explicitly reject with the custom TimeoutError
      setTimeout(() => reject(new TimeoutError(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// CRITICAL FIX: Only export all functions once via the export list.
export { TimeoutError, withTimeout, sleep }; 
