// src/services/elitePromptService.js - QUANTUM PROMPT ENGINE (EV-Driven Update)
// Incorporates strict requirements for EV, Kelly, CLV, Correlation, Injuries.

// Helper to format requirements clearly in prompts
const formatRequirement = (req) => `\n  - ${req}`;

// Define the MINIMAL output contract structure
const LEG_OUTPUT_CONTRACT = `{
          "sportsbook": "e.g., DraftKings",
          "market_type": "e.g., spread | moneyline | total | player_points",
          "line": -3.5, // (number | null, e.g., point for spread/total, null for ML)
          "price": -110, // (number, American odds)
          "region": "us", // (string, e.g., us, eu, uk, au)
          "timestamp": "ISO8601 UTC timestamp of odds",
          "implied_probability": 0.5238, // (number, 0 to 1)
          "model_probability": 0.555, // (number, 0 to 1, calibrated)
          "edge_percent": 3.12, // (number, (model_prob / implied_prob - 1) * 100)
          "ev_per_100": 6.05, // (number, Expected Value per $100 wagered)
          "kelly_fraction_full": 0.065, // (number, Full Kelly fraction)
          "clv_target_price": -115, // (number | null, target price vs close)
          "injury_gates": ["PlayerA (Questionable)", "PlayerB (Out)"], // (string[] | null)
          "market_signals": { // (object | null)
             "reverse_line_movement": "Detected: line moved against public %", // (string | null)
             "public_bet_split_percent": 75, // (number | null)
             "money_split_percent": 40 // (number | null)
          },
          "correlation_notes": "Low correlation with other legs." // (string | null)
       }`;

const PARLAY_OUTPUT_CONTRACT = `{
  "parlay_metadata": {
    "sport": "e.g., NBA Basketball",
    "sport_key": "e.g., basketball_nba",
    "legs_count": 3, // (number)
    "bet_type": "e.g., mixed", // (string)
    "analyst_tier": "e.g., QUANTITATIVE ANALYST", // (string)
    "generated_at": "ISO8601 UTC timestamp",
    "data_sources_used": ["e.g., The Odds API", "Official Injury Report"], // (string[])
    "model_version": "e.g., q-nba-v3.1" // (string | null)
  },
  "legs": [ ${LEG_OUTPUT_CONTRACT} /* Repeat per leg */ ],
  "combined_parlay_metrics": {
      "combined_decimal_odds": 6.83, // (number, product of leg decimal odds)
      "combined_american_odds": "+583", // (string)
      "combined_probability_product": 0.146, // (number, product of model probabilities)
      "parlay_ev_per_100": 35.50, // (number, Overall EV per $100)
      "kelly_stake": { // (object)
          "full_kelly_fraction": 0.058, // (number)
          "half_kelly_fraction": 0.029, // (number)
          "quarter_kelly_fraction": 0.0145, // (number)
          "recommended_fraction": 0.0145, // (number, based on policy/risk)
          "bankroll_allocation_percent": 1.45 // (number, recommended_fraction * 100)
      },
      "correlation_score": -0.05, // (number, estimate range: -1 to +1, negative/low is good)
      "overall_risk_assessment": "MEDIUM", // (string: LOW | MEDIUM | HIGH | REJECTED)
      "rejection_reason": null // (string | null, if rejected)
  },
  "portfolio_construction": { // (object, more concise now)
    "overall_thesis": "Brief +EV justification based on combined metrics.", // (string)
    "key_risk_factors": ["e.g., Injury dependency on PlayerA", "High correlation score", "Low CLV target margin"], // (string[])
    "clv_plan": "Target entry price: +583 or better. Monitor line movement pre-game. Preferred book: DraftKings." // (string)
  }
}`;


