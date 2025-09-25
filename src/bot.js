// src/bot.js - PRODUCTION-READY BOT WITH HTTP HEALTH ENDPOINTS INCLUDED
import TelegramBot from 'node-telegram-bot-api';
import env from './config/env.js';
import DatabaseService from './services/databaseService.js';
import AIService from './services/aiService.js';
import OddsService from './services/oddsService.js';
import * as Sentry from '@sentry/node';
import express from 'express';

// Initialize Sentry for production monitoring
if (env.SENTRY_DSN && !env.SENTRY_DSN.includes('your_sentry_dsn')) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.OnUncaughtException(),
      new Sentry.Integrations.OnUnhandledRejection(),
    ],
    tracesSampleRate: 1.0,
  });
}

// Health endpoints for Railway/Nixpacks deployment
const app = express();
app.get('/health', (_req, res) => res.status(200).json({ status: 'healthy' }));
app.get('/health/liveness', (_req, res) => res.status(200).json({ status: 'alive' }));
app.get('/health/readiness', (_req, res) => res.status(200).json({ status: 'ready' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Health endpoints live at :${PORT}/health`);
});

class UltimateParlayBot {
  constructor() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { 
      polling: true,
      request: {
        timeout: 30000,
        agentOptions: {
          keepAlive: true,
          maxSockets: 50
        }
      }
    });
    this.userSessions = new Map();
    this.setupBot();
  }

  setupBot() {
    console.log('🏈⚽🏀⚾🎾🥊 Starting Ultimate AI Parlay Bot - All Sports Supported');
    this.setupErrorHandling();
    this.setupCommandHandlers();
    this.setupMessageHandlers();
    console.log('✅ Bot initialized with all sports support');
  }

  setupErrorHandling() {
    this.bot.on('error', (error) => {
      console.error('Telegram Bot Error:', error);
      Sentry.captureException(error);
    });
    this.bot.on('polling_error', (error) => {
      console.error('Polling Error:', error);
      Sentry.captureException(error);
    });
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      Sentry.captureException(error);
    });
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      Sentry.captureException(reason);
    });
  }

  setupCommandHandlers() {
    this.bot.onText(/\/start/, async (msg) => { await this.handleStartCommand(msg); });
    this.bot.onText(/\/parlay(?:\s+(\w+))?/, async (msg, match) => {
      const strategy = match[1] || 'balanced';
      await this.handleParlayCommand(msg, strategy);
    });
    this.bot.onText(/\/nfl/, async (msg) => { await this.handleSportSpecificCommand(msg, 'americanfootball_nfl'); });
    this.bot.onText(/\/nba/, async (msg) => { await this.handleSportSpecificCommand(msg, 'basketball_nba'); });
    this.bot.onText(/\/mlb/, async (msg) => { await this.handleSportSpecificCommand(msg, 'baseball_mlb'); });
    this.bot.onText(/\/soccer/, async (msg) => { await this.handleSportSpecificCommand(msg, 'soccer_epl'); });
    this.bot.onText(/\/help/, async (msg) => { await this.handleHelpCommand(msg); });
    this.bot.onText(/\/stats/, async (msg) => { await this.handleStatsCommand(msg); });
    console.log('✅ All command handlers registered');
  }

  setupMessageHandlers() {
    // Handle button interactions
    this.bot.on('callback_query', async (query) => {
      await this.handleCallbackQuery(query);
    });

    // Handle text messages for quick actions
    this.bot.on('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        await this.handleQuickAction(msg);
      }
    });
  }

  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    try {
      await DatabaseService.createOrUpdateUser(msg.from);
      const welcomeMessage = this.generateSportsWelcomeMessage();
      await this.bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: '🎯 Generate AI Parlay' }, { text: '⚡ Quick NFL Picks' }],
            [{ text: '🏀 NBA Picks' }, { text: '⚾ MLB Picks' }],
            [{ text: '⚽ Soccer Picks' }, { text: '🎾 Tennis Picks' }],
            [{ text: '📊 My Stats' }, { text: 'ℹ️ Help' }]
          ],
          resize_keyboard: true
        }
      });
    } catch (error) {
      await this.sendErrorMessage(chatId, error);
    }
  }

  generateSportsWelcomeMessage() {
    return `🎯 *Ultimate AI Parlay Bot - All Sports Coverage* 🏈⚽🏀⚾🎾🥊

*Supported Sports:*
• 🏈 NFL & College Football
• 🏀 NBA & College Basketball  
• ⚾ MLB Baseball
• 🏒 NHL Hockey
• ⚽ Soccer (EPL, La Liga, Serie A, Bundesliga)
• 🎾 Tennis (ATP Tour)
• 🥊 UFC & Boxing
• ⛳ PGA Golf

*AI-Powered Features:*
• Smart parlay generation across all sports
• Real-time odds from multiple providers
• Risk-adjusted betting strategies
• Personalized recommendations

*Get Started:*
Use /parlay for AI-generated picks across all sports, or select a specific sport above!`;
  }

  async handleParlayCommand(msg, strategy) {
    const chatId = msg.chat.id;
    await this.bot.sendChatAction(chatId, 'typing');
    const loadingMessage = await this.bot.sendMessage(chatId, 
      '🤖 *AI is analyzing games across all sports...*\n\n_Scanning NFL, NBA, MLB, Soccer, Tennis, UFC and more..._', 
      { parse_mode: 'Markdown' }
    );
    try {
      const gamesData = await OddsService.getAllSportsOdds();
      if (!gamesData || gamesData.length === 0) {
        throw new Error('No games available across supported sports');
      }
      const user = await DatabaseService.getUserByTelegramId(msg.from.id);
      const userContext = await this.getUserContext(user);
      const analysis = await AIService.generateParlayAnalysis(userContext, gamesData, strategy);
      const parlayMessage = this.formatParlayMessage(analysis, strategy);

      await this.bot.editMessageText(parlayMessage, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: this.generateParlayActions(analysis)
        }
      });
    } catch (error) {
      await this.bot.editMessageText(
        `❌ *Unable to generate parlay at this time*\n\nError: ${error.message}\n\nPlease try again in a few minutes.`,
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        }
      );
      Sentry.captureException(error);
    }
  }

  async handleSportSpecificCommand(msg, sportKey) {
    const chatId = msg.chat.id;
    await this.bot.sendChatAction(chatId, 'typing');
    const sportName = this.getSportDisplayName(sportKey);
    const loadingMessage = await this.bot.sendMessage(chatId, 
      `🤖 *Analyzing ${sportName} games...*\n\n_Searching for the best opportunities..._`, 
      { parse_mode: 'Markdown' }
    );
    try {
      const gamesData = await OddsService.getSportOdds(sportKey);
      if (!gamesData || gamesData.length === 0) {
        throw new Error(`No ${sportName} games available at this time`);
      }
      const user = await DatabaseService.getUserByTelegramId(msg.from.id);
      const userContext = await this.getUserContext(user);
      const analysis = await AIService.generateParlayAnalysis(userContext, gamesData, 'balanced');
      const message = this.formatSportSpecificMessage(analysis, sportName);
      await this.bot.editMessageText(message, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await this.bot.editMessageText(
        `❌ *Unable to analyze ${sportName} games*\n\n${error.message}`,
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        }
      );
      Sentry.captureException(error);
    }
  }

  async handleHelpCommand(msg) {
    const chatId = msg.chat.id;
    const helpMessage = `ℹ️ *Ultimate AI Parlay Bot - Complete Guide* 📚

*Supported Commands:*
• /start - Initialize the bot
• /parlay [strategy] - AI parlay (balanced/mathematical/highprobability/lottery)
• /nfl - NFL-specific analysis
• /nba - NBA-specific analysis  
• /mlb - MLB-specific analysis
• /soccer - Soccer analysis
• /stats - Your betting statistics
• /help - This help message

*Quick Actions:*
Use the menu buttons for quick access to popular sports and features.

*Sports Coverage:*
🏈 NFL, NCAA Football
🏀 NBA, NCAA Basketball
⚾ MLB Baseball
🏒 NHL Hockey
⚽ Soccer (EPL, La Liga, Serie A, Bundesliga)
🎾 Tennis
🥊 UFC, Boxing
⛳ Golf

*AI Strategies:*
• ⚖️ Balanced - Mix of value and safety
• 📊 Mathematical - Pure statistics and probabilities  
• 🛡️ High Probability - Safer, lower odds
• 🎰 Lottery - High-risk, high-reward

_All analysis is provided for entertainment purposes. Please bet responsibly._`;

    await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  }

  async handleStatsCommand(msg) {
    const chatId = msg.chat.id;
    try {
      const user = await DatabaseService.getUserByTelegramId(msg.from.id);
      const stats = await DatabaseService.getUserBettingStats(msg.from.id);
      const statsMessage = this.formatStatsMessage(user, stats);
      await this.bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.sendErrorMessage(chatId, error);
    }
  }

  // ---------- Formatting and Utility Methods ----------
  formatParlayMessage(analysis, strategy) {
    let message = `🎯 *AI-Generated Parlay* 🤖\n`;
    message += `*Strategy:* ${strategy.charAt(0).toUpperCase() + strategy.slice(1)}\n\n`;
    analysis.parlay.legs.forEach((leg, index) => {
      message += `*${index + 1}. ${leg.sport.toUpperCase()}: ${leg.teams}*\n`;
      message += `   📊 *Pick:* ${leg.selection}\n`;
      message += `   🎯 *Odds:* ${leg.odds > 0 ? '+' : ''}${leg.odds} | *Confidence:* ${leg.confidence}%\n`;
      message += `   💡 *Reasoning:* ${leg.reasoning}\n\n`;
    });
    message += `*Parlay Summary:*\n`;
    message += `• *Total Odds:* ${analysis.parlay.total_odds > 0 ? '+' : ''}${analysis.parlay.total_odds}\n`;
    message += `• *Expected Value:* ${analysis.parlay.expected_value}%\n`;
    message += `• *Risk Assessment:* ${analysis.parlay.risk_assessment}\n`;
    message += `• *Sports Coverage:* ${analysis.parlay.sport_diversification}\n\n`;
    message += `*AI Analysis:*\n`;
    message += `• *Strengths:* ${analysis.analysis.strengths.join(', ')}\n`;
    message += `• *Recommendation:* ${analysis.analysis.recommendation.toUpperCase()}\n\n`;
    message += `_Generated: ${new Date().toLocaleString()}_`;
    return message;
  }

  formatSportSpecificMessage(analysis, sportName) {
    return `🎯 *${sportName} AI Analysis* 🤖\n\n${this.formatParlayMessage(analysis, 'sport-specific')}`;
  }

  formatStatsMessage(user, stats) {
    return `📊 *Your Betting Statistics* 👤\n\n` +
      `*User:* ${user.first_name || 'Sports Fan'}\n` +
      `*Total Bets:* ${stats.totalBets || 0}\n` +
      `*Win Rate:* ${stats.winRate ? stats.winRate.toFixed(1) : 0}%\n` +
      `*Profit/Loss:* $${stats.profitLoss ? stats.profitLoss.toFixed(2) : '0.00'}\n` +
      `*ROI:* ${stats.roi ? stats.roi.toFixed(1) : 0}%\n\n` +
      `_Tracking since: ${new Date(user.created_at).toLocaleDateString()}_`;
  }

  generateParlayActions(analysis) {
    return [
      [
        { text: '🔄 Generate New', callback_data: 'parlay_new' },
        { text: '🎯 Different Strategy', callback_data: 'parlay_strategy' }
      ],
      [
        { text: '📊 Detailed Analysis', callback_data: 'parlay_analysis' },
        { text: '💾 Save Parlay', callback_data: 'parlay_save' }
      ]
    ];
  }

  async getUserContext(user) {
    const stats = await DatabaseService.getUserBettingStats(user.tg_id);
    return {
      totalBets: stats?.totalBets || 0,
      winRate: stats?.winRate || 0,
      riskTolerance: user.settings?.preferences?.risk_tolerance || 'medium',
      preferredSports: user.settings?.preferences?.sports || ['nfl', 'nba', 'mlb']
    };
  }

  getSportDisplayName(sportKey) {
    const names = {
      'americanfootball_nfl': 'NFL Football',
      'basketball_nba': 'NBA Basketball',
      'baseball_mlb': 'MLB Baseball',
      'soccer_epl': 'English Premier League'
    };
    return names[sportKey] || sportKey;
  }

  async sendErrorMessage(chatId, error) {
    await this.bot.sendMessage(chatId, 
      '❌ *An error occurred*\n\nPlease try again in a few moments.', 
      { parse_mode: 'Markdown' }
    );
    Sentry.captureException(error);
  }

  async handleCallbackQuery(query) {
    await this.bot.answerCallbackQuery(query.id);
    // You can implement specific callback logic here for deep actions
  }

  async handleQuickAction(msg) {
    const text = msg.text.toLowerCase();
    if (text.includes('parlay')) {
      await this.handleParlayCommand(msg, 'balanced');
    } else if (text.includes('nfl')) {
      await this.handleSportSpecificCommand(msg, 'americanfootball_nfl');
    } else if (text.includes('nba')) {
      await this.handleSportSpecificCommand(msg, 'basketball_nba');
    } else if (text.includes('mlb')) {
      await this.handleSportSpecificCommand(msg, 'baseball_mlb');
    } else if (text.includes('soccer')) {
      await this.handleSportSpecificCommand(msg, 'soccer_epl');
    } else if (text.includes('stats')) {
      await this.handleStatsCommand(msg);
    } else if (text.includes('help')) {
      await this.handleHelpCommand(msg);
    }
  }
}

try {
  const bot = new UltimateParlayBot();
  console.log('✅ Ultimate AI Parlay Bot successfully started!');
  console.log('🏈⚽🏀⚾🎾🥊 All sports supported and ready');
  console.log('🔗 Bot is live and accepting commands');
} catch (error) {
  console.error('❌ Critical error starting bot:', error);
  Sentry.captureException(error);
  process.exit(1);
}

export default UltimateParlayBot;
