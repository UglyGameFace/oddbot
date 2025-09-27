// src/bot/main.js
// Registers all handlers, tolerating optional/missing modules without crashing.

export async function wireUp(bot) {
  const tryImport = async (path) => {
    try { return await import(path); } catch { return null; }
  };

  const mods = await Promise.all([
    tryImport('./handlers/system.js'),
    tryImport('./handlers/settings.js'),
    tryImport('./handlers/custom.js'),
    tryImport('./handlers/tools.js'),
    tryImport('./handlers/ai.js'),
    tryImport('./handlers/quant.js'),
    tryImport('./handlers/player.js'),
  ]);

  // Register command handlers (presence-checked)
  const [
    system,
    settings,
    custom,
    tools,
    ai,
    quant,
    player,
  ] = mods;

  // System/basic commands
  if (system?.registerSystem) system.registerSystem(bot);
  if (system?.registerSystemCallbacks) system.registerSystemCallbacks(bot);

  // Settings/config
  if (settings?.registerSettings) settings.registerSettings(bot);
  if (settings?.registerSettingsCallbacks) settings.registerSettingsCallbacks(bot);

  // Manual/custom builder
  if (custom?.registerCustom) custom.registerCustom(bot);
  if (custom?.registerCustomCallbacks) custom.registerCustomCallbacks(bot);
  if (custom?.registerSlipCallbacks) custom.registerSlipCallbacks(bot);

  // Tools (/calc, /kelly, /stake)
  if (tools?.registerTools) tools.registerTools(bot);
  if (tools?.registerCommonCallbacks) tools.registerCommonCallbacks(bot);

  // AI parlay
  if (ai?.registerAI) ai.registerAI(bot);
  if (ai?.registerAICallbacks) ai.registerAICallbacks(bot);

  // Quant pick
  if (quant?.registerQuant) quant.registerQuant(bot);

  // Player props, if present
  if (player?.registerPlayer) player.registerPlayer(bot);
  if (player?.registerPlayerCallbacks) player.registerPlayerCallbacks(bot);

  // Optional: advertise available commands if system module not present
  try {
    await bot.setMyCommands([
      { command: 'custom', description: 'Manual parlay builder' },
      { command: 'parlay', description: 'AI analyst parlay' },
      { command: 'quant', description: 'Quant pick' },
      { command: 'calc', description: 'Combine odds' },
      { command: 'kelly', description: 'Kelly criterion' },
    ]);
  } catch {}
}
