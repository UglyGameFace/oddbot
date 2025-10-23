// src/services/elitePromptService.js - QUANTUM PROMPT ENGINE (EV-Driven Update - Complete File)
import { sentryService } from './sentryService.js';
// Assuming ProbabilityCalculator is accessible or defined elsewhere if needed here
// import { ProbabilityCalculator } from './quantitativeService.js'; // Example import

// Helper to format requirements clearly in prompts
const formatRequirement = (req) => `\n  - ${req}`;

// Define the MINIMAL output contract structure
// *** FIX: Added explicit instruction about positive odds format ***
const LEG_OUTPUT_CONTRACT = `{
          "event": "e.g., Boston Celtics @ New York Knicks", // (string, MUST EXACTLY MATCH a game from VERIFIED SCHEDULE context)
          "sportsbook": "e.g., DraftKings",
          "market_type": "e.g., spread | moneyline | total | player_points",
          "line": -3.5, // (number | null)
          "price": 105, // (number, American odds - CRITICAL: DO NOT include '+' sign for positive odds, e.g., use 105, not +105)
          "region": "us", // (string)
          "timestamp": "ISO8601 UTC timestamp of odds",
          "implied_probability": 0.4878, // (number, 0 to 1)
          "model_probability": 0.510, // (number, 0 to 1, calibrated)
          "edge_percent": 4.55, // (number)
          "ev_per_100": 4.78, // (number)
          "kelly_fraction_full": 0.045, // (number)
          "clv_target_price": 100, // (number | null)
          "injury_gates": ["PlayerA (Questionable)"], // (string[] | null)
          "market_signals": { // (object | null)
             "reverse_line_movement": null, // (string | null)
             "public_bet_split_percent": 60, // (number | null)
             "money_split_percent": 70 // (number | null)
          },
          "correlation_notes": "Low correlation.", // (string | null),
          "selection": "e.g., Boston Celtics -3.5" // (string, the actual bet)
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
      "combined_decimal_odds": 6.83, // (number)
      "combined_american_odds": "+583", // (string)
      "combined_probability_product": 0.146, // (number)
      "parlay_ev_per_100": 35.50, // (number)
      "kelly_stake": { // (object)
          "full_kelly_fraction": 0.058, // (number)
          "half_kelly_fraction": 0.029, // (number)
          "quarter_kelly_fraction": 0.0145, // (number)
          "recommended_fraction": 0.0145, // (number)
          "bankroll_allocation_percent": 1.45 // (number)
      },
      "correlation_score": -0.05, // (number, -1 to +1)
      "overall_risk_assessment": "MEDIUM", // (string: LOW | MEDIUM | HIGH | REJECTED)
      "rejection_reason": null // (string | null)
  },
  "portfolio_construction": { // (object)
    "overall_thesis": "Brief +EV justification based on combined metrics.", // (string)
    "key_risk_factors": ["e.g., Injury dependency", "Correlation", "Low CLV margin"], // (string[])
    "clv_plan": "Target entry price: +583 or better. Monitor lines." // (string)
  }
}`;


