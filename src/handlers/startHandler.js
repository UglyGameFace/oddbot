// src/handlers/startHandler.js - HEDGE FUND GRADE USER ONBOARDING
import { BehavioralAnalyzer } from '../analytics/psychometric.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const InstitutionalStartHandler = {
  command: 'start',
  pattern: /^\/start$/,
  
  async execute(bot, msg, match, services) {
    const chatId = msg.chat.id;
    const { dbService, sentryService } = services;
    
    try {
        // Phase 1: Institutional-grade user profiling
        const user = await dbService.createOrUpdateUser(msg.from);
        sentryService.identifyUser(user);

        // Phase 2: Behavioral finance analysis (with mock data for demonstration)
        const behavioralAnalyzer = new BehavioralAnalyzer();
        const mockBehavioralData = await dbService.getMockUserBehavioralData(user.tg_id);
        const behavioralAnalysis = await behavioralAnalyzer.detectCognitiveBiases(user.tg_id, mockBehavioralData);

        // Phase 3: Personalized institutional onboarding
        await this.institutionalOnboardingFlow(bot, chatId, user, behavioralAnalysis);

    } catch (error) {
        sentryService.captureError(error, { component: 'start_handler' });
        bot.sendMessage(chatId, "An error occurred during onboarding. Please try again later.");
    }
  },

  async institutionalOnboardingFlow(bot, chatId, user, behavioralAnalysis) {
    // Multi-phase institutional onboarding
    await this.phase1_InstitutionalWelcome(bot, chatId, user);
    await delay(1500);
    
    await this.phase2_BehavioralInsights(bot, chatId, behavioralAnalysis);
    await delay(1000);

    await this.phase3_InstitutionalDashboard(bot, chatId);
  },

  async phase1_InstitutionalWelcome(bot, chatId, user) {
    const welcomeMessage = `*Welcome to the Institutional Analytics Platform, ${user.first_name || 'Trader'}.*\n\n` +
      `Your account has been activated. We are now calibrating our quantitative models to your profile.\n\n` +
      `*Platform Features Activated:*\n` +
      `• 📊 Quantitative Portfolio Optimization\n` +
      `• 🎯 Machine Learning Signal Generation\n` +
      `• ⚖️ Risk-Adjusted Parlay Construction\n\n` +
      `_Please wait while we analyze your behavioral markers..._`;
      
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  },

  async phase2_BehavioralInsights(bot, chatId, behavioralAnalysis) {
    let insightsMessage = `*Initial Behavioral Finance Assessment Complete*\n\n`;
    if (behavioralAnalysis.length > 0) {
        insightsMessage += `Our analysis has identified the following potential cognitive biases in your decision-making patterns:\n\n`;
        behavioralAnalysis.forEach(bias => {
            insightsMessage += `*• ${bias.bias.replace(/_/g, ' ')}:* A tendency for *${bias.mitigation.toLowerCase()}*\n`;
        });
        insightsMessage += `\n_Our AI will adjust its recommendations to help mitigate the impact of these biases._`;
    } else {
        insightsMessage += `Our analysis indicates a well-balanced and disciplined decision-making profile. Our models will operate without behavioral adjustments.`;
    }
    
    await bot.sendMessage(chatId, insightsMessage, { parse_mode: 'Markdown' });
  },

  async phase3_InstitutionalDashboard(bot, chatId) {
    const dashboardMessage = `*Your Institutional Dashboard is Ready.*\n\nUse the commands below to access our full suite of analytical tools.`;
    
    await bot.sendMessage(chatId, dashboardMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '🎯 Generate Parlay' }, { text: '📈 Market Scanner' }],
          [{ text: '🧠 AI Analyst' }, { text: '⚙️ Settings' }]
        ],
        resize_keyboard: true
      }
    });
  },
};

export default InstitutionalStartHandler;