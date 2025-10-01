// src/bot/handlers/ai.js - COMPLETE AND CORRECTED
import { safeTelegramMessage } from '../../utils/enterpriseUtilities.js';
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import databaseService from '../../services/databaseService.js';
import { setUserState, getUserState, getAIConfig } from '../state.js';
import { getSportEmoji, sortSports } from '../../services/sportsService.js';
import { safeEditMessage } from '../../bot.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
// --- CORRECTED: AI Client Initialization ---
// The client is initialized here, but the specific model is now chosen dynamically later.
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);


// This helper function will be used to escape text for HTML
const escapeHTML = (text) => {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};


const SPORT_TITLES = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  americanfootball_xfl: 'XFL',
  americanfootball_usfl: 'USFL',
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  basketball_ncaab: 'NCAAB',
  basketball_euroleague: 'EuroLeague',
  baseball_mlb: 'MLB',
  baseball_npb: 'NPB (Japan)',
  baseball_kbo: 'KBO (Korea)',
  icehockey_nhl: 'NHL',
  hockey_nhl: 'NHL', // Alias
  icehockey_khl: 'KHL',
  icehockey_sweden: 'Swedish Hockey',
  icehockey_finland: 'Finnish Hockey',
  soccer_england_premier_league: 'Premier League',
  soccer_spain_la_liga: 'La Liga',
  soccer_italy_serie_a: 'Serie A',
  soccer_germany_bundesliga: 'Bundesliga',
  soccer_france_ligue_1: 'Ligue 1',
  soccer_uefa_champions_league: 'Champions League',
  soccer_uefa_europa_league: 'Europa League',
  soccer_mls: 'MLS',
  soccer_world_cup: 'World Cup',
  soccer_euro: 'European Championship',
  soccer_copa_america: 'Copa America',
  tennis_atp: 'ATP Tennis',
  tennis_wta: 'WTA Tennis',
  tennis_aus_open: 'Australian Open',
  tennis_french_open: 'French Open',
  tennis_wimbledon: 'Wimbledon',
  tennis_us_open: 'US Open',
  mma_ufc: 'UFC',
  boxing: 'Boxing',
  formula1: 'Formula 1',
  motogp: 'MotoGP',
  nascar: 'NASCAR',
  indycar: 'IndyCar',
  golf_pga: 'PGA Tour',
  golf_european: 'European Tour',
  golf_liv: 'LIV Golf',
  golf_masters: 'The Masters',
  golf_us_open: 'US Open',
  golf_pga_championship: 'PGA Championship',
  golf_open_championship: 'The Open',
  cricket_ipl: 'IPL Cricket',
  cricket_big_bash: 'Big Bash',
  cricket_psl: 'PSL Cricket',
  rugby_union: 'Rugby Union',
  rugby_league: 'Rugby League',
  aussie_rules_afl: 'AFL',
  handball: 'Handball',
  volleyball: 'Volleyball',
  table_tennis: 'Table Tennis',
  badminton: 'Badminton',
  darts: 'Darts',
  snooker: 'Snooker'
};

const PAGE_SIZE = 10;

