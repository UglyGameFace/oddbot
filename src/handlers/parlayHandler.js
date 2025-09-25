// src/handlers/parlayHandler.js - INSTITUTIONAL PORTFOLIO MANAGER
import { PortfolioOptimizer, RiskManager } from '../quantitative/portfolio-theory.js';
import AdvancedOddsModel from '../services/advancedOddsModel.js';

const InstitutionalParlayHandler = {
  command: 'parlay',
  pattern: /^\/parlay(?:\s+(\w+))?$/,
  
  async execute(bot, msg, match, services) {
    const chatId = msg.chat.id;
    const strategy = match[1] || 'balanced';
    
    const loadingMessage = await bot.sendMessage(chatId, '_Initializing quantitative pipeline... Acquiring market data..._', { parse_mode: 'Markdown' });

    try {
        const portfolio = await this.institutionalParlayPipeline(loadingMessage.message_id, chatId, bot, strategy, services);
        const presentation = this.createInstitutionalPresentation(portfolio, strategy);
        
        await bot.editMessageText(presentation.main, {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: this.createInstitutionalControls()
            }
        });
    } catch (error) {
        services.sentryService.captureError(error, { component: 'parlay_handler' });
        await bot.editMessageText(`❌ *Pipeline Failure:*\n_${error.message}_`, {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown',
        });
    }
  },

  async institutionalParlayPipeline(messageId, chatId, bot, strategy, services) {
    // Phase 1: Market data acquisition
    const { oddsService } = services;
    const gamesData = await oddsService.getAllSportsOdds();
    if (!gamesData || gamesData.length < 3) {
        throw new Error('Insufficient market data available for portfolio construction.');
    }
    await bot.editMessageText('_Market data acquired. Generating quantitative signals..._', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    // Phase 2: Quantitative signal generation
    const signals = this.generateQuantitativeSignals(gamesData.slice(0, 10), strategy); // Limit to 10 assets for performance
    if (signals.length < 3) {
        throw new Error('Could not generate sufficient high-quality signals from current market data.');
    }
    await bot.editMessageText('_Signals generated. Optimizing portfolio using Mean-Variance framework..._', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    // Phase 3: Portfolio optimization
    const optimizer = new PortfolioOptimizer({ assets: signals });
    const optimizedPortfolio = optimizer.findOptimalPortfolio();

    // Phase 4: Risk management overlay
    const riskProfile = { maxVolatility: 0.30 }; // Example: 30% max portfolio volatility
    return RiskManager.applyRiskOverlay(optimizedPortfolio, riskProfile);
  },

  generateQuantitativeSignals(games, strategy) {
    return games.map(game => {
      // Use the advanced model to derive expected return and volatility for each potential bet
      const signal = AdvancedOddsModel.generateSignal(game, strategy);
      return {
          id: game.id,
          name: `${game.home_team} vs ${game.away_team}`,
          ...signal, // includes expectedReturn, volatility, correlations, etc.
      };
    });
  },

  createInstitutionalPresentation(portfolio, strategy) {
    let main = `*Institutional Parlay Portfolio Optimized*\n`;
    main += `*Strategy:* ${strategy.charAt(0).toUpperCase() + strategy.slice(1)}\n\n`;
    main += `*Metrics:*\n` +
            `  - Exp. Return: \`${(portfolio.expectedReturn * 100).toFixed(2)}%\`\n` +
            `  - Volatility (Risk): \`${(portfolio.volatility * 100).toFixed(2)}%\`\n` +
            `  - Sharpe Ratio: \`${portfolio.sharpeRatio.toFixed(2)}\`\n\n`;

    main += `*Optimal Allocations (Legs):*\n`;
    portfolio.weights.forEach((weight, i) => {
        if (weight > 0.01) { // Only show significant allocations
            main += `  - \`${(weight * 100).toFixed(1)}%\` allocation to *${portfolio.assets[i].name} (${portfolio.assets[i].selection})*\n`;
        }
    });
    
    if (portfolio.note) main += `\n*Risk Adjustment:* ${portfolio.note}`;

    return { main };
  },

  createInstitutionalControls() {
    return [
      [
        { text: '📊 Portfolio Analytics', callback_data: 'portfolio_analytics' },
        { text: '⚖️ Risk Analysis', callback_data: 'risk_analysis' }
      ],
      [
        { text: '🔄 Re-optimize', callback_data: 'reoptimize_portfolio' },
        { text: '🧠 AI Explanation', callback_data: 'ai_explanation' }
      ]
    ];
  }
};

export default InstitutionalParlayHandler;
