// src/utils/asyncUtils.js - FINAL ABSOLUTE FIXED SCRIPT

// Define a custom error type for timeouts to ensure it can be specifically handled.
export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => 
      // We explicitly reject with the custom TimeoutError
      setTimeout(() => reject(new TimeoutError(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export { TimeoutError, withTimeout, sleep }; 