const DEFAULT_SPORTS = [
  { sport_key: 'americanfootball_nfl', sport_title: 'NFL' },
  { sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF' },
  { sport_key: 'basketball_nba', sport_title: 'NBA' },
  { sport_key: 'baseball_mlb', sport_title: 'MLB' },
  { sport_key: 'icehockey_nhl', sport_title: 'NHL' },
  { sport_key: 'soccer_england_premier_league', sport_title: 'Premier League' },
];

// --- Prompt Template & Builder Logic ---
const getBasePrompt = (userSettings = {}) => {
  const settings = {
    sport: userSettings.sportKey || 'NCAAF',
    numLegs: userSettings.numLegs || 3,
    ...userSettings,
  };

  return `
ROLE
You are an expert assistant for a Telegram sports-betting + engineering bot. Objectives:
- Produce data-backed picks/parlays with EV and Kelly staking.
- Debug/author production-ready Node.js 20+ code for this bot.
- Provide deployment/infra guidance for Railway/Render.
- Return Telegram-safe MarkdownV2, plus a strict JSON payload for downstream automation.

MODES (auto-detect unless specified by user)
- BETS: Betting analysis, lines, parlays, EV, staking, bankroll.
- CODE: Code fixes, patches, refactors, stack traces.
- OPS: Deploy/infra, Docker, env vars, health checks, logs.
- RESEARCH: Verify odds, statuses, news, movements, summaries.
- TELEGRAM: Build Markdown and MarkdownV2-escaped messages.

GLOBAL RULES
- Start with a 1-2 sentence direct answer; then short headers with flat bullet lists (no nested lists).
- Deterministic outputs: specify versions, limits, steps, and acceptance checks.
- Separate facts from assumptions; if key context is missing, state the single most critical assumption and proceed.
- For numerical work (EV/Kelly), show key intermediate values and formulas.
- Always produce TWO artifacts:
  A) human_readable: concise Markdown for humans.
  B) output_json: strict JSON matching the selected Mode schema.
- For Telegram, produce both message_markdown (readable) and message_markdown_v2 (escaped).

BETTING MODE
- Default: ${settings.sport} emphasis; support MLB/NBA/WNBA/NFL/soccer as requested.
- Only recommend a bet if EV > 0 and key player/status info is confirmed; otherwise “No bet”.
- Default parlay legs: ${settings.numLegs} unless explicitly requested otherwise.
- Price discipline: line-shop; never fabricate lines. If exact unavailable, state nearest widely-posted price and uncertainty.
- Math:
  - American odds implied probability:
    - For +A: p_implied = 100 / (A + 100)
    - For -A: p_implied = A / (A + 100) with A absolute
  - Decimal odds: p_implied = 1 / decimal_odds
  - Kelly (binary): f* = p - (1 - p) / b, where b = decimal_odds - 1
  - Default staking: Half Kelly; cap stake if liquidity/uncertainty elevated.
  - Parlays: P_win = product(p_i); EV uses joint probability and combined price.
- Human_readable sections: Picks, Rationale (2-3 bullets/leg), Pricing/Line-Shop Notes, EV/Kelly, Risks, Final Call (“Bet” or “No bet”).
- If data freshness is uncertain, say so and prefer “No bet” unless instructed to proceed.

CODE MODE
- Environment: Node.js 20+, ESM, Express-style; Telegram bot formatting conventions.
- Produce copy-paste ready full files or unified diffs with imports/exports, no placeholders.
- Enforce MarkdownV2 escaping for all dynamic fields; keep parse_mode consistent on send/edit.
- Include timeouts, retries/backoff, structured logging, and /health if missing.
- Structure: Fix summary, Code block(s), Why it works, How to verify (commands + expected outputs), Rollback plan.

OPS MODE
- Targets: Railway/Render; include Dockerfile, service config, port binding, health checks, logs, env/secrets.
- Provide rate-limit/backoff guidance for free tiers; verification steps for webhook vs polling; fallback plan.

RESEARCH MODE
- Verify lines/totals/statuses with multiple recent, reputable sources; timestamp findings and note movements.
- If sources conflict or are stale, state uncertainty and prefer “No bet” unless asked to proceed.
- Summarize line-shopping impact and sensitivity.

TELEGRAM SAFETY (MarkdownV2)
- Escape dynamic characters: _ * [ ] ( ) ~ \` > # + - = | { } . !
- Keep static formatting tokens unescaped; escape only dynamic insertions.
- Prefer inline code for timestamps/paths/errors; avoid nested formatting.
- Always supply both: message_markdown (readable) and message_markdown_v2 (escaped).

OUTPUT CONTRACT (always include)
- human_readable: concise Markdown with headers and flat bullets.
- output_json: strict JSON for the selected mode, matching one of the schemas below.

SCHEMAS
Mode=BETS
{
  "mode": "BETS",
  "sport": "string",
  "legs": [
    {
      "event": "string",
      "market": "moneyline|spread|total|prop",
      "selection": "string",
      "price_american": "number",
      "price_decimal": "number|null",
      "book": "string|null",
      "rationale": "string",
      "implied_prob": "number"
    }
  ],
  "parlay_price_american": "number",
  "parlay_price_decimal": "number|null",
  "est_win_prob": "number",
  "est_ev_pct": "number",
  "kelly": { "fraction": "number", "stake_pct_bankroll": "number" },
  "constraints": { "max_legs": "number", "allow_same_game": "boolean" },
  "risks": ["string"],
  "assumptions": ["string"],
  "telegram": {
    "message_markdown": "string",
    "message_markdown_v2": "string"
  }
}
Mode=CODE { /* ...schema... */ }
Mode=OPS { /* ...schema... */ }
Mode=RESEARCH { /* ...schema... */ }
Mode=TELEGRAM { /* ...schema... */ }

FAIL-SAFE
- If constraints conflict or data is unavailable: produce a best-effort result with explicit assumptions and a short checklist to resolve gaps. If betting data freshness is unclear, default to “No bet”.
`;
};

const buildParlayPrompt = (userQuery, userSettings = {}) => {
    const basePrompt = getBasePrompt(userSettings);
    const finalPrompt = `${basePrompt}

USER QUERY:
Analyze the following request and generate a response adhering strictly to the rules and output contract specified above.

"${userQuery}"
`;
    return finalPrompt;
};

// --- Existing Helper Functions ---
function pageOf(arr, page) {
  const start = page * PAGE_SIZE;
  return arr.slice(start, start + PAGE_SIZE);
}

function formatLocalIfPresent(utcDateString, timezone) {
    if (!utcDateString) return null;
    try {
        const date = new Date(utcDateString);
        return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
        }).format(date);
    } catch (error) {
        console.warn('Date localization failed:', error.message);
        return null;
    }
}

