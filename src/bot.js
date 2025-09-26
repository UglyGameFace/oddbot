// src/bot.js
// Minimal entry that boots the modularized bot. Keeping this file name avoids changes to package.json scripts.
import { start } from './bot/main.js';

start().catch((err) => {
  // Fail fast if the app can’t start; separation of concerns keeps handlers/services unaffected.
  console.error('❌ Fatal startup error:', err?.message || err);
  process.exit(1);
});