export class ElitePromptService {
  // Static properties (#SPORT_CONFIG, #ANALYST_TIERS) remain as previously defined...
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
      minHitRate: 0.72,
      experience: '15+ years quantitative modeling',
      specialties: ['ML models', 'market efficiency', 'probability calibration', 'Kelly staking']
    },
    SHARPS: { // Keep for potential future modes
      title: 'PROFESSIONAL SHARP',
      fee: 35000,
      focus: 'line movement, market inefficiencies, situational value',
      minHitRate: 0.67,
      experience: '12+ years pro betting',
      specialties: ['line shopping', 'steam moves', 'RLM', 'injury impact']
    },
     ELITE: { // Keep for potential future modes
      title: 'ELITE SPORTS ANALYST',
      fee: 15000,
      focus: 'fundamental analysis, matchup edges, qualitative factors',
      minHitRate: 0.63,
      experience: '10+ years team/player analysis',
      specialties: ['coaching', 'motivation', 'intangibles', 'narrative debunking']
    }
  };


  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const config = this.#getSportConfig(sportKey);
    const analyst = this.#ANALYST_TIERS.QUANT; // Defaulting to QUANT
    const currentDate = new Date().toISOString();

    const requirements = [
      // *** RE-VERIFIED FIX FOR ODDS FORMAT ***
      `Leg Event: Provide the full game event string (e.g., "Away Team @ Home Team") in the 'event' field. This MUST EXACTLY match an entry from the VERIFIED SCHEDULE context.`,
      `Leg Selection: Provide the specific bet selection (e.g., "Boston Celtics -3.5") in the 'selection' field.`,
      `Market Snapshot: Provide sportsbook, market_type, line (number|null), price (American number - CRITICAL: DO NOT use '+' for positive odds, e.g., 105 not +105), region, UTC timestamp.`,
      `Model Probability: Provide calibrated 'model_probability' (0-1).`,
      `Implied Probability: Calculate 'implied_probability' (0-1) from 'price'.`,
      `Edge & EV: Calculate 'edge_percent' and 'ev_per_100'.`,
      `Kelly Stake: Calculate 'kelly_fraction_full' using f* = (bp - q) / b.`,
      `Correlation Check: Note correlation ('correlation_notes'). REJECT if high negative correlation.`,
      `Market Signals: Populate 'market_signals' (RLM, public %, money %) or null.`,
      `Injury Gates: List critical player dependencies ('injury_gates') with official status or null/empty.`,
      `CLV Target: Estimate 'clv_target_price' (American odds) or null.`
    ];

    const parlayRequirements = [
        `Combined Odds: Calculate 'combined_decimal_odds' and 'combined_american_odds'.`,
        `Combined Probability: Calculate 'combined_probability_product'. Adjust down slightly for noted positive correlation.`,
        `Parlay EV: Calculate 'parlay_ev_per_100'.`,
        `Kelly Staking: Provide full/half/quarter fractions. Recommend quarter Kelly ('recommended_fraction', 'bankroll_allocation_percent').`,
        `Correlation Score: Estimate 'correlation_score' (-1 to 1).`,
        `Risk Assessment: Assign 'overall_risk_assessment' (LOW, MEDIUM, HIGH, REJECTED) and 'rejection_reason' if needed.`,
        `Key Risks: List major concerns in 'key_risk_factors'.`,
        `CLV Plan: State target entry odds/monitoring in 'clv_plan'.`
    ];

    return `# ${analyst.title} MODE - EV-DRIVEN PARLAY GENERATION
You are a ${analyst.title} for ${config.title}, focused on ${analyst.focus}. Goal: long-term profit.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay following ALL requirements below. Prioritize Expected Value (EV) & Kelly Criterion.

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
${formatRequirement("ABSOLUTELY CRITICAL: Each leg's 'event' field MUST be a game taken DIRECTLY and EXACTLY from the 'VERIFIED SCHEDULE' section provided above. Do NOT include games not listed there. If you cannot find enough valid games from the list for the requested number of legs, return fewer legs and adjust 'legs_count' accordingly, or return an empty legs array if no valid games can be used.")}
${formatRequirement("REJECT or DOWNGRADE parlay if critical injury gates involve 'Questionable' or 'Doubtful' STARTERS for any leg. Wait for official updates.")}
${formatRequirement("REJECT parlay if overall calibrated EV ('parlay_ev_per_100') is negative.")}
${formatRequirement("REJECT parlay if significant negative correlation exists between legs.")}
${formatRequirement("If reverse line movement strongly conflicts with your model's edge for a leg, reduce confidence/probability for that leg OR significantly reduce the recommended Kelly stake for the parlay.")}


## OUTPUT CONTRACT - EXACT JSON STRUCTURE REQUIRED
Return ONLY the following JSON structure. Populate ALL fields accurately based on your analysis. Ensure all numeric fields are actual NUMBERS, not strings (and specifically, DO NOT use '+' for positive American odds in the 'price' field). Ensure the 'event' field for each leg matches the verified schedule.

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FINAL CHECK**: Ensure the entire response is ONLY the valid JSON object described above, adhering strictly to the schema and number formatting rules (especially for 'price' and 'event').`;
  }

  static getWebResearchPrompt(sportKey, numLegs, betType, researchContext = {}) {
     // Start with the elite prompt structure (which includes the odds format fix)
     const basePrompt = this.getEliteParlayPrompt(sportKey, numLegs, betType, researchContext);

     // Add specific web research instructions and validation checks
     return `${basePrompt}

## WEB RESEARCH & VALIDATION PROTOCOL
1. **Act as Aggregator**: Use your web search capabilities to find the latest odds (representative of major US books like DraftKings/FanDuel), injury reports (cross-reference official NBA/team sources if possible), and market trends (public/money splits if available) for games within the VERIFIED SCHEDULE context.
2. **Data Synthesis**: Synthesize this information to populate the required fields in the JSON output contract (market snapshot, model probability estimation based on consensus/projections, injury gates, market signals).
3. **Realistic Estimation**: Estimate 'model_probability' based on synthesized data, projections, and common quantitative factors (e.g., rest, back-to-backs). Aim for realistic calibration, acknowledging web data limitations. Be conservative if data is sparse or conflicting. Explicitly follow the number format rules (no '+' for odds).
4. **Strict Validation**:
    - **Schedule Adherence**: EXTREMELY IMPORTANT - ONLY propose legs for games listed in the 'VERIFIED SCHEDULE' context. The 'event' field in each leg MUST match a game from that list.
    - **Odds Range**: Ensure 'price' is within a realistic market range (e.g., -500 to +500) AND IS A VALID NUMBER (no '+'). If web search finds extreme or invalid odds, double-check or discard the leg.
    - **Player/Team Validity**: Use only real, currently active players and teams relevant to the sport key.
    - **Injury Accuracy**: Cross-reference injury statuses if possible. Accurately reflect statuses found (e.g., Questionable, Out) in 'injury_gates'.
5. **Timestamping**: Provide accurate UTC timestamps for when odds/data were observed during your search.

**ZERO TOLERANCE**: Do not invent games, players, odds, or injury statuses. If reliable data cannot be found for a required field (e.g., market signals), populate it with 'null'. If critical information (like valid odds or key player status) is missing for a potential leg, EXCLUDE that leg and find an alternative or reduce the number of legs in the parlay (updating 'legs_count' in metadata). If NO valid legs can be found from the verified schedule, return an empty 'legs' array.`;
    }

  static getFallbackPrompt(sportKey, numLegs, betType, fallbackContext = {}) {
    const config = this.#getSportConfig(sportKey);
    const currentDate = new Date().toISOString();
    // Use ELITE or SHARPS tier for fallback as pure QUANT might struggle without data
    const analyst = this.#ANALYST_TIERS.ELITE;

    // Simplified requirements for fallback, inheriting the main contract structure
    const fallbackRequirements = [
      `Leg Event: Provide a realistic matchup string (e.g., "Team A @ Team B") in the 'event' field.`,
      `Leg Selection: Provide a plausible bet selection (e.g., "Team A -3.5") in the 'selection' field.`,
      `Market Snapshot: Estimate realistic 'price' (number, NO '+'). Set sportsbook="Estimated". Timestamp=now.`,
      `Model Probability: Estimate 'model_probability' (0-1) based on general team strength, home advantage, common factors. Be conservative.`,
      `Implied Probability: Calculate from estimated 'price'.`,
      `Edge & EV: Calculate based on estimates.`,
      `Kelly Stake: Calculate based on estimates. Recommend VERY SMALL stakes (e.g., 0.10 Kelly or fixed small %).`,
      `Correlation Check: Basic check for obvious negative correlations.`,
      `Injury Gates: Assume key players HEALTHY unless major long-term injuries known. Note this assumption.`,
      `Market Signals/CLV: Set these fields to 'null' or provide generic notes like "Not available in fallback mode".`
    ];
     const fallbackParlayRequirements = [
        `Combined Metrics: Calculate odds/prob/EV from estimated leg values.`,
        `Kelly Staking: Recommend very small fractions (e.g., 0.10 Kelly or less).`,
        `Correlation Score: Estimate based on leg markets (e.g., 0 if cross-game).`,
        `Risk Assessment: Default to MEDIUM or HIGH due to lack of real-time data.`,
        `Key Risks: Must include "Lack of real-time odds", "Assumed player availability", "Event not verified".` // Added verification note
    ];


    return `# FALLBACK MODE - FUNDAMENTAL ANALYSIS (${analyst.title})
Operating without reliable real-time odds/injury data. Using fundamental analysis, historical patterns, general team strength, and standard situational factors.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay using ESTIMATED data based on fundamental principles. Adhere to the output structure as closely as possible, noting estimations. Ensure price is a valid number (no '+').

## CONTEXT & ASSUMPTIONS
${this.#buildContextIntelligence(fallbackContext, currentDate)}
${formatRequirement("Assume standard home advantage.")}
${formatRequirement("Assume key players AVAILABLE unless widely known long-term injuries exist.")}
${formatRequirement("Estimate odds based on perceived team strength differences (numeric price, no '+').")}
${formatRequirement("Use plausible, typical matchups for the 'event' field.")} // Added instruction for event

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
Return ONLY the following JSON structure. Clearly mark estimated fields or provide notes. Ensure 'price' is a number (no '+'). Fill 'event' with plausible matchups.

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FALLBACK INTEGRITY**: Focus on logical matchups and standard betting principles. Acknowledge data limitations explicitly in the output. Ensure valid JSON format.`;
  }

  // --- Helper methods ---
   static #buildContextIntelligence(context, date) {
        const intelligence = [
            '## CONTEXTUAL INTELLIGENCE & ENVIRONMENT',
            `• Analysis Timestamp: ${date}`,
            `• Market Conditions: ${context?.marketConditions || 'Assume standard liquidity'}`,
            `• Season Phase: ${context?.seasonPhase || 'Assume mid-season dynamics'}`
        ];
        // Include VERIFIED SCHEDULE if available
        if (context?.scheduleInfo) {
            intelligence.push(context.scheduleInfo);
        } else {
             intelligence.push('\n\n## VERIFIED SCHEDULE\nNo schedule provided. Use typical matchups.'); // Explicit fallback if no schedule
        }
         // Include INJURY DATA if available
         if (context?.injuryReport) {
             intelligence.push(`• KEY INJURY REPORT: ${context.injuryReport}`);
         } else {
             intelligence.push('• KEY INJURY REPORT: Injury data not provided; list critical player assumptions in injury_gates.')
         }
        return intelligence.join('\n');
    }

    static #buildUserContext(userConfig) {
        if (!userConfig) return '## USER CONTEXT\n• No specific user preferences provided.';
        const context = ['## USER CONTEXT & PREFERENCES'];
        if (userConfig.risk_tolerance) {
          context.push(`• User Risk Profile: ${userConfig.risk_tolerance.toUpperCase()} (Adjust Kelly fraction recommendation accordingly).`);
        }
        if (userConfig.favorite_teams?.length) {
          context.push(`• User Team Preferences: ${userConfig.favorite_teams.join(', ')} (Avoid explicit bias).`);
        }
        if (userConfig.proQuantMode === true) {
          context.push('• User Mode: PRO QUANT ACTIVATED (Prioritize statistical edge, minimize narrative, stricter EV threshold).');
        }
        if (userConfig.avoid_players?.length) {
          context.push(`• User Excluded Players: ${userConfig.avoid_players.join(', ')} (Do not include).`);
        }
         if (userConfig.bookmakers?.length) {
          context.push(`• User Preferred Books: ${userConfig.bookmakers.join(', ')} (Use representative odds).`);
        }
        return context.join('\n');
    }

  static #selectAnalystTier(context) {
    // Default to QUANT for EV-driven approach
    return this.#ANALYST_TIERS.QUANT;
  }

  static #calculateTargetEV(analyst) {
    // Less critical now, but kept for potential internal logic
    const evMap = { 'QUANTITATIVE ANALYST': 0.05, 'PROFESSIONAL SHARP': 0.03, 'ELITE SPORTS ANALYST': 0.02 };
    return evMap[analyst.title] || 0.03;
  }

   static #getSportConfig(sportKey) {
     const defaultConfig = {
        title: String(sportKey).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        edges: ['General analysis', 'Market inefficiencies'],
        keyMarkets: ['moneyline', 'spread', 'total']
    };
    return this.#SPORT_CONFIG.get(sportKey) || defaultConfig;
  }

} // End ElitePromptService Class

export default ElitePromptService;

// Also export the constants if they might be needed elsewhere (e.g., for validation schemas)
export { LEG_OUTPUT_CONTRACT, PARLAY_OUTPUT_CONTRACT };