async function getAllAvailableSports() {
  const sportsCollection = new Map();
  console.log('🔄 Starting comprehensive sports discovery...');
  try {
    const gamesServiceSports = await gamesService.getAvailableSports();
    if (gamesServiceSports && Array.isArray(gamesServiceSports)) {
      gamesServiceSports.forEach(sport => {
        if (sport?.sport_key) {
          sportsCollection.set(sport.sport_key, {
            sport_key: sport.sport_key,
            sport_title: sport.sport_title || SPORT_TITLES[sport.sport_key] || sport.sport_key,
            source: 'gamesService',
            priority: 1
          });
        }
      });
    }
  } catch (error) {
    console.warn('❌ gamesService failed during sport discovery:', error.message);
  }
  try {
    const dbSports = await databaseService.getDistinctSports();
    if (dbSports && Array.isArray(dbSports)) {
      dbSports.forEach(sport => {
        if (sport?.sport_key && !sportsCollection.has(sport.sport_key)) {
          sportsCollection.set(sport.sport_key, {
            sport_key: sport.sport_key,
            sport_title: sport.sport_title || SPORT_TITLES[sport.sport_key] || sport.sport_key,
            source: 'databaseService',
            priority: 2
          });
        }
      });
    }
  } catch (error) {
    console.warn('❌ databaseService failed during sport discovery:', error.message);
  }
  Object.entries(SPORT_TITLES).forEach(([sport_key, sport_title]) => {
    if (!sportsCollection.has(sport_key)) {
      sportsCollection.set(sport_key, { sport_key, sport_title, source: 'comprehensive_list', priority: 3 });
    }
  });
  if (sportsCollection.size === 0) {
    DEFAULT_SPORTS.forEach(sport => {
      sportsCollection.set(sport.sport_key, { ...sport, source: 'static_defaults', priority: 4 });
    });
  }
  const sports = Array.from(sportsCollection.values()).sort((a, b) => a.priority - b.priority);
  console.log(`🎉 Sports discovery complete: ${sports.length} total sports found`);
  return sports;
}

let sportsCache = null;
let sportsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000;

async function getCachedSports() {
  const now = Date.now();
  if (sportsCache && sportsCacheTime && (now - sportsCacheTime) < CACHE_DURATION) {
    return sportsCache;
  }
  try {
    sportsCache = await getAllAvailableSports();
    sportsCacheTime = now;
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    return sportsCache || DEFAULT_SPORTS;
  }
}

// --- Command Registration ---
export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    await setUserState(chatId, { page: 0 });
    sendSportSelection(bot, chatId);
  });

  bot.onText(/^\/ai_live$/, async (msg) => {
    await handleDirectFallback(bot, msg.chat.id, 'live');
  });

  bot.onText(/^\/ai_db$/, async (msg) => {
    await handleDirectFallback(bot, msg.chat.id, 'db');
  });

  bot.onText(/^\/ai_nfl$/, async (msg) => {
    await handleQuickSport(bot, msg.chat.id, 'americanfootball_nfl');
  });

  bot.onText(/^\/ai_nba$/, async (msg) => {
    await handleQuickSport(bot, msg.chat.id, 'basketball_nba');
  });

  bot.onText(/^\/ai_mlb$/, async (msg) => {
    await handleQuickSport(bot, msg.chat.id, 'baseball_mlb');
  });

  bot.onText(/^\/ai_soccer$/, async (msg) => {
    await handleQuickSport(bot, msg.chat.id, 'soccer_england_premier_league');
  });
}

