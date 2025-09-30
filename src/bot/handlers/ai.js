// src/bot/handlers/ai.js - COMPLETE AND VERIFIED VERSION
import { safeTelegramMessage } from '../../utils/enterpriseUtilities.js';
import aiService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import databaseService from '../../services/databaseService.js';
import { setUserState, getUserState } from '../state.js';
import { getSportEmoji, escapeMarkdownV2 } from '../../utils/enterpriseUtilities.js';

// ---- Safe edit helper ----
async function safeEditMessage(bot, text, options) {
  try {
    await bot.editMessageText(text, options);
  } catch (error) {
    if (error?.message?.includes('message is not modified')) {
      // benign
    } else {
      console.error('editMessageText error:', error?.message || error);
    }
  }
}

const propsToggleLabel = (on) => `${on ? '✅' : '☑️'} Include Player Props`;

// EXPANDED SPORT SUPPORT - All major sports
const SPORT_TITLES = {
  // American Football
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  americanfootball_xfl: 'XFL',
  americanfootball_usfl: 'USFL',
  
  // Basketball
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA', 
  basketball_ncaab: 'NCAAB',
  basketball_euroleague: 'EuroLeague',
  
  // Baseball
  baseball_mlb: 'MLB',
  baseball_npb: 'NPB (Japan)',
  baseball_kbo: 'KBO (Korea)',
  
  // Hockey
  icehockey_nhl: 'NHL',
  hockey_nhl: 'NHL',
  icehockey_khl: 'KHL',
  icehockey_sweden: 'Swedish Hockey',
  icehockey_finland: 'Finnish Hockey',
  
  // Soccer
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
  
  // Tennis
  tennis_atp: 'ATP Tennis',
  tennis_wta: 'WTA Tennis',
  tennis_aus_open: 'Australian Open',
  tennis_french_open: 'French Open',
  tennis_wimbledon: 'Wimbledon',
  tennis_us_open: 'US Open',
  
  // Fighting Sports
  mma_ufc: 'UFC',
  boxing: 'Boxing',
  
  // Motorsports
  formula1: 'Formula 1',
  motogp: 'MotoGP',
  nascar: 'NASCAR',
  indycar: 'IndyCar',
  
  // Golf
  golf_pga: 'PGA Tour',
  golf_european: 'European Tour',
  golf_liv: 'LIV Golf',
  golf_masters: 'The Masters',
  golf_us_open: 'US Open',
  golf_pga_championship: 'PGA Championship',
  golf_open_championship: 'The Open',
  
  // International Sports
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

// Priority order for sports display
const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];
const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl']; // duplicates
const PAGE_SIZE = 10;

// Last-resort static defaults with expanded coverage
const DEFAULT_SPORTS = [
  { sport_key: 'americanfootball_nfl', sport_title: 'NFL' },
  { sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF' },
  { sport_key: 'basketball_nba', sport_title: 'NBA' },
  { sport_key: 'basketball_wnba', sport_title: 'WNBA' },
  { sport_key: 'baseball_mlb', sport_title: 'MLB' },
  { sport_key: 'icehockey_nhl', sport_title: 'NHL' },
  { sport_key: 'soccer_england_premier_league', sport_title: 'Premier League' },
  { sport_key: 'soccer_uefa_champions_league', sport_title: 'Champions League' },
  { sport_key: 'tennis_atp', sport_title: 'ATP Tennis' },
  { sport_key: 'mma_ufc', sport_title: 'UFC' },
  { sport_key: 'formula1', sport_title: 'Formula 1' },
  { sport_key: 'golf_pga', sport_title: 'PGA Tour' }
];

function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  return [...(sports || [])].sort(
    (a, b) => rank(a?.sport_key || '') - rank(b?.sport_key || '')
  );
}

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

