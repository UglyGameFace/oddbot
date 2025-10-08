// src/utils/asyncUtils.js - FINAL ABSOLUTE FIXED VERSION

// Define a custom error type for timeouts to ensure it can be specifically handled or ignored.
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
      setTimeout(() => reject(new TimeoutError(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// NOTE: safeEditMessage removed as it is defined in bot.js and is unnecessary here.