async function handleQuickSport(bot, chatId, sportKey) {
  try {
    await setUserState(chatId, {
      sportKey,
      numLegs: 4,
      mode: 'web',
      betType: 'mixed',
      aiModel: 'perplexity', // 'perplexity' (data-focused) is a good default
      quantitativeMode: 'conservative'
    });

    const sportTitle = SPORT_TITLES[sportKey] || sportKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const sentMessage = await bot.sendMessage(
      chatId,
      `⚡️ Quick start: Building 4-leg ${escapeHTML(sportTitle)} parlay via Web Research...`,
      { parse_mode: 'HTML' }
    );

    await executeAiRequest(bot, chatId, sentMessage.message_id);

  } catch (error) {
    console.error('Quick sport command failed:', error);
    await bot.sendMessage(
      chatId,
      `❌ Quick start failed: <code>${escapeHTML(error.message || 'Unknown error')}</code>\n\nPlease use /ai for the full builder.`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleDirectFallback(bot, chatId, mode) {
  const state = await getUserState(chatId);
  if (!state?.sportKey || !state?.numLegs) {
    await bot.sendMessage(
      chatId,
      `Please start with /ai first to select sport and legs, then use /ai_${mode} if web research fails.\n\nOr use quick commands: /ai_nfl, /ai_nba, /ai_mlb, /ai_soccer`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { sportKey, numLegs, betType = 'mixed' } = state;

  try {
    const sentMessage = await bot.sendMessage(
      chatId,
      `🔄 Switching to <b>${escapeHTML(mode.toUpperCase())}</b> mode for ${escapeHTML(sportKey)}...\n\nThis uses stored data and may not reflect current odds.`,
      { parse_mode: 'HTML' }
    );

    const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, mode, betType);
    await sendParlayResult(bot, chatId, parlay, state, mode, sentMessage.message_id);

  } catch (error)
 {
    console.error('Direct fallback execution error:', error);
    await bot.sendMessage(
      chatId,
      `❌ Fallback mode failed: <code>${escapeHTML(error.message || 'Unknown error')}</code>\n\nPlease try /ai again with a different sport or mode.`,
      { parse_mode: 'HTML' }
    );
  } finally {
    await setUserState(chatId, {});
  }
}

// --- Callback Handler ---
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    try {
      await bot.answerCallbackQuery(cbq.id);
    } catch (error) {
      if (!error.message.includes("query is too old")) {
        console.error("Error answering callback query:", error);
      }
    }

    let state = await getUserState(chatId) || {};
    const parts = data.split('_');
    const action = parts[1];

    if (action === 'page') {
      const page = parseInt(parts[2], 10) || 0;
      state.page = page;
      await setUserState(chatId, state);
      return sendSportSelection(bot, chatId, message.message_id, page);
    }

    if (action === 'sport') {
      state.sportKey = parts.slice(2).join('_');
      await setUserState(chatId, state);
      sendLegSelection(bot, chatId, message.message_id);
      return;
    }

    if (action === 'legs') {
      state.numLegs = parseInt(parts[2], 10);
      await setUserState(chatId, state);
      sendModeSelection(bot, chatId, message.message_id);
      return;
    }

    if (action === 'mode') {
      state.mode = parts[2];
      await setUserState(chatId, state);
      if (state.mode === 'db') {
        state.betType = 'mixed';
        await setUserState(chatId, state);
        executeAiRequest(bot, chatId, message.message_id);
      } else {
        sendBetTypeSelection(bot, chatId, message.message_id);
      }
      return;
    }

    if (action === 'bettype') {
      state.betType = parts[2];
      await setUserState(chatId, state);
      if (state.mode === 'web') {
        sendAiModelSelection(bot, chatId, message.message_id);
      } else {
        executeAiRequest(bot, chatId, message.message_id);
      }
      return;
    }

    if (action === 'model') {
      state.aiModel = parts[2];
      await setUserState(chatId, state);
      sendQuantitativeModeSelection(bot, chatId, message.message_id);
      return;
    }

    if (action === 'toggle') {
      const what = parts[2];
      if (what === 'props') {
        state.includeProps = !state.includeProps;
        await setUserState(chatId, state);
        return sendBetTypeSelection(bot, chatId, message.message_id);
      }
    }

    if (action === 'back') {
      const to = parts[2];
      if (to === 'sport') return sendSportSelection(bot, chatId, message.message_id, state.page || 0);
      if (to === 'legs') return sendLegSelection(bot, chatId, message.message_id);
      if (to === 'mode') return sendModeSelection(bot, chatId, message.message_id);
      if (to === 'bettype') return sendBetTypeSelection(bot, chatId, message.message_id);
      if (to === 'model') return sendAiModelSelection(bot, chatId, message.message_id);
    }

    if (action === 'fallback') {
        const selectedMode = parts[2];
        const { sportKey, numLegs, betType = 'mixed' } = state;
  
        if (!sportKey || !numLegs) {
          return safeEditMessage(chatId, message.message_id, 'Missing sport or leg selection. Please start over with /ai.');
        }
  
        try {
          await safeEditMessage(chatId, message.message_id, `🔄 Switching to <b>${escapeHTML(selectedMode.toUpperCase())}</b> mode...\n\nThis uses stored data and may not reflect current odds.`, { parse_mode: 'HTML' });
  
          const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, selectedMode, betType);
          await sendParlayResult(bot, chatId, parlay, state, selectedMode, message.message_id);
  
        } catch (error) {
          console.error('Fallback selection error:', error);
          await safeEditMessage(chatId, message.message_id, `❌ Fallback mode failed: <code>${escapeHTML(error.message || 'Unknown error')}</code>\n\nPlease try /ai again.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_back_sport' }]] }
          });
        } finally {
          await setUserState(chatId, {});
        }
        return;
    }

    if (action === 'analytics') {
      const currentState = await getUserState(chatId);
      const sportKey = currentState.lastSportKey || currentState.sportKey;

      if (!sportKey) {
        return safeEditMessage(chatId, message.message_id,
            '❌ No sport data available for analytics. Please generate a parlay first.',
            { parse_mode: 'HTML' }
        );
      }

      try {
        await safeEditMessage(chatId, message.message_id,
            `📊 Generating analytics for <b>${escapeHTML(sportKey)}</b>... This might take a moment.`,
            { parse_mode: 'HTML' }
        );

        const analyticsService = (await import('./analytics.js')).default;
        const analytics = await analyticsService.generateSportAnalytics(sportKey);

        let analyticsText = `📊 <b>Analytics for ${escapeHTML(sportKey.replace(/_/g, ' ').toUpperCase())}</b>\n\n`;

        analyticsText += `<b>Data Quality: ${escapeHTML(analytics.data_quality.overall.toUpperCase())}</b>\n`;
        analyticsText += `  - Odds Data: ${analytics.data_quality.odds_data.games_count} games\n`;
        analyticsText += `  - Games Data: ${analytics.data_quality.games_data.games_count} games\n\n`;

        const quant = analytics.quantitative;
        analyticsText += `<b>Quantitative Insights:</b>\n`;
        analyticsText += `  - Upcoming Games (72h): ${quant.games_analysis.upcoming_games}\n`;
        analyticsText += `  - Avg. Bookmakers per Game: ${quant.market_analysis.average_books_per_game}\n`;
        analyticsText += `  - Market Variety: ${escapeHTML(quant.market_analysis.market_variety.toUpperCase())}\n\n`;

        const pred = analytics.predictive;
        analyticsText += `<b>Predictive Model:</b>\n`;
        analyticsText += `  - Clear Favorites Found: ${pred.clear_favorites}\n`;
        analyticsText += `  - Close Matchups: ${pred.close_games}\n`;
        analyticsText += `  - High-Value Opportunities: ${pred.high_value_opportunities}\n\n`;

        if (analytics.recommendations && analytics.recommendations.length > 0) {
            analyticsText += `<b>Key Recommendations:</b>\n`;
            analytics.recommendations.slice(0, 2).forEach(rec => {
                analyticsText += `  • ${escapeHTML(rec.message)}\n`;
            });
        }

        await safeEditMessage(chatId, message.message_id, analyticsText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Build Another Parlay', callback_data: 'ai_back_sport' }]
                ]
            }
        });

      } catch (error) {
          console.error('Analytics generation failed:', error);
          await safeEditMessage(chatId, message.message_id,
              `❌ Analytics generation failed: <code>${escapeHTML(error.message)}</code>`,
              { parse_mode: 'HTML' }
          );
      }
      return;
    }

    if (action === 'quick') {
      const quickAction = parts[2];
      if (quickAction === 'retry') {
        await safeEditMessage(chatId, message.message_id, '🔄 Retrying with same parameters...', { parse_mode: 'HTML' });
        return executeAiRequest(bot, chatId, message.message_id);
      }
      if (quickAction === 'change_sport') {
        await setUserState(chatId, { page: 0 });
        return sendSportSelection(bot, chatId, message.message_id, 0);
      }
    }

    if (action === 'quantitative') {
      state.quantitativeMode = parts[2];
      await setUserState(chatId, state);
      return executeAiRequest(bot, chatId, message.message_id);
    }

    if (action === 'quantitative_help') {
      const helpText = `📊 <b>Quantitative Analysis Modes</b>\n\n` +
      `🔬 <b>Conservative Mode</b>:\n` +
      `• Applies 15% probability shrinkage toward 50%\n` +
      `• Adds correlation penalty (5% per leg)\n` +
      `• Accounts for bookmaker vig and line movement\n` +
      `• <i>Result: Realistic, sustainable EV estimates</i>\n\n` +
      `🚀 <b>Aggressive Mode</b>:\n` +
      `• Uses raw AI probability estimates\n` +
      `• No calibration for overconfidence\n` +
      `• Assumes perfect independence\n` +
      `• <i>Result: Higher apparent EV but likely overstated</i>\n\n` +
      `<b>Recommendation</b>: Use Conservative mode for long-term profitability.`;
      await safeEditMessage(chatId, message.message_id, helpText, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔬 Use Conservative', callback_data: 'ai_quantitative_conservative' }],
            [{ text: '🚀 Use Aggressive', callback_data: 'ai_quantitative_aggressive' }],
            [{ text: '« Back', callback_data: 'ai_back_model' }]
          ]
        }
      });
      return;
    }

  });
}

// --- UI Message Functions ---
async function sendSportSelection(bot, chatId, messageId = null, page = 0) {
  let sports = [];
  let errorMessage = '';

  try {
    sports = await getCachedSports();
  } catch (error) {
    console.error('Failed to get sports list:', error);
    sports = DEFAULT_SPORTS;
    errorMessage = '\n\n⚠️ Using cached sports data due to connection issues.';
  }

  sports = sortSports(sports.filter(s => s?.sport_key));

  const totalPages = Math.ceil(sports.length / PAGE_SIZE) || 1;
  page = Math.min(Math.max(0, page), totalPages - 1);

  const slice = pageOf(sports, page).map(s => {
    const title = s?.sport_title ?? SPORT_TITLES[s.sport_key] ?? s.sport_key;
    return { text: `${getSportEmoji(s.sport_key)} ${escapeHTML(title)}`, callback_data: `ai_sport_${s.sport_key}` };
  });

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));

  if (page === 0) {
    const quickActions = [
      { text: '🏈 NFL', callback_data: 'ai_sport_americanfootball_nfl' },
      { text: '🏀 NBA', callback_data: 'ai_sport_basketball_nba' },
      { text: '⚾️ MLB', callback_data: 'ai_sport_baseball_mlb' },
      { text: '⚽️ Soccer', callback_data: 'ai_sport_soccer_england_premier_league' }
    ];
    rows.unshift(quickActions);
  }

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Prev', callback_data: `ai_page_${page - 1}` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'ai_noop' });
    if (page < totalPages - 1) nav.push({ text: 'Next ›', callback_data: `ai_page_${page + 1}` });
    if (nav.length) rows.push(nav);
  }

  rows.push([
    { text: '❓ Help', callback_data: 'ai_help_sports' },
    { text: '🔄 Refresh', callback_data: 'ai_refresh_sports' }
  ]);

  const text = `🤖 <b>AI Parlay Builder</b>${escapeHTML(errorMessage)}\n\n<b>Step 1:</b> Select a sport.\n\n<b>Available:</b> ${sports.length} sports across ${totalPages} pages`;
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };

  if (messageId) {
    await safeEditMessage(chatId, messageId, text, opts);
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function sendLegSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = SPORT_TITLES[state.sportKey] || state.sportKey?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const legOptions = [2, 3, 4, 5, 6, 7, 8];
  const buttons = legOptions.map(num => ({
    text: `${num} Leg${num > 1 ? 's' : ''}`,
    callback_data: `ai_legs_${num}`
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4));

  const popularCombos = [
    { text: '🔥 4-Leg (Balanced)', callback_data: 'ai_legs_4' },
    { text: '⚡️ 3-Leg (Conservative)', callback_data: 'ai_legs_3' },
    { text: '🎯 5-Leg (Aggressive)', callback_data: 'ai_legs_5' }
  ];
  keyboard.unshift(popularCombos);

  keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);

  const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 2:</b> How many legs for your ${escapeHTML(sportTitle)} parlay?\n\n• 2-3 legs: Higher confidence\n• 4-5 legs: Balanced risk/reward\n• 6+ legs: Higher payout, more risk`;
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendModeSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = SPORT_TITLES[state.sportKey] || state.sportKey?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const text = `🤖 <b>AI Parlay Builder</b>\n\n<b>Step 3:</b> Select analysis mode for ${escapeHTML(sportTitle)}.`;
  const keyboard = [
    [{ text: '🌐 Web Research (Recommended)', callback_data: 'ai_mode_web'}],
    [{ text: '📡 Live API Data (Premium)', callback_data: 'ai_mode_live'}],
    [{ text: '💾 Database Only (Fallback)', callback_data: 'ai_mode_db'}],
    [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId) || {};
  const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 4:</b> What kind of parlay should I build?';

  const keyboard = [
    [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props'}],
    [{ text: '🎯 Moneyline Focus', callback_data: 'ai_bettype_moneyline'}],
    [{ text: '📊 Spreads & Totals', callback_data: 'ai_bettype_spreads'}],
    [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed'}],
    [{ text: `🥇 Include Player Props: ${state.includeProps ? 'ON' : 'OFF'}`, callback_data: 'ai_toggle_props' }],
    [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
  ];

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendAiModelSelection(bot, chatId, messageId) {
  const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 5:</b> Choose your Research AI.\n\n• 🧠 Gemini: Creative analysis, better narratives\n• ⚡️ Perplexity: Data-focused, faster results';
  const keyboard = [
    [{ text: '🧠 Gemini (Creative)', callback_data: 'ai_model_gemini'}],
    [{ text: '⚡️ Perplexity (Data-Focused)', callback_data: 'ai_model_perplexity'}],
    [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendQuantitativeModeSelection(bot, chatId, messageId) {
    const text = '🤖 <b>AI Parlay Builder</b>\n\n<b>Step 6:</b> Select Quantitative Analysis Mode\n\n• 🔬 <b>Conservative</b>: Applies realistic calibration for overconfidence and correlation (Recommended)\n• 🚀 <b>Aggressive</b>: Uses raw AI probabilities (Higher risk, higher potential reward)';

    const keyboard = [
      [{ text: '🔬 Conservative (Recommended)', callback_data: 'ai_quantitative_conservative' }],
      [{ text: '🚀 Aggressive (High Risk)', callback_data: 'ai_quantitative_aggressive' }],
      [{ text: '📊 Explain Modes', callback_data: 'ai_quantitative_help' }],
      [{ text: '« Back to AI Model', callback_data: 'ai_back_model' }]
    ];

    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendFallbackOptions(bot, chatId, messageId, error) {
  const { fallbackOptions, dataFreshness } = error;

  const text =
    `❌ <b>Web Research Failed</b>\n\n` +
    `<b>Error:</b> ${escapeHTML(error.originalError)}\n\n` +
    `<b>${escapeHTML(fallbackOptions.db_mode.warning)}</b>\n\n` +
    `Choose a fallback option:\n\n` +
    `🔴 <b>Live Mode</b>: ${escapeHTML(fallbackOptions.live_mode.description)}\n` +
    `💾 <b>Database Mode</b>: ${escapeHTML(fallbackOptions.db_mode.description)}\n\n` +
    `📅 Data last refreshed: ${escapeHTML(new Date(dataFreshness.lastRefresh).toLocaleString())}\n` +
    `⏰ Age: ${escapeHTML(dataFreshness.hoursAgo)} hours ago`;

  const keyboard = [
    [{ text: '🔴 Use Live Mode', callback_data: 'ai_fallback_live' }],
    [{ text: '💾 Use Database Mode', callback_data: 'ai_fallback_db' }],
    [{ text: '🔄 Try Different Sport', callback_data: 'ai_back_sport' }],
    [{ text: '❓ Why did this fail?', callback_data: 'ai_help_fallback' }]
  ];

  await safeEditMessage(
    chatId,
    messageId,
    text,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

async function sendParlayResult(bot, chatId, parlay, state, mode, messageId) {
    const { sportKey, numLegs } = state;
    const legs = parlay.legs || parlay.parlay_legs;
    const parlay_odds_american = parlay.parlay_price_american || parlay.parlay_odds_american;
    const quant = parlay.kelly ? {
        calibrated: {
            evPercentage: (parlay.est_ev_pct || 0) * 100,
            jointProbability: parlay.est_win_prob || 0,
        },
        riskAssessment: {
            overallRisk: parlay.risks ? parlay.risks.join(', ') : 'N/A'
        },
        staking: {
            kellyFractionHalf: (parlay.kelly.fraction || 0) / 2
        }
    } : parlay.quantitative_analysis;
    const sources = parlay.sources;
    const market_variety = parlay.market_variety;

    const tzLabel = 'America/New_York';

    await setUserState(chatId, { ...state, lastSportKey: sportKey });

    let response = `🧠 <b>AI-Generated ${escapeHTML(numLegs)}-Leg Parlay</b>\n`;
    response += `<b>Sport:</b> ${escapeHTML(SPORT_TITLES[sportKey] || sportKey)}\n`;
    response += `<b>Mode:</b> ${escapeHTML(mode.toUpperCase())}\n\n`;

    if (!legs || legs.length === 0) {
        response += '<i>The AI could not construct a valid parlay with the given parameters. This might be due to a lack of available games or data.</i>';
    } else {
        legs.forEach((leg, index) => {
            const when = leg.game_date_local || (leg.game_date_utc ? formatLocalIfPresent(leg.game_date_utc, tzLabel) : 'TBD');
            const game = escapeHTML(leg.event || leg.game || '');
            const pick = escapeHTML(leg.selection || leg.pick || '');
            const oddsValue = leg.price_american || leg.odds_american;
            const oddsDisplay = escapeHTML(oddsValue > 0 ? `+${oddsValue}` : oddsValue);
            const justification = escapeHTML(leg.rationale || leg.justification || '');

            response += `<b>Leg ${index + 1}: ${game}</b>\n`;
            response += `  <b>Pick:</b> ${pick} (${oddsDisplay})\n`;
            if (when) response += `  <i>${escapeHTML(when)}</i>\n`;
            response += `  <i>${justification}</i>\n\n`;
        });
    }

    if (parlay_odds_american) {
        const oddsSign = parlay_odds_american > 0 ? '+' : '';
        response += `<b>Total Odds:</b> ${oddsSign}${escapeHTML(parlay_odds_american)}\n`;
    }

    if (quant) {
        const calEV = quant.calibrated.evPercentage;
        const rawEV = quant.raw ? quant.raw.evPercentage : null;

        response += `<b>Calibrated EV:</b> ${escapeHTML(calEV.toFixed(1))}% ${calEV > 0 ? '👍' : '👎'}\n`;
        if (rawEV) response += `<i>(Raw EV: ${escapeHTML(rawEV.toFixed(1))}%)</i>\n`;
        response += `<b>Win Probability:</b> ${escapeHTML((quant.calibrated.jointProbability * 100).toFixed(1))}%\n`;
        response += `<b>Risk Level:</b> ${escapeHTML(quant.riskAssessment.overallRisk)}\n`;
        if (quant.staking.kellyFractionHalf > 0) {
            response += `<b>Suggested Stake (Half Kelly):</b> ${escapeHTML((quant.staking.kellyFractionHalf * 100).toFixed(1))}% of bankroll\n`;
        }
    }

    if (market_variety) {
        response += `<b>Market Variety Score:</b> ${escapeHTML(Math.round(market_variety.score * 100))}%\n`;
    }

    if (sources && sources.length > 0) {
        response += `\n<b>Primary Sources Used:</b>\n`;
        sources.slice(0, 2).forEach(source => {
            const displayUrl = source.replace(/https?:\/\/(www\.)?/, '').split('/')[0];
            response += `• <a href="${escapeHTML(source)}">${escapeHTML(displayUrl)}</a>\n`;
        });
    }

    const finalKeyboard = [
        [{ text: '🔄 Build Another', callback_data: 'ai_back_sport' }],
        [{ text: '⚡️ Quick NFL', callback_data: 'ai_sport_americanfootball_nfl' }],
        [{ text: '📊 View Analytics', callback_data: 'ai_analytics' }]
    ];

    const messageOpts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } };

    if (messageId) {
        await safeEditMessage(chatId, messageId, response, messageOpts);
    } else {
        await bot.sendMessage(chatId, response, messageOpts);
    }
}


// --- The Corrected and Upgraded AI Request Execution ---
async function executeAiRequest(bot, chatId, messageId) {
    const state = await getUserState(chatId);
    const aiConfig = await getAIConfig(chatId);
    const { sportKey, numLegs, mode, betType, aiModel = 'gemini', includeProps = false, quantitativeMode = 'conservative' } = state || {};

    if (!sportKey || !numLegs || !mode || !betType) {
      return safeEditMessage(chatId, messageId, '❌ Incomplete selection. Please start over using /ai.');
    }

    let modeText = { web: 'Web Research', live: 'Live API Data', db: 'Database Only' }[mode];
    if (mode === 'web' && aiModel) modeText += ` via ${aiModel.charAt(0).toUpperCase() + aiModel.slice(1)}`;

    const text = `🤖 <b>Initiating Deep Web Analysis...</b>\n\n` +
                 `<b>Strategy:</b> ${escapeHTML(numLegs)}-Leg Parlay\n` +
                 `<b>Sport:</b> ${escapeHTML(SPORT_TITLES[sportKey] || sportKey)}\n` +
                 `<b>Mode:</b> ${escapeHTML(modeText)}\n\n` +
                 `<b>Process:</b>\n` +
                 `  1.  Scanning schedules & injury reports...\n` +
                 `  2.  Analyzing matchups & statistical trends...\n` +
                 `  3.  Constructing optimal parlay...\n` +
                 `  4.  Running quantitative validation...\n\n` +
                 `<i>This thorough process may take up to 90 seconds. Please wait...</i>`;


    await safeEditMessage(
      chatId,
      messageId,
      text,
      {
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      }
    );

    try {
      const startTime = Date.now();
      let parlay;

      if (mode === 'web') {
          // --- ADDED: DYNAMIC MODEL SELECTION ---
          // Map the UI choice ('gemini' or 'perplexity') to a specific Google model.
          const GEMINI_MODELS = {
  pro_2_5: "gemini-2.5-pro",
  flash_2_5: "gemini-2.5-flash",
  flash_lite_2_5: "gemini-2.5-flash-lite",
  flash_2_5_preview: "gemini-2.5-flash-lite-preview-09-2025",
  flash_2_0: "gemini-2.0-flash",
  flash_2_0_alt: "gemini-2.0-flash-001",
};

function getGeminiModel(choice) {
  return GEMINI_MODELS[choice] || GEMINI_MODELS.pro_2_5; // fallback
}
          
          const model = genAI.getGenerativeModel({ model: modelName });
          console.log(`Using dynamically selected model: ${modelName} for user choice: ${aiModel}`);

          const userQuery = `Generate a ${numLegs}-leg parlay for ${SPORT_TITLES[sportKey] || sportKey}. ` +
                            `The parlay should focus on ${betType} bets. ` +
                            `Please include player props: ${includeProps ? 'Yes' : 'No'}.`;

          const fullPrompt = buildParlayPrompt(userQuery, state);

          const result = await model.generateContent(fullPrompt);
          const responseText = result.response.text();
          
          const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
          const jsonMatch = responseText.match(jsonBlockRegex);
          if (!jsonMatch || !jsonMatch[1]) {
            throw new Error("AI response did not contain a valid JSON block.");
          }
          const aiResponse = JSON.parse(jsonMatch[1]);

          if (aiResponse.mode !== 'BETS' || !aiResponse.output_json) {
              throw new Error("Parsed JSON from AI has an invalid structure or mode.");
          }
          parlay = aiResponse.output_json;

      } else {
          // Keep original logic for 'live' and 'db' modes
          const options = {
              horizonHours: aiConfig.horizonHours,
              includeProps,
              quantitativeMode,
              proQuantMode: ai.proQuantMode || false
          };
          parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, options);
      }

      const processingTime = Math.round((Date.now() - startTime) / 1000);

      const legs = parlay.legs || parlay.parlay_legs;
      if (!parlay || !legs || legs.length === 0) {
        throw new Error('AI returned an empty or invalid parlay. This can happen if no games are found for the selected sport.');
      }

      console.log(`✅ Parlay generated in ${processingTime}s with ${legs.length} legs`);
      parlay.processing_time = processingTime;

      await sendParlayResult(bot, chatId, parlay, state, mode, messageId);

    } catch (error) {
      console.error('AI handler execution error:', error);

      if (error.fallbackAvailable) {
        await sendFallbackOptions(bot, chatId, messageId, error);
        return;
      }

      const errorMessage = `❌ I encountered a critical error: <code>${escapeHTML(error.message || 'Unknown error')}</code>\n\nPlease try again later, or select a different mode.\n\n💡 Try:\n• Different sport\n• Fewer legs\n• Database mode`;

      await safeEditMessage(
        chatId,
        messageId,
        errorMessage,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'ai_quick_retry' }],
              [{ text: '🎯 Change Sport', callback_data: 'ai_quick_change_sport' }],
              [{ text: '💾 Use Database Mode', callback_data: 'ai_fallback_db' }]
            ]
          }
        }
      );

      await setUserState(chatId, {});
    }
}

// --- Help Command ---
export function registerAIHelp(bot) {
    bot.onText(/^\/ai_help$/, async (msg) => {
      const chatId = msg.chat.id;

      const helpText =
  `🤖 <b>AI Parlay Builder Help</b>

<b>Quick Commands:</b>
• /ai - Full builder
• /ai_nfl - Quick NFL parlay
• /ai_nba - Quick NBA parlay
• /ai_mlb - Quick MLB parlay
• /ai_soccer - Quick Soccer parlay
• /ai_live - Fallback to Live mode
• /ai_db - Fallback to Database mode

<b>Modes:</b>
• 🌐 <b>Web Research</b>: Real-time data (recommended)
• 📡 <b>Live API</b>: Direct API data (requires quota)
• 💾 <b>Database</b>: Stored data (fallback)

<b>Need Help?</b>
• Ensure you have stable internet
• Try fewer legs for faster results
• Use popular sports for better data
• Database mode always works but may be stale

<b>Tips:</b>
• 3-5 legs is optimal for balance
• Player props work best for NBA/NFL
• Web research takes 30-90 seconds`;

      await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
    });
}