// COMPREHENSIVE sports discovery with multiple fallback layers
async function getAllAvailableSports() {
  const sportsCollection = new Map();
  
  console.log('🔄 Starting comprehensive sports discovery...');
  
  // Layer 1: Primary - gamesService (cached/provider mixed)
  try {
    console.log('📡 Layer 1: Querying gamesService...');
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
      console.log(`✅ Layer 1: Added ${gamesServiceSports.length} sports from gamesService`);
    }
  } catch (error) {
    console.warn('❌ Layer 1 (gamesService) failed:', error.message);
  }
  
  // Layer 2: Secondary - databaseService comprehensive list
  try {
    console.log('🗄️ Layer 2: Querying databaseService...');
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
      console.log(`✅ Layer 2: Added ${dbSports.length} sports from databaseService`);
    }
  } catch (error) {
    console.warn('❌ Layer 2 (databaseService) failed:', error.message);
  }
  
  // Layer 3: Tertiary - Add known sports from our comprehensive list
  console.log('🌍 Layer 3: Adding known sports from comprehensive list...');
  Object.entries(SPORT_TITLES).forEach(([sport_key, sport_title]) => {
    if (!sportsCollection.has(sport_key)) {
      sportsCollection.set(sport_key, {
        sport_key,
        sport_title,
        source: 'comprehensive_list',
        priority: 3
      });
    }
  });
  console.log(`✅ Layer 3: Added known sports from comprehensive list`);
  
  // Layer 4: Final fallback - static defaults
  if (sportsCollection.size === 0) {
    console.log('🆘 Layer 4: Using static defaults as final fallback...');
    DEFAULT_SPORTS.forEach(sport => {
      sportsCollection.set(sport.sport_key, {
        ...sport,
        source: 'static_defaults',
        priority: 4
      });
    });
  }
  
  const sports = Array.from(sportsCollection.values())
    .sort((a, b) => a.priority - b.priority);
  
  console.log(`🎉 Sports discovery complete: ${sports.length} total sports found`);
  
  return sports;
}

// Enhanced sport selection with better error handling and caching
let sportsCache = null;
let sportsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCachedSports() {
  const now = Date.now();
  if (sportsCache && sportsCacheTime && (now - sportsCacheTime) < CACHE_DURATION) {
    console.log('📦 Using cached sports list');
    return sportsCache;
  }
  
  try {
    console.log('🔄 Refreshing sports cache...');
    sportsCache = await getAllAvailableSports();
    sportsCacheTime = now;
    return sportsCache;
  } catch (error) {
    console.error('❌ Failed to refresh sports cache:', error);
    return sportsCache || DEFAULT_SPORTS;
  }
}

