// src/services/elitePromptService.js - QUANTUM PROMPT ENGINE (Restored & Enhanced)
export class ElitePromptService {
  static #SPORT_CONFIG = new Map([
    ['basketball_nba', {
      title: 'NBA Basketball',
      edges: [
        'BACK-TO-BACKS: Teams on 2nd night of B2B are 12% less likely to cover',
        'REST ADVANTAGE: 3+ days rest vs 1 day rest = 8% performance boost',
        'OFFENSIVE SCHEMES: Target mismatches in pace (fast vs slow teams)',
        'PLAYER PROP EDGES: Minutes projections, usage rates, defensive matchups',
        'REVENGE NARRATIVES: Players/teams facing former teams show 7% performance increase'
      ],
      keyMarkets: ['moneyline', 'spread', 'total', 'player_points', 'player_rebounds', 'player_assists']
    }],
    ['americanfootball_nfl', {
      title: 'NFL Football',
      edges: [
        'DIVISIONAL DOGS: Division underdogs cover 55% of the time',
        'REST DISPARITY: Bye week advantages, Thursday night letdowns',
        'WEATHER EDGES: Wind > 15mph favors unders and running games',
        'COACHING TRENDS: Specific coach tendencies in situational football',
        'INJURY IMPACT: QB injuries cause 12-point swing, WR injuries cause 4-point swing'
      ],
      keyMarkets: ['moneyline', 'spread', 'total', 'player_touchdowns', 'player_receiving_yards', 'player_passing_yards']
    }],
    ['baseball_mlb', {
      title: 'MLB Baseball',
      edges: [
        'PITCHING MISMATCHES: #1-2 starters vs #4-5 starters = 65% win rate',
        'BULLPEN USAGE: High-leverage reliever availability impacts late innings',
        'BALLPARK FACTORS: Coors Field increases scoring by 2.5 runs on average',
        'WEATHER: Wind direction and humidity significantly affect pitching',
        'LINEUP CONSTRUCTION: Key hitter absences drop run production by 18%'
      ],
      keyMarkets: ['moneyline', 'runline', 'total', 'player_hits', 'player_strikeouts', 'first_5_innings']
    }],
    ['icehockey_nhl', {
      title: 'NHL Hockey',
      edges: [
        'GOALIE CONFIRMATION: Starter vs backup performance splits are critical',
        'LINE MATCHUPS: Home ice last change provides 8% scoring chance advantage',
        'SPECIAL TEAMS: Power play efficiency differences create 15% edge opportunities',
        'TRAVEL SCHEDULE: 3+ time zone changes = 15% performance drop',
        'BACK-TO-BACKS: Goalies on 2nd of B2B see save percentage drop by 4%'
      ],
      keyMarkets: ['moneyline', 'puck_line', 'total', 'player_shots', 'player_points', 'team_total']
    }],
    ['soccer_england_premier_league', {
      title: 'English Premier League',
      edges: [
        'FORM ANALYSIS: Teams winning 4 of last 5 have 60% win probability in next match',
        'HOME/AWAY SPLITS: Top-tier teams win >70% of home matches',
        'DERBY MATCHES: Increased intensity leads to 25% more cards and 15% fewer goals',
        'MANAGER TACTICS: Defensive vs attacking style matchups create value opportunities',
        'EUROPEAN HANGOVER: Teams playing midweek European matches drop 12% weekend performance'
      ],
      keyMarkets: ['moneyline', 'asian_handicap', 'total', 'both_teams_to_score', 'double_chance']
    }],
    ['soccer_uefa_champions_league', {
      title: 'UEFA Champions League',
      edges: [
        'TRAVEL FATIGUE: Long mid-week travel impacts domestic league performance',
        'MOTIVATION FACTORS: Knockout stage intensity vs group stage experimentation',
        'EXPERIENCE EDGE: Teams with deep tournament experience perform better under pressure',
        'TACTICAL APPROACH: Away goals rule (where applicable) influences manager decisions',
        'SQUAD ROTATION: Top teams rotate 4-6 players between domestic and European matches'
      ],
      keyMarkets: ['moneyline', 'draw_no_bet', 'total', 'both_teams_to_score', 'correct_score']
    }],
    ['mma_ufc', {
      title: 'UFC Mixed Martial Arts',
      edges: [
        'FIGHTER STYLES: Striker vs grappler matchups create 22% performance predictability',
        'REACH ADVANTAGE: 4+ inch reach advantage increases striking success by 18%',
        'CAMP CHANGES: Training camp disruptions decrease performance by 15% on average',
        'WEIGHT CUTS: Fighters missing weight win 35% less often despite physical advantage',
        'OCTAGON EXPERIENCE: Debut fighters lose 60% of time against experienced opponents'
      ],
      keyMarkets: ['moneyline', 'method_of_victory', 'total_rounds', 'fight_goes_distance']
    }],
    ['tennis_atp', {
      title: 'ATP Tennis',
      edges: [
        'SURFACE SPECIALISTS: Player performance varies 40%+ between clay, grass, hard courts',
        'HEAD-TO-HEAD HISTORY: Previous matchups on same surface are 75% predictive',
        'BREAK POINT EFFICIENCY: Top 10 players convert 45% vs 35% for lower ranks',
        'RECOVERY ABILITY: Players coming back from injury show 20% performance drop initially',
        'TOURNAMENT SCHEDULING: Players in 3rd tournament in 4 weeks show 12% fatigue effect'
      ],
      keyMarkets: ['moneyline', 'game_spread', 'total_games', 'set_betting']
    }],
    ['golf_pga', {
      title: 'PGA Tour Golf',
      edges: [
        'COURSE HISTORY: Players with top-10 finishes in previous years have 28% better chance',
        'RECENT FORM: Players with top-20 in last two starts outperform by 15%',
        'SPECIALIZATION: Course type specialists (links, parkland, desert) show consistent edges',
        'WEATHER ADAPTATION: Wind specialists gain 2-3 stroke advantage in tough conditions',
        'MAJOR PRESSURE: Players with major championship experience handle pressure better'
      ],
      keyMarkets: ['outright_winner', 'top_5_finish', 'top_10_finish', 'head_to_head', 'make_cut']
    }],
    ['formula1', {
      title: 'Formula 1',
      edges: [
        'QUALIFYING PERFORMANCE: 75% of races won from top-3 grid positions',
        'TRACK CHARACTERISTICS: Teams with strong car traits for specific tracks dominate',
        'WEATHER STRATEGY: Teams with superior wet-weather setups gain 15+ second advantages',
        'PIT STOP EFFICIENCY: Top teams average 2.2s stops vs 3.5s for midfield',
        'POWER UNIT ADVANTAGE: Straight-line speed differences create overtaking opportunities'
      ],
      keyMarkets: ['race_winner', 'podium_finish', 'top_6_finish', 'head_to_head', 'fastest_lap']
    }]
  ]);

  static #ANALYST_TIERS = {
    QUANT: {
      title: 'QUANTITATIVE ANALYST',
      fee: 75000,
      focus: 'statistical arbitrage and model edges',
      minHitRate: 0.72,
      experience: '15+ years quantitative modeling',
      specialties: ['machine learning models', 'market efficiency gaps', 'probability calibration']
    },
    SHARPS: {
      title: 'PROFESSIONAL SHARP', 
      fee: 35000,
      focus: 'line movement and market inefficiencies',
      minHitRate: 0.67,
      experience: '12+ years professional betting',
      specialties: ['line shopping', 'steam moves', 'reverse line movement']
    },
    ELITE: {
      title: 'ELITE SPORTS ANALYST',
      fee: 15000,
      focus: 'fundamental analysis and situational edges',
      minHitRate: 0.63,
      experience: '10+ years team/player analysis',
      specialties: ['coaching tendencies', 'player motivation', 'situational factors']
    }
  };

  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const config = this.#getSportConfig(sportKey);
    const analyst = this.#selectAnalystTier(context);
    const currentDate = new Date().toISOString().split('T')[0];
    
    return `# ${analyst.title} MODE - QUANTUM SPORTS ANALYSIS
You are the world's premier ${config.title} analyst with ${analyst.experience} and $${analyst.fee.toLocaleString()}+ per winning ticket.

## QUANTUM MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay with STRICT ${analyst.focus.toUpperCase()}

## ANALYTICAL FRAMEWORK - ${analyst.minHitRate * 100}% MINIMUM HIT RATE REQUIRED
${this.#buildAnalyticalFramework(analyst, context)}

## ${config.title.toUpperCase()} QUANTUM EDGES
${config.edges.map(edge => `• ${edge}`).join('\n')}

${this.#buildMarketConstraints(betType, config.keyMarkets)}

## OUTPUT ARCHITECTURE - ABSOLUTELY NON-NEGOTIABLE
CRITICAL: The \`american\` odds field inside the \`odds\` object for each leg MUST be a valid number (e.g., -110, +120). The \`commence_time\` field MUST be a valid ISO 8601 string.
\`\`\`json
{
  "parlay_metadata": {
    "sport": "${config.title}",
    "sport_key": "${sportKey}",
    "legs_count": ${numLegs},
    "bet_type": "${betType}",
    "target_ev": ${this.#calculateTargetEV(analyst)},
    "analyst_tier": "${analyst.title}",
    "minimum_confidence": ${analyst.minHitRate},
    "generated_at": "${currentDate}",
    "quantum_version": "2.0"
  },
  "legs": [
    {
      "event": "Team A @ Team B",
      "commence_time": "2025-10-15T20:00:00Z",
      "market": "${config.keyMarkets[0]}",
      "selection": "exact_selection_identifier",
      "odds": {
        "american": -110,
        "decimal": 1.91,
        "implied_probability": 0.524
      },
      "quantum_analysis": {
        "confidence_score": 85,
        "key_factors": ["statistical_edge", "situational_advantage", "market_inefficiency"],
        "analytical_basis": "2-3 sentence quantitative rationale with specific percentages and historical data",
        "model_advantage": 0.12,
        "risk_assessment": "low|medium|high",
        "sharp_money_alignment": true
      }
    }
  ],
  "portfolio_construction": {
    "overall_thesis": "Comprehensive +EV justification explaining parlay construction logic",
    "correlation_analysis": "Explanation of leg independence and risk diversification",
    "risk_factors": ["market_volatility", "injury_concerns", "weather_considerations"],
    "bankroll_allocation": "0.5-2% of total bankroll",
    "hedge_recommendations": ["live_hedging_options", "correlated_plays"],
    "exit_strategy": "When to consider cashing out or hedging"
  }
}
\`\`\`

## CONTEXTUAL INTELLIGENCE
${this.#buildContextIntelligence(context, currentDate)}
${this.#buildUserContext(context.userConfig)}

**QUANTUM VERIFICATION**: Each leg must pass ${analyst.minHitRate * 100}% confidence threshold with clear analytical edge. No compromises.`;
  }

  static #buildAnalyticalFramework(analyst, context) {
    const baseFramework = [
      'EDGE VERIFICATION: Clear statistical or situational advantage required for every selection',
      'LINE ARBITRAGE: Identify mispriced markets 5-10 cents off true probability',
      'CORRELATION MATRIX: Ensure leg independence and avoid negative correlation',
      'BANKROLL OPTIMIZATION: Apply Kelly Criterion or fractional bankroll allocation',
      'MARKET TIMING: Consider line movement patterns and sharp money indicators'
    ];

    if (analyst.title === 'QUANTITATIVE ANALYST') {
      baseFramework.push('MODEL CONVERGENCE: Multiple statistical models must show agreement on edge');
      baseFramework.push('VALUE SPOTTING: Identify where market sentiment diverges from statistical reality');
      baseFramework.push('PROBABILITY CALIBRATION: Ensure implied probabilities align with historical outcomes');
    }

    if (analyst.title === 'PROFESSIONAL SHARP') {
      baseFramework.push('LINE MOVEMENT ANALYSIS: Track steam moves and reverse line movement patterns');
      baseFramework.push('BOOKMAKER LIMITS: Identify where sharp money is concentrated');
      baseFramework.push('MARKET MAKER ANALYSIS: Understand different bookmaker pricing models');
    }

    if (context.userConfig?.proQuantMode) {
      baseFramework.push('PRO QUANT MODE: Statistical edge prioritization over narrative-based analysis');
    }

    return baseFramework.map(item => `• ${item}`).join('\n');
  }

  static #buildMarketConstraints(betType, availableMarkets) {
    return `## MARKET CONSTRAINTS & PARAMETERS
• Primary Bet Type: ${betType.toUpperCase()}
• Available Markets: ${availableMarkets.join(', ')}
• Minimum Leg Probability: 58% implied (increased for elite standards)
• Maximum Same Team Exposure: 1 leg per parlay
• Odds Range: -180 to +180 (avoid heavy favorites and extreme longshots)
• Edge Requirement: Minimum 5% expected value per selection`;
  }

  static #buildUserContext(userConfig) {
    if (!userConfig) return '';

    const context = ['## USER CONTEXT & PREFERENCES'];
    
    if (userConfig.risk_tolerance) {
      context.push(`• Risk Profile: ${userConfig.risk_tolerance.toUpperCase()}`);
    }
    if (userConfig.favorite_teams?.length) {
      context.push(`• Team Preferences: ${userConfig.favorite_teams.join(', ')}`);
    }
    if (userConfig.bankroll_size) {
      context.push(`• Bankroll Size: ${userConfig.bankroll_size}`);
    }
    if (userConfig.proQuantMode) {
      context.push('• PRO QUANT MODE: Statistical edge prioritization activated');
      context.push('• CALIBRATED EV: Focus on expected value over public narratives');
    }
    if (userConfig.avoid_players?.length) {
      context.push(`• Excluded Players: ${userConfig.avoid_players.join(', ')}`);
    }

    return context.join('\n');
  }

  static #buildContextIntelligence(context, date) {
    const intelligence = [
      '## CONTEXTUAL INTELLIGENCE & ENVIRONMENT',
      `• Analysis Date: ${date}`,
      `• Market Conditions: ${context.marketConditions || 'Standard liquidity and limits'}`,
      `• Season Phase: ${context.seasonPhase || 'Regular season dynamics'}`
    ];

    if (context.gameContext) {
        intelligence.push(`• FOCUS GAME: ${context.gameContext.away_team} @ ${context.gameContext.home_team} on ${new Date(context.gameContext.commence_time).toDateString()}`);
    }
    if (context.scheduleInfo) {
      intelligence.push(`• Game Universe: ${context.scheduleInfo}`);
    }
    if (context.lineMovement) {
      intelligence.push(`• Market Movement: ${context.lineMovement}`);
    }
    if (context.injuryReport) {
      intelligence.push(`• Key Injuries: ${context.injuryReport}`);
    }
    if (context.weatherConditions) {
      intelligence.push(`• Weather Impact: ${context.weatherConditions}`);
    }

    return intelligence.join('\n');
  }

  static #selectAnalystTier(context) {
    if (context.userConfig?.proQuantMode) return this.#ANALYST_TIERS.QUANT;
    if (context.userConfig?.risk_tolerance === 'high') return this.#ANALYST_TIERS.SHARPS;
    if (context.requiresFundamentalAnalysis) return this.#ANALYST_TIERS.ELITE;
    return this.#ANALYST_TIERS.QUANT; // Default to highest tier
  }

  static #calculateTargetEV(analyst) {
    const evMap = {
      'QUANTITATIVE ANALYST': 0.22,
      'PROFESSIONAL SHARP': 0.17, 
      'ELITE SPORTS ANALYST': 0.13
    };
    return evMap[analyst.title];
  }

  static #getSportConfig(sportKey) {
    return this.#SPORT_CONFIG.get(sportKey) || {
      title: sportKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      edges: [
        'SITUATIONAL ANALYSIS: Team/player motivation and scheduling factors',
        'MARKET INEFFICIENCIES: Public betting percentages vs sharp money movement',
        'COACHING/PLAYER EDGES: Tactical advantages and individual matchup superiority',
        'HISTORICAL TRENDS: Head-to-head performance and venue-specific patterns'
      ],
      keyMarkets: ['moneyline', 'spread', 'total']
    };
  }

  static getWebResearchPrompt(sportKey, numLegs, betType, researchContext = {}) {
    const basePrompt = this.getEliteParlayPrompt(sportKey, numLegs, betType, researchContext);
    
    return `${basePrompt}

## META-AGGREGATOR WEB RESEARCH PROTOCOL (NON-NEGOTIABLE)
1.  **ACT AS AGGREGATOR**: Your primary task is to search and synthesize information from multiple reputable online sports sources (e.g., ESPN, DraftKings, FanDuel, official league sites) to find the BEST available odds and justifications for your picks.
2.  **MANDATORY SCHEDULE ADHERENCE**: You MUST ONLY build legs for the game(s) listed in the 'VERIFIED SCHEDULE' or 'FOCUS GAME' section. This is a strict, non-negotiable rule.
3.  **ZERO HALLUCINATION POLICY**: Do not invent, create, or assume any games, players, or stats. If the provided schedule is empty or you cannot find sufficient data for the requested game, you MUST state that a valid parlay cannot be formed and return an empty "legs" array.
4.  **DATA INTEGRITY**: The \`event\` and \`commence_time\` fields in your response MUST EXACTLY MATCH the data from the verified schedule.
5.  **REAL ODDS**: The \`american\` odds field MUST be a real, verifiable number that you have found through your simulated web search.

## FAILURE CONDITIONS (If any of these occur, you have failed the task)
-   Generating a leg for a game NOT listed in the provided context.
-   Inventing a game or stats when the schedule is empty or data is unavailable.
-   Failing to return exactly ${numLegs} legs if enough markets exist for the selected game.
-   Returning a JSON structure that does not match the schema.

**FINAL COMMAND**: Your primary function is to build the most statistically sound, +EV parlay possible using real, aggregated data for the SPECIFIED GAME(S). Failure to comply will result in task termination.`;
  }

  static getFallbackPrompt(sportKey, numLegs, betType, fallbackContext = {}) {
    const config = this.#getSportConfig(sportKey);
    const currentDate = new Date().toISOString().split('T')[0];
    
    return `# QUANTUM FALLBACK MODE - FUNDAMENTAL ANALYSIS
Operating without real-time data. Using fundamental analysis, historical patterns, and established team hierarchies.

## FALLBACK ANALYTICAL FRAMEWORK
• **TEAM QUALITY METRICS**: Roster talent evaluation, coaching pedigree, historical performance trends.
• **MARKET EFFICIENCY**: Apply typical odds distributions based on matchup quality and public perception.
• **SITUATIONAL LOGIC**: Standard scheduling patterns, rest advantages, and motivational factors.
• **RISK MANAGEMENT**: Conservative bankroll allocation (0.5-1.5%) due to information limitations.
• **VALUE IDENTIFICATION**: Focus on clear mismatches and established performance trends.

## ${config.title.toUpperCase()} FUNDAMENTALS
${config.edges.map(edge => `• ${edge}`).join('\n')}

## FALLBACK CONSTRUCTION RULES
- Use well-established teams/players with proven track records and consistency.
- Focus on moneyline and spread markets (most reliable without real-time data).
- Apply standard odds ranges: -180 to +180 for realistic market construction.
- Maximum 2 legs from same conference/division to maintain diversification.
- Prioritize starters over backups, established players over rookies.
- Consider typical home field/court advantages for the sport.

## OUTPUT REQUIREMENTS - MAINTAIN QUANTUM STANDARDS
CRITICAL: The \`american\` odds and \`commence_time\` fields are REQUIRED for every leg.
\`\`\`json
{
  "parlay_metadata": {
    "sport": "${config.title}",
    "legs_count": ${numLegs},
    "bet_type": "${betType}",
    "analysis_mode": "FALLBACK_FUNDAMENTAL",
    "data_limitations": "No real-time data available",
    "generated_at": "${currentDate}"
  },
  "legs": [
    {
      "event": "Team A @ Team B",
      "commence_time": "2025-10-15T20:00:00Z",
      "market": "${config.keyMarkets[0]}",
      "selection": "exact_selection_identifier",
      "odds": {
        "american": -110,
        "decimal": 1.91,
        "implied_probability": 0.524
      },
      "fundamental_analysis": {
        "confidence_score": 75,
        "key_factors": ["team_quality", "historical_performance", "situational_context"],
        "rationale": "2-3 sentence fundamental analysis based on established knowledge",
        "risk_level": "medium"
      }
    }
  ],
  "portfolio_notes": {
    "thesis": "Fundamental analysis approach explaining value identification",
    "risk_disclosures": ["Limited real-time data", "Based on historical patterns"],
    "bankroll_recommendation": "0.5-1.5% of total bankroll"
  }
}
\`\`\`

**FALLBACK INTEGRITY**: Every pick must withstand professional scrutiny. Ask: "Would I confidently bet $25,000 on this selection given available information?"`;
  }
}

export default ElitePromptService;
