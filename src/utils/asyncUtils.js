// src/utils/asyncUtils.js - FINAL ABSOLUTE FIXED SCRIPT (Simplest Named Export Structure)

// Define a custom error class for timeouts to ensure it can be specifically handled.
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

// Add the missing exponentialBackoff function
export const exponentialBackoff = async (fn, maxRetries = 5, baseDelay = 1000) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
};

// NOTE: We are intentionally NOT using an export list like "export { ... }" 
// to prevent the duplicate export error shown in your log.