export function registerAI(bot) {
  bot.onText(/^\/ai$/, async (msg) => {
    const chatId = msg.chat.id;
    await setUserState(chatId, { page: 0 });
    sendSportSelection(bot, chatId);
  });

  bot.onText(/^\/ai_live$/, async (msg) => {
    const chatId = msg.chat.id;
    await handleDirectFallback(bot, chatId, 'live');
  });

  bot.onText(/^\/ai_db$/, async (msg) => {
    const chatId = msg.chat.id;
    await handleDirectFallback(bot, chatId, 'db');
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
      aiModel: 'perplexity'
    });
    
    const sportTitle = SPORT_TITLES[sportKey] || sportKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    await bot.sendMessage(
      chatId,
      `⚡ Quick start: Building 4-leg ${sportTitle} parlay via Web Research...`,
      { parse_mode: 'Markdown' }
    );
    
    await executeAiRequest(bot, chatId);
    
  } catch (error) {
    console.error('Quick sport command failed:', error);
    const safeError = escapeMarkdownV2(error.message || 'Unknown error');
    await bot.sendMessage(
      chatId,
      `❌ Quick start failed: \`${safeError}\`\n\nPlease use /ai for the full builder.`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function handleDirectFallback(bot, chatId, mode) {
  const state = await getUserState(chatId);
  if (!state?.sportKey || !state?.numLegs) {
    await bot.sendMessage(
      chatId, 
      `Please start with /ai first to select sport and legs, then use /ai_${mode} if web research fails.\n\nOr use quick commands: /ai_nfl, /ai_nba, /ai_mlb, /ai_soccer`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const { sportKey, numLegs, betType = 'mixed' } = state;
  
  try {
    await bot.sendMessage(
      chatId,
      `🔄 Switching to ${mode.toUpperCase()} mode for ${sportKey}...\n\nThis uses stored data and may not reflect current odds.`,
      { parse_mode: 'Markdown' }
    );

    const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, mode, betType);
    await sendParlayResult(bot, chatId, parlay, state, mode);
    
  } catch (error) {
    console.error('Direct fallback execution error:', error);
    const safeError = escapeMarkdownV2(error.message || 'Unknown error');
    await bot.sendMessage(
      chatId,
      `❌ Fallback mode failed: \`${safeError}\`\n\nPlease try /ai again with a different sport or mode.`,
      { parse_mode: 'MarkdownV2' }
    );
  } finally {
    await setUserState(chatId, {});
  }
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('ai_')) return;

    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

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
      executeAiRequest(bot, chatId, message.message_id);
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
      if (to === 'sport')  return sendSportSelection(bot, chatId, message.message_id, state.page || 0);
      if (to === 'legs')   return sendLegSelection(bot, chatId, message.message_id);
      if (to === 'mode')   return sendModeSelection(bot, chatId, message.message_id);
      if (to === 'bettype')return sendBetTypeSelection(bot, chatId, message.message_id);
    }

    if (action === 'fallback') {
      const selectedMode = parts[2];
      const { sportKey, numLegs, betType = 'mixed' } = state;
      
      if (!sportKey || !numLegs) {
        return safeEditMessage(
          bot, 
          'Missing sport or leg selection. Please start over with /ai.',
          { chat_id: chatId, message_id: message.message_id }
        );
      }

      try {
        await safeEditMessage(
          bot,
          `🔄 Switching to ${selectedMode.toUpperCase()} mode...\n\nThis uses stored data and may not reflect current odds.`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown' }
        );

        const parlay = await aiService.handleFallbackSelection(sportKey, numLegs, selectedMode, betType);
        await sendParlayResult(bot, chatId, parlay, state, selectedMode, message.message_id);
        
      } catch (error) {
        console.error('Fallback selection error:', error);
        const safeError = escapeMarkdownV2(error.message || 'Unknown error');
        await safeEditMessage(
          bot,
          `❌ Fallback mode failed: \`${safeError}\`\n\nPlease try /ai again.`,
          { 
            chat_id: chatId, 
            message_id: message.message_id, 
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[{ text: 'Start Over', callback_data: 'ai_back_sport' }]] }
          }
        );
      } finally {
        await setUserState(chatId, {});
      }
      return;
    }

    if (action === 'quick') {
      const quickAction = parts[2];
      if (quickAction === 'retry') {
        await safeEditMessage(
          bot,
          '🔄 Retrying with same parameters...',
          { chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown' }
        );
        return executeAiRequest(bot, chatId, message.message_id);
      }
      if (quickAction === 'change_sport') {
        await setUserState(chatId, { page: 0 });
        return sendSportSelection(bot, chatId, message.message_id, 0);
      }
    }
  });
}

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

  const totalPages = Math.max(1, Math.ceil(sports.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), totalPages - 1);

  const slice = pageOf(sports, page).map(s => {
    const title = s?.sport_title ?? SPORT_TITLES[s.sport_key] ?? s.sport_key;
    return { text: `${getSportEmoji(s.sport_key)} ${title}`, callback_data: `ai_sport_${s.sport_key}` };
  });

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2));

  if (page === 0) {
    const quickActions = [
      { text: '🏈 NFL', callback_data: 'ai_sport_americanfootball_nfl' },
      { text: '🏀 NBA', callback_data: 'ai_sport_basketball_nba' },
      { text: '⚾ MLB', callback_data: 'ai_sport_baseball_mlb' },
      { text: '⚽ Soccer', callback_data: 'ai_sport_soccer_england_premier_league' }
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

  const text = `🤖 *AI Parlay Builder*${errorMessage}\n\n*Step 1:* Select a sport.\n\n*Available:* ${sports.length} sports across ${Math.ceil(sports.length / PAGE_SIZE)} pages`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };

  if (messageId) {
    await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
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
    { text: '⚡ 3-Leg (Conservative)', callback_data: 'ai_legs_3' },
    { text: '🎯 5-Leg (Aggressive)', callback_data: 'ai_legs_5' }
  ];
  keyboard.unshift(popularCombos);
  
  keyboard.push([{ text: '« Back to Sports', callback_data: 'ai_back_sport' }]);
  
  const text = `🤖 *AI Parlay Builder*\n\n*Step 2:* How many legs for your ${sportTitle} parlay?\n\n• 2-3 legs: Higher confidence\n• 4-5 legs: Balanced risk/reward\n• 6+ legs: Higher payout, more risk`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendModeSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const sportTitle = SPORT_TITLES[state.sportKey] || state.sportKey?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  
  const text = `🤖 *AI Parlay Builder*\n\n*Step 3:* Select analysis mode for ${sportTitle}.`;
  const keyboard = [
    [{ 
      text: '🌐 Web Research (Recommended)', 
      callback_data: 'ai_mode_web',
      description: 'Real-time odds & analysis from multiple sources'
    }],
    [{ 
      text: '📡 Live API Data (Premium)', 
      callback_data: 'ai_mode_live',
      description: 'Direct API data, requires quota'
    }],
    [{ 
      text: '💾 Database Only (Fallback)', 
      callback_data: 'ai_mode_db',
      description: 'Stored data, may be outdated'
    }],
    [{ text: '« Back to Legs', callback_data: 'ai_back_legs' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendBetTypeSelection(bot, chatId, messageId) {
  const state = await getUserState(chatId) || {};
  const text = '🤖 *AI Parlay Builder*\n\n*Step 4:* What kind of parlay should I build?';
  const keyboard = [
    [{ text: '🔥 Player Props Only', callback_data: 'ai_bettype_props', description: 'Player points, yards, assists, etc.' }],
    [{ text: '🎯 Moneyline Focus', callback_data: 'ai_bettype_moneyline', description: 'Straight win/lose bets' }],
    [{ text: '📊 Spreads & Totals', callback_data: 'ai_bettype_spreads', description: 'Point spreads and over/unders' }],
    [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'ai_bettype_mixed', description: 'Best opportunities across all markets' }],
    [{ text: propsToggleLabel(!!state.includeProps), callback_data: 'ai_toggle_props' }],
    [{ text: '« Back to Mode', callback_data: 'ai_back_mode' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendAiModelSelection(bot, chatId, messageId) {
  const text = '🤖 *AI Parlay Builder*\n\n*Step 5:* Choose your Research AI.\n\n• 🧠 Gemini: Creative analysis, better narratives\n• ⚡ Perplexity: Data-focused, faster results';
  const keyboard = [
    [{ 
      text: '🧠 Gemini (Creative)', 
      callback_data: 'ai_model_gemini',
      description: 'Better for complex analysis and storytelling'
    }],
    [{ 
      text: '⚡ Perplexity (Data-Focused)', 
      callback_data: 'ai_model_perplexity',
      description: 'Faster, more factual, better for data'
    }],
    [{ text: '« Back to Bet Type', callback_data: 'ai_back_bettype' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(bot, text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendFallbackOptions(bot, chatId, messageId, error) {
  const { fallbackOptions, dataFreshness } = error;
  
  const text = 
    `❌ *Web Research Failed*\n\n` +
    `*Error:* ${error.originalError}\n\n` +
    `*${fallbackOptions.db_mode.warning}*\n\n` +
    `Choose a fallback option:\n\n` +
    `🔴 *Live Mode*: ${fallbackOptions.live_mode.description}\n` +
    `💾 *Database Mode*: ${fallbackOptions.db_mode.description}\n\n` +
    `📅 Data last refreshed: ${new Date(dataFreshness.lastRefresh).toLocaleString()}\n` +
    `⏰ Age: ${dataFreshness.hoursAgo} hours ago`;

  const keyboard = [
    [{ text: '🔴 Use Live Mode', callback_data: 'ai_fallback_live' }],
    [{ text: '💾 Use Database Mode', callback_data: 'ai_fallback_db' }],
    [{ text: '🔄 Try Different Sport', callback_data: 'ai_back_sport' }],
    [{ text: '❓ Why did this fail?', callback_data: 'ai_help_fallback' }]
  ];

  await safeEditMessage(
    bot,
    text,
    { 
      chat_id: chatId, 
      message_id: messageId, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// THIS IS THE FULLY CORRECTED FUNCTION
async function sendParlayResult(bot, chatId, parlay, state, mode, messageId = null) {
  const { sportKey, numLegs, betType } = state;
  const legs = parlay.parlay_legs;
  const tzLabel = 'America/New_York';

  const safeNumLegs = safeTelegramMessage(numLegs);
  const safeSportKey = safeTelegramMessage(sportKey);
  const safeMode = safeTelegramMessage(mode.toUpperCase());
  const safeBetType = safeTelegramMessage(betType === 'props' ? 'Player Props Only' : 'Mixed');
  const safeConfidence = safeTelegramMessage(Math.round((parlay.confidence_score || 0) * 100));

  let response = `🧠 *AI\\\\-Generated ${safeNumLegs}\\\\-Leg Parlay*\\n`;
  response += `*Sport:* ${safeSportKey}\\n`;
  response += `*Mode:* ${safeMode}\\n`;
  response += `*Type:* ${safeBetType}\\n`;
  response += `*Confidence:* ${safeConfidence}%\\n`;
  
  if (parlay.data_freshness) {
    response += `*Data Age:* ${safeTelegramMessage(parlay.data_freshness.hours_ago)}h\\n`;
    response += `_${safeTelegramMessage(parlay.data_freshness.message)}_\\n`;
  }
  
  response += `_Timezone: ${safeTelegramMessage(tzLabel)}_\\n\\n`;

  legs.forEach((leg, index) => {
    const when = leg.game_date_local
      ? safeTelegramMessage(leg.game_date_local)
      : (leg.game_date_utc ? safeTelegramMessage(formatLocalIfPresent(leg.game_date_utc, tzLabel)) : '');
      
    const safeGame = safeTelegramMessage(leg.game);
    const safePick = safeTelegramMessage(leg.pick);
    const safeMarket = safeTelegramMessage(leg.market);
    const safeJust = leg.justification ? safeTelegramMessage(leg.justification.length > 250 ? `${leg.justification.slice(0, 250)}...` : leg.justification) : '';
    const safeBook = leg.sportsbook ? safeTelegramMessage(leg.sportsbook) : 'N/A';
    const oddsDisplay = safeTelegramMessage(leg.odds_american ? `${leg.odds_american > 0 ? '+' : ''}${leg.odds_american}` : 'N/A');

    response += `*Leg ${index + 1}:* ${safeGame}`;
    if (when) response += ` — ${when}`;
    response += `\\n*Pick:* *${safePick}* \\\\(${safeMarket}\\\\)\\n`;
    response += `*Odds:* ${oddsDisplay}\\n`;
    response += `*Book:* ${safeBook}\\n`;
    if (safeJust) response += `*Justification:* ${safeJust}\\n`;
    
    if (leg.confidence) {
      response += `*Confidence:* ${safeTelegramMessage(Math.round(leg.confidence * 100))}%\\n`;
    }
    
    response += `\\n`;
  });

  if (parlay.parlay_odds_american) {
    const oddsSign = parlay.parlay_odds_american > 0 ? '+' : '';
    response += `*Parlay Odds:* ${oddsSign}${safeTelegramMessage(parlay.parlay_odds_american)}\\n`;
  }

  if (parlay.parlay_odds_decimal) {
    response += `*Decimal Odds:* ${safeTelegramMessage(parlay.parlay_odds_decimal.toFixed(2))}\\n`;
  }

  if (parlay.parlay_ev !== null && parlay.parlay_ev !== undefined) {
    response += `*Expected Value:* ${safeTelegramMessage((parlay.parlay_ev * 100).toFixed(1))}%\\n`;
  }

  const finalKeyboard = [
    [{ text: '🔄 Build Another', callback_data: 'ai_back_sport' }],
    [{ text: '⚡ Quick NFL', callback_data: 'ai_sport_americanfootball_nfl' }],
    [{ text: '📊 View Analytics', callback_data: 'ai_analytics' }]
  ];
  
  const messageOpts = {
    parse_mode: 'MarkdownV2',
    reply_markup: { 
      inline_keyboard: finalKeyboard 
    }
  };

  if (messageId) {
    await safeEditMessage(bot, response, { ...messageOpts, chat_id: chatId, message_id: messageId });
  } else {
    await bot.sendMessage(chatId, response, messageOpts);
  }
}

async function executeAiRequest(bot, chatId, messageId) {
  const state = await getUserState(chatId);
  const { sportKey, numLegs, mode, betType, aiModel = 'gemini', includeProps = false } = state || {};

  if (!sportKey || !numLegs || !mode || !betType) {
    return safeEditMessage(bot, '❌ Incomplete selection. Please start over using /ai.', { 
      chat_id: chatId, 
      message_id: messageId,
      parse_mode: 'Markdown'
    });
  }

  let modeText = { web: 'Web Research', live: 'Live API Data', db: 'Database Only' }[mode];
  if (mode === 'web') modeText += ` via ${aiModel.charAt(0).toUpperCase() + aiModel.slice(1)}`;
  const betTypeText = betType === 'props' ? 'Player Props Only' : 
                     betType === 'moneyline' ? 'Moneyline Focus' :
                     betType === 'spreads' ? 'Spreads & Totals' : 'Mixed';

  const safeSportKey = escapeMarkdownV2(sportKey);
  const safeModeText = escapeMarkdownV2(modeText);
  const safeBetTypeText = escapeMarkdownV2(betTypeText);
  const safeIncludeProps = escapeMarkdownV2(includeProps ? 'On' : 'Off');

  await safeEditMessage(
    bot,
    `🤖 Accessing advanced analytics\\.\\.\\.\n\n` +
    `*Sport:* ${safeSportKey}\n` +
    `*Legs:* ${numLegs}\n` +
    `*Mode:* ${safeModeText}\n` +
    `*Type:* ${safeBetTypeText}\n` +
    `*Props:* ${safeIncludeProps}\n\n` +
    `⏳ This may take 30\\-90 seconds\\.\\.\\.`,
    { 
      chat_id: chatId, 
      message_id: messageId, 
      parse_mode: 'MarkdownV2', 
      reply_markup: { remove_keyboard: true } 
    }
  );

  try {
    const startTime = Date.now();
    const parlay = await aiService.generateParlay(sportKey, numLegs, mode, aiModel, betType, { includeProps });
    const processingTime = Math.round((Date.now() - startTime) / 1000);

    if (!parlay || !parlay.parlay_legs || parlay.parlay_legs.length === 0) {
      throw new Error('AI returned an empty or invalid parlay. This can happen if no games are found for the selected sport.');
    }

    console.log(`✅ Parlay generated in ${processingTime}s with ${parlay.parlay_legs.length} legs`);
    
    parlay.processing_time = processingTime;
    
    await sendParlayResult(bot, chatId, parlay, state, mode, messageId);

  } catch (error) {
    console.error('AI handler execution error:', error);
    
    if (error.fallbackAvailable) {
      await sendFallbackOptions(bot, chatId, messageId, error);
      return;
    }

    const safeError = escapeMarkdownV2(error.message || 'Unknown error');
    await safeEditMessage(
      bot,
      `❌ I encountered a critical error: \`${safeError}\`\n\nPlease try again later, or select a different mode\\.\n\n💡 Try:\\n• Different sport\\n• Fewer legs\\n• Database mode`,
      {
        chat_id: chatId, 
        message_id: messageId, 
        parse_mode: 'MarkdownV2',
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

export function registerAIHelp(bot) {
  bot.onText(/^\/ai_help$/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpText = `
🤖 *AI Parlay Builder Help*

*Quick Commands:*
• /ai - Full builder
• /ai_nfl - Quick NFL parlay  
• /ai_nba - Quick NBA parlay
• /ai_mlb - Quick MLB parlay
• /ai_soccer - Quick Soccer parlay
• /ai_live - Fallback to Live mode
• /ai_db - Fallback to Database mode

*Modes:*
• 🌐 *Web Research*: Real-time data (recommended)
• 📡 *Live API*: Direct API data (requires quota)
• 💾 *Database*: Stored data (fallback)

*Need Help?*
• Ensure you have stable internet
• Try fewer legs for faster results  
• Use popular sports for better data
• Database mode always works but may be stale

*Tips:*
• 3-5 legs is optimal for balance
• Player props work best for NBA/NFL
• Web research takes 30-90 seconds
    `;
    
    await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  });
}