export class ElitePromptService {
  // Existing SPORT_CONFIG and ANALYST_TIERS remain the same...
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
     // ... other sports remain the same ...
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
     // Add other sports as needed...
     ['icehockey_nhl', {
      title: 'NHL Hockey',
      edges: ['GOALIE CONFIRMATION', 'LINE MATCHUPS', 'SPECIAL TEAMS', 'TRAVEL SCHEDULE', 'BACK-TO-BACKS'],
      keyMarkets: ['moneyline', 'puck_line', 'total', 'player_shots', 'player_points']
    }],
     ['soccer_england_premier_league', {
      title: 'Premier League',
      edges: ['FORM ANALYSIS', 'HOME/AWAY SPLITS', 'DERBY MATCHES', 'MANAGER TACTICS', 'EUROPEAN HANGOVER'],
      keyMarkets: ['moneyline', 'asian_handicap', 'total', 'both_teams_to_score']
    }],
      ['mma_ufc', {
        title: 'UFC',
        edges: ['FIGHTER STYLES', 'REACH ADVANTAGE', 'CAMP CHANGES', 'WEIGHT CUTS', 'OCTAGON EXPERIENCE'],
        keyMarkets: ['moneyline', 'method_of_victory', 'total_rounds', 'fight_goes_distance']
      }],
       ['tennis_atp', {
        title: 'ATP Tennis',
        edges: ['SURFACE SPECIALISTS', 'H2H HISTORY', 'BREAK POINT EFFICIENCY', 'RECOVERY ABILITY', 'SCHEDULING'],
        keyMarkets: ['moneyline', 'game_spread', 'total_games', 'set_betting']
       }],
  ]);

  static #ANALYST_TIERS = {
    QUANT: {
      title: 'QUANTITATIVE ANALYST',
      fee: 75000,
      focus: 'statistical arbitrage, model edges, and CLV maximization',
      minHitRate: 0.72, // Target for model calibration
      experience: '15+ years quantitative modeling',
      specialties: ['machine learning models', 'market efficiency gaps', 'probability calibration vs closing lines', 'Kelly staking']
    },
    // Keep SHARPS/ELITE if needed for different modes, but focus on QUANT output structure
    SHARPS: {
      title: 'PROFESSIONAL SHARP',
      fee: 35000,
      focus: 'line movement, market inefficiencies, and situational value',
      minHitRate: 0.67,
      experience: '12+ years professional betting',
      specialties: ['line shopping', 'steam moves', 'reverse line movement', 'injury impact analysis']
    },
     ELITE: {
      title: 'ELITE SPORTS ANALYST',
      fee: 15000,
      focus: 'fundamental analysis, matchup edges, and qualitative factors',
      minHitRate: 0.63,
      experience: '10+ years team/player analysis',
      specialties: ['coaching tendencies', 'player motivation', 'intangibles', 'narrative debunking']
    }
  };


  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const config = this.#getSportConfig(sportKey);
    // Force QUANT tier for EV-driven output, but keep focus description dynamic if needed
    const analyst = this.#ANALYST_TIERS.QUANT;
    const currentDate = new Date().toISOString(); // Use full ISO string

    const requirements = [
      `Market Snapshot: For each leg, provide sportsbook, market_type, line (if applicable), price (American), region, and UTC timestamp of the odds used. Use data representative of major US books (e.g., DraftKings, FanDuel).`,
      `Model Probability: Provide your calibrated 'model_probability' (0-1 scale) for each leg, explicitly stating it's calibrated against expected closing lines.`,
      `Implied Probability: Calculate 'implied_probability' (0-1 scale) from the 'price'.`,
      `Edge & EV: Calculate 'edge_percent' = (model_probability / implied_probability - 1) * 100. Calculate 'ev_per_100' = (edge_percent / 100) * 100 * implied_probability / (1 - implied_probability) [Simplified: EV = (ModelProb * DecimalOdds - 1) * 100].`,
      `Kelly Stake: Calculate 'kelly_fraction_full' using f* = (bp - q) / b, where b = decimal odds - 1, p = model_probability, q = 1 - p.`,
      `Correlation Check: Briefly note correlation ('correlation_notes') - e.g., 'Low cross-game', 'Moderate positive same-game (SGP)', 'High negative (opposing outcomes)'. REJECT parlay if high negative correlation exists.`,
      `Market Signals: If available, populate 'market_signals' with 'reverse_line_movement' description, 'public_bet_split_percent', and 'money_split_percent'. Otherwise, set to null.`,
      `Injury Gates: List critical player dependencies in 'injury_gates' (e.g., "LeBron James (Questionable - Ankle)"). Include official status. If none, set to null or empty array.`,
      `CLV Target: Estimate a realistic 'clv_target_price' (American odds) representing the minimum price needed to maintain positive EV against the expected closing line. Can be null if uncertain.`
    ];

    const parlayRequirements = [
        `Combined Odds: Calculate 'combined_decimal_odds' and 'combined_american_odds'.`,
        `Combined Probability: Calculate 'combined_probability_product' (product of leg model_probability). Adjust downwards slightly (e.g., multiply by 0.95-0.98) if significant positive correlation is noted in legs.`,
        `Parlay EV: Calculate 'parlay_ev_per_100' based on combined odds and combined probability.`,
        `Kelly Staking: Provide 'full_kelly_fraction', 'half_kelly_fraction', 'quarter_kelly_fraction' based on parlay EV and odds. Recommend a 'recommended_fraction' (e.g., quarter Kelly) and 'bankroll_allocation_percent'.`,
        `Correlation Score: Estimate an overall 'correlation_score' (-1 to 1).`,
        `Risk Assessment: Assign 'overall_risk_assessment' (LOW, MEDIUM, HIGH, REJECTED). Provide 'rejection_reason' if applicable (e.g., "High negative correlation", "Critical injury unresolved", "Negative EV after calibration").`,
        `Key Risks: List major concerns in 'key_risk_factors'.`,
        `CLV Plan: Briefly state target entry odds and monitoring approach in 'clv_plan'.`
    ];

    return `# ${analyst.title} MODE - EV-DRIVEN PARLAY GENERATION
You are a ${analyst.title} specializing in ${config.title}, focused on ${analyst.focus}. Your goal is long-term profit maximization.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay strictly following the requirements below. Prioritize Expected Value (EV) and sound bankroll management (Kelly Criterion).

## CONTEXTUAL INTELLIGENCE
${this.#buildContextIntelligence(context, currentDate)}
${this.#buildUserContext(context.userConfig)}

## ${config.title.toUpperCase()} QUANTUM EDGES (Informational - Use for idea generation, but base final output on math)
${config.edges.map(edge => `• ${edge}`).join('\n')}

## HARD REQUIREMENTS PER LEG ${requirements.map(formatRequirement).join('')}

## HARD REQUIREMENTS FOR COMBINED PARLAY ${parlayRequirements.map(formatRequirement).join('')}

## KELLY CRITERION FORMULA (Reference)
f* = (bp - q) / b, where b = decimal_odds - 1, p = model_probability, q = 1 - p. Recommend Quarter Kelly (f* / 4).

## PROMPT GUARDRAILS - NON-NEGOTIABLE
${formatRequirement("REJECT or DOWNGRADE parlay if critical injury gates involve 'Questionable' or 'Doubtful' STARTERS for any leg. Wait for official updates.")}
${formatRequirement("REJECT parlay if overall calibrated EV ('parlay_ev_per_100') is negative.")}
${formatRequirement("REJECT parlay if significant negative correlation exists between legs.")}
${formatRequirement("If reverse line movement strongly conflicts with your model's edge for a leg, reduce confidence/probability for that leg OR significantly reduce the recommended Kelly stake for the parlay.")}
${formatRequirement("Only use games from the VERIFIED SCHEDULE provided in context. Reject parlays involving unverified games.")}

## OUTPUT CONTRACT - EXACT JSON STRUCTURE REQUIRED
Return ONLY the following JSON structure. Populate all fields accurately based on your analysis. Ensure all numeric fields are actual numbers, not strings.

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FINAL CHECK**: Ensure every field in the JSON output contract is present and correctly calculated according to the requirements. Focus on data and quantitative metrics over narrative.`;
  }

  static getWebResearchPrompt(sportKey, numLegs, betType, researchContext = {}) {
     // Start with the elite prompt structure
     const basePrompt = this.getEliteParlayPrompt(sportKey, numLegs, betType, researchContext);

     // Add specific web research instructions and validation checks
     return `${basePrompt}

## WEB RESEARCH & VALIDATION PROTOCOL
1. **Act as Aggregator**: Use your web search capabilities to find the latest odds (representative of major US books like DraftKings/FanDuel), injury reports (cross-reference official NBA/team sources if possible), and market trends (public/money splits if available) for games within the VERIFIED SCHEDULE context.
2. **Data Synthesis**: Synthesize this information to populate the required fields in the JSON output contract (market snapshot, model probability estimation based on consensus/projections, injury gates, market signals).
3. **Realistic Estimation**: Estimate 'model_probability' based on synthesized data, projections, and common quantitative factors (e.g., rest, back-to-backs). Aim for realistic calibration, acknowledging web data limitations. Be conservative if data is sparse or conflicting.
4. **Strict Validation**:
    - **Schedule Adherence**: ONLY propose legs for games listed in the 'VERIFIED SCHEDULE' context.
    - **Odds Range**: Ensure 'price' is within a realistic market range (e.g., -500 to +500). If web search finds extreme odds, double-check or discard the leg.
    - **Player/Team Validity**: Use only real, currently active players and teams relevant to the sport key.
    - **Injury Accuracy**: Cross-reference injury statuses if possible. Accurately reflect statuses found (e.g., Questionable, Out) in 'injury_gates'.
5. **Timestamping**: Provide accurate UTC timestamps for when odds/data were observed during your search.

**ZERO TOLERANCE**: Do not invent games, players, odds, or injury statuses. If reliable data cannot be found for a required field (e.g., market signals), populate it with 'null'. If critical information (like odds or key player status) is missing for a potential leg, EXCLUDE that leg and find an alternative or reduce the number of legs in the parlay.`;
    }

  static getFallbackPrompt(sportKey, numLegs, betType, fallbackContext = {}) {
    const config = this.#getSportConfig(sportKey);
    const currentDate = new Date().toISOString();
    // Use ELITE or SHARPS tier for fallback as pure QUANT might struggle without data
    const analyst = this.#ANALYST_TIERS.ELITE;

    // Simplified requirements for fallback
    const fallbackRequirements = [
      `Market Snapshot: Estimate realistic 'price' (American odds) based on typical matchup strength (e.g., favorite -150, underdog +130). Set sportsbook to "Estimated Market". Timestamp can be current time.`,
      `Model Probability: Estimate 'model_probability' based on general team strength, home advantage, and common situational factors (e.g., 0.55 for slight favorite). Be conservative.`,
      `Implied Probability: Calculate from estimated 'price'.`,
      `Edge & EV: Calculate based on estimated probabilities and price.`,
      `Kelly Stake: Calculate based on estimated EV/probabilities. Recommend VERY SMALL stakes (e.g., 0.10 Kelly or fixed small %).`,
      `Correlation Check: Basic check for obvious negative correlations.`,
      `Injury Gates: Assume key players are HEALTHY unless major long-term injuries are widely known (e.g., season-ending). Note this assumption.`,
      `Market Signals/CLV: Set these fields to 'null' or provide generic notes like "Not available in fallback mode".`
    ];
     const fallbackParlayRequirements = [
        // Keep combined odds, probability, EV calcs
        `Combined Odds/Probability/EV: Calculate as usual based on estimated leg values.`,
        `Kelly Staking: Recommend very small fractions (e.g., 0.10 Kelly or less).`,
        `Correlation Score: Estimate based on leg markets (e.g., 0 if cross-game).`,
        `Risk Assessment: Default to MEDIUM or HIGH due to lack of real-time data.`,
        `Key Risks: Must include "Lack of real-time odds", "Assumed player availability".`
    ];


    return `# FALLBACK MODE - FUNDAMENTAL ANALYSIS (${analyst.title})
Operating without reliable real-time odds/injury data. Using fundamental analysis, historical patterns, general team strength, and standard situational factors.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay using ESTIMATED data based on fundamental principles. Adhere to the output structure as closely as possible, noting estimations.

## CONTEXT & ASSUMPTIONS
${this.#buildContextIntelligence(fallbackContext, currentDate)}
${formatRequirement("Assume standard home advantage.")}
${formatRequirement("Assume key players are AVAILABLE unless widely known long-term injuries exist.")}
${formatRequirement("Estimate odds based on perceived team strength differences.")}

## ${config.title.toUpperCase()} FUNDAMENTAL EDGES (Apply conceptually)
${config.edges.map(edge => `• ${edge}`).join('\n')}

## FALLBACK REQUIREMENTS PER LEG ${fallbackRequirements.map(formatRequirement).join('')}

## FALLBACK REQUIREMENTS FOR COMBINED PARLAY ${fallbackParlayRequirements.map(formatRequirement).join('')}

## KELLY CRITERION FORMULA (Reference)
f* = (bp - q) / b. Recommend VERY SMALL fraction (e.g., 0.10 Kelly or fixed 0.25%-0.5% bankroll).

## GUARDRAILS
${formatRequirement("Clearly state that odds and probabilities are ESTIMATED in rationales.")}
${formatRequirement("Set risk assessment to MEDIUM or HIGH.")}
${formatRequirement("Recommend significantly reduced stakes.")}
${formatRequirement("Do NOT use games from VERIFIED SCHEDULE if provided; assume typical matchups.")}


## OUTPUT CONTRACT - EXACT JSON STRUCTURE REQUIRED (Use estimates/nulls where needed)
Return ONLY the following JSON structure. Clearly mark estimated fields or provide notes.

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FALLBACK INTEGRITY**: Focus on logical matchups and standard betting principles. Acknowledge data limitations explicitly in the output.`;
  }

  // --- Helper methods remain the same ---
   static #buildContextIntelligence(context, date) {
        const intelligence = [
            '## CONTEXTUAL INTELLIGENCE & ENVIRONMENT',
            `• Analysis Timestamp: ${date}`,
            `• Market Conditions: ${context?.marketConditions || 'Assume standard liquidity'}`,
            `• Season Phase: ${context?.seasonPhase || 'Assume mid-season dynamics'}`
        ];

        // Include VERIFIED SCHEDULE if available for Web Research mode
        if (context?.scheduleInfo) {
            intelligence.push(context.scheduleInfo); // Contains the "VERIFIED SCHEDULE" block
        }
         // Include INJURY DATA if available
         if (context?.injuryReport) {
             intelligence.push(`• KEY INJURY REPORT: ${context.injuryReport}`);
         } else {
             intelligence.push('• KEY INJURY REPORT: Injury data not provided; list critical player assumptions in injury_gates.')
         }


        // Add other context pieces if provided
        // if (context.lineMovement) intelligence.push(`• Market Movement: ${context.lineMovement}`);
        // if (context.weatherConditions) intelligence.push(`• Weather Impact: ${context.weatherConditions}`);

        return intelligence.join('\n');
    }

    static #buildUserContext(userConfig) {
        if (!userConfig) return '## USER CONTEXT\n• No specific user preferences provided.';

        const context = ['## USER CONTEXT & PREFERENCES'];
        // Map user settings to prompt constraints if applicable
        if (userConfig.risk_tolerance) {
          context.push(`• User Risk Profile: ${userConfig.risk_tolerance.toUpperCase()} (Adjust Kelly fraction recommendation accordingly, e.g., lower for risk-averse).`);
        }
        if (userConfig.favorite_teams?.length) {
          context.push(`• User Team Preferences: ${userConfig.favorite_teams.join(', ')} (Avoid explicit bias but can be used for tie-breaking if EV is identical).`);
        }
        // if (userConfig.bankroll_size) context.push(`• Bankroll Size: ${userConfig.bankroll_size}`); // AI doesn't need exact size, just adjusts fraction
        if (userConfig.proQuantMode === true) { // Explicitly check for true
          context.push('• User Mode: PRO QUANT ACTIVATED (Prioritize statistical edge, minimize narrative influence, stricter EV threshold).');
        }
        if (userConfig.avoid_players?.length) {
          context.push(`• User Excluded Players: ${userConfig.avoid_players.join(', ')} (Do not include these players in any prop bets).`);
        }
         if (userConfig.bookmakers?.length) {
          context.push(`• User Preferred Books: ${userConfig.bookmakers.join(', ')} (Use odds representative of these books if possible).`);
        }


        return context.join('\n');
    }

  static #selectAnalystTier(context) {
    // Default to QUANT for EV-driven approach, but could adjust based on context if needed
    if (context?.userConfig?.proQuantMode) return this.#ANALYST_TIERS.QUANT;
    // Could add logic here for SHARPS or ELITE if specific modes were re-introduced
    return this.#ANALYST_TIERS.QUANT; // Defaulting to QUANT
  }

  static #calculateTargetEV(analyst) {
    // EV target might be less relevant now as the prompt demands positive EV calculation directly
    // Keep for potential internal use or context
    const evMap = {
      'QUANTITATIVE ANALYST': 0.05, // Minimum 5% EV target for QUANT
      'PROFESSIONAL SHARP': 0.03,
      'ELITE SPORTS ANALYST': 0.02
    };
     // Return as decimal (e.g., 0.05 for 5%)
    return evMap[analyst.title] || 0.03;
  }

   static #getSportConfig(sportKey) {
     const defaultConfig = {
        title: String(sportKey).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        edges: ['General situational analysis', 'Market inefficiencies', 'Basic matchup analysis'],
        keyMarkets: ['moneyline', 'spread', 'total']
    };
    return this.#SPORT_CONFIG.get(sportKey) || defaultConfig;
  }
} // End ElitePromptService Class

export default ElitePromptService;

