// src/services/elitePromptService.js - QUANTUM PROMPT ENGINE (EV-Driven Update - Re-verified JSON Fix)
import { sentryService } from './sentryService.js';
// Assuming ProbabilityCalculator is accessible or defined elsewhere if needed here
// import { ProbabilityCalculator } from './quantitativeService.js'; // Example import

// Helper to format requirements clearly in prompts
const formatRequirement = (req) => `\n  - ${req}`;

// Define the MINIMAL output contract structure
// *** RE-VERIFIED FIX: Explicit instruction about positive odds format ***
const LEG_OUTPUT_CONTRACT = `{
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
          "correlation_notes": "Low correlation." // (string | null)
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
    "overall_thesis": "Brief +EV justification.", // (string)
    "key_risk_factors": ["e.g., Injury dependency", "Correlation", "Low CLV margin"], // (string[])
    "clv_plan": "Target entry price: +583 or better. Monitor lines." // (string)
  }
}`;


export class ElitePromptService {
  // Static properties (#SPORT_CONFIG, #ANALYST_TIERS) remain as previously defined...
  static #SPORT_CONFIG = new Map([ /* ... Sport configurations ... */
      ['basketball_nba', { title: 'NBA Basketball', edges: ['B2Bs', 'Rest', 'Pace', 'Props', 'Narratives'], keyMarkets: ['moneyline', 'spread', 'total', 'player_points'] }],
      ['americanfootball_nfl', { title: 'NFL Football', edges: ['Div Dogs', 'Rest', 'Weather', 'Coaching', 'Injuries'], keyMarkets: ['moneyline', 'spread', 'total', 'player_tds'] }],
      ['baseball_mlb', { title: 'MLB Baseball', edges: ['Pitching', 'Bullpen', 'Ballpark', 'Weather', 'Lineups'], keyMarkets: ['moneyline', 'runline', 'total', 'player_hits'] }],
      ['icehockey_nhl', { title: 'NHL Hockey', edges: ['Goalie', 'Lines', 'Specials', 'Travel', 'B2Bs'], keyMarkets: ['moneyline', 'puck_line', 'total', 'player_shots'] }],
      ['soccer_england_premier_league', { title: 'Premier League', edges: ['Form', 'Home/Away', 'Derby', 'Tactics', 'Europe'], keyMarkets: ['moneyline', 'asian_handicap', 'total', 'btts'] }],
      ['mma_ufc', { title: 'UFC', edges: ['Styles', 'Reach', 'Camp', 'Weight', 'Experience'], keyMarkets: ['moneyline', 'method', 'rounds', 'distance'] }],
      ['tennis_atp', { title: 'ATP Tennis', edges: ['Surface', 'H2H', 'Break Pts', 'Recovery', 'Schedule'], keyMarkets: ['moneyline', 'game_spread', 'total_games', 'set_betting'] }],
  ]);
  static #ANALYST_TIERS = { /* ... Analyst Tiers ... */
      QUANT: { title: 'QUANTITATIVE ANALYST', focus: 'statistical arbitrage, model edges, CLV maximization', minHitRate: 0.72, experience: '15+y', specialties: ['ML', 'Market Gaps', 'Calibration', 'Kelly'] },
      SHARPS: { title: 'PROFESSIONAL SHARP', focus: 'line movement, market inefficiencies, situational value', minHitRate: 0.67, experience: '12+y', specialties: ['Shopping', 'Steam', 'RLM', 'Injuries'] },
      ELITE: { title: 'ELITE SPORTS ANALYST', focus: 'fundamental analysis, matchup edges, qualitative factors', minHitRate: 0.63, experience: '10+y', specialties: ['Coaching', 'Motivation', 'Intangibles', 'Narratives'] }
  };


  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const config = this.#getSportConfig(sportKey);
    const analyst = this.#ANALYST_TIERS.QUANT;
    const currentDate = new Date().toISOString();

    const requirements = [
      // *** RE-VERIFIED FIX FOR ODDS FORMAT ***
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

    const parlayRequirements = [ /* ... Parlay requirements ... */
        `Combined Odds: Calculate 'combined_decimal_odds', 'combined_american_odds'.`,
        `Combined Probability: Calculate 'combined_probability_product'. Adjust down for noted positive correlation.`,
        `Parlay EV: Calculate 'parlay_ev_per_100'.`,
        `Kelly Staking: Provide full/half/quarter fractions. Recommend quarter Kelly ('recommended_fraction', 'bankroll_allocation_percent').`,
        `Correlation Score: Estimate 'correlation_score' (-1 to 1).`,
        `Risk Assessment: Assign 'overall_risk_assessment' (LOW, MEDIUM, HIGH, REJECTED) and 'rejection_reason'.`,
        `Key Risks: List concerns in 'key_risk_factors'.`,
        `CLV Plan: State target entry/monitoring in 'clv_plan'.`
    ];

    return `# ${analyst.title} MODE - EV-DRIVEN PARLAY GENERATION
You are a ${analyst.title} for ${config.title}, focused on ${analyst.focus}. Goal: long-term profit.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay following ALL requirements. Prioritize EV & Kelly Criterion.

## CONTEXTUAL INTELLIGENCE
${this.#buildContextIntelligence(context, currentDate)}
${this.#buildUserContext(context.userConfig)}

## ${config.title.toUpperCase()} QUANTUM EDGES (Informational)
${config.edges.map(edge => `• ${edge}`).join('\n')}

## HARD REQUIREMENTS PER LEG ${requirements.map(formatRequirement).join('')}

## HARD REQUIREMENTS FOR COMBINED PARLAY ${parlayRequirements.map(formatRequirement).join('')}

## KELLY CRITERION FORMULA (Reference)
f* = (bp - q) / b, where b = decimal_odds - 1, p = model_probability, q = 1 - p. Recommend Quarter Kelly (f* / 4).

## PROMPT GUARDRAILS - NON-NEGOTIABLE
${formatRequirement("REJECT or DOWNGRADE if critical injury gates involve 'Questionable'/'Doubtful' STARTERS.")}
${formatRequirement("REJECT if overall 'parlay_ev_per_100' is negative.")}
${formatRequirement("REJECT if significant negative correlation exists.")}
${formatRequirement("If RLM conflicts with model edge, reduce confidence/probability OR reduce recommended Kelly stake.")}
${formatRequirement("ONLY use games from VERIFIED SCHEDULE. Reject others.")}

## OUTPUT CONTRACT - EXACT JSON STRUCTURE REQUIRED
Return ONLY the following JSON structure. Populate ALL fields accurately. Ensure numeric fields are NUMBERS (no '+' for positive odds).

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FINAL CHECK**: JSON valid? All fields meet requirements? No '+' on positive prices?`;
  }

  static getWebResearchPrompt(sportKey, numLegs, betType, researchContext = {}) {
     const basePrompt = this.getEliteParlayPrompt(sportKey, numLegs, betType, researchContext);
     return `${basePrompt}

## WEB RESEARCH & VALIDATION PROTOCOL
1. **Act as Aggregator**: Use web search for latest odds (major US books), injuries (official sources), market trends (splits) for games in VERIFIED SCHEDULE.
2. **Data Synthesis**: Populate required JSON fields.
3. **Realistic Estimation**: Estimate 'model_probability' conservatively based on synthesized data. Explicitly follow number format rules (no '+').
4. **Strict Validation**: Adhere ONLY to 'VERIFIED SCHEDULE'. Ensure 'price' is realistic (-500 to +500) and formatted correctly. Use real players/teams. Accurately reflect injury statuses.
5. **Timestamping**: Provide accurate UTC timestamps for data observation.

**ZERO TOLERANCE**: No invented games/players/odds/statuses. Use 'null' if data unreliable/missing. EXCLUDE leg if critical info (odds, status) missing.`;
    }

  static getFallbackPrompt(sportKey, numLegs, betType, fallbackContext = {}) {
    // ... (Fallback prompt remains the same, but inherits the updated contract definition) ...
    const config = this.#getSportConfig(sportKey);
    const currentDate = new Date().toISOString();
    const analyst = this.#ANALYST_TIERS.ELITE;
    const fallbackRequirements = [
      `Market Snapshot: Estimate 'price' (number, no '+'). sportsbook="Estimated". Timestamp=now.`,
      `Model Probability: Estimate 'model_probability' (0-1) conservatively.`,
      `Implied Probability: Calculate from estimated 'price'.`,
      `Edge & EV: Calculate based on estimates.`,
      `Kelly Stake: Calculate. Recommend VERY SMALL stakes (e.g., <= 0.10 Kelly).`,
      `Correlation Check: Basic check.`,
      `Injury Gates: Assume key players HEALTHY. Note assumption.`,
      `Market Signals/CLV: Set to 'null' or note "N/A in fallback".`
    ];
     const fallbackParlayRequirements = [
        `Combined Metrics: Calculate from estimated leg values.`,
        `Kelly Staking: Recommend very small fractions (<= 0.10 Kelly).`,
        `Correlation Score: Estimate.`,
        `Risk Assessment: Default MEDIUM or HIGH.`,
        `Key Risks: Must include "No real-time data", "Assumed player availability".`
    ];
    return `# FALLBACK MODE - FUNDAMENTAL ANALYSIS (${analyst.title})
Operating without reliable real-time data. Using fundamental analysis, historical patterns, general team strength.

## MANDATE
Generate a ${numLegs}-leg ${config.title} ${betType} parlay using ESTIMATED data. Adhere to output structure, noting estimations.

## CONTEXT & ASSUMPTIONS
${this.#buildContextIntelligence(fallbackContext, currentDate)}
${formatRequirement("Assume standard home advantage.")}
${formatRequirement("Assume key players AVAILABLE unless major long-term injuries known.")}
${formatRequirement("Estimate odds based on perceived strength (no '+').")}

## ${config.title.toUpperCase()} FUNDAMENTAL EDGES (Apply conceptually)
${config.edges.map(edge => `• ${edge}`).join('\n')}

## FALLBACK REQUIREMENTS PER LEG ${fallbackRequirements.map(formatRequirement).join('')}

## FALLBACK REQUIREMENTS FOR COMBINED PARLAY ${fallbackParlayRequirements.map(formatRequirement).join('')}

## KELLY CRITERION FORMULA (Reference)
f* = (bp - q) / b. Recommend VERY SMALL fraction (<= 0.10 Kelly).

## GUARDRAILS
${formatRequirement("State clearly odds/probs are ESTIMATED.")}
${formatRequirement("Set risk to MEDIUM or HIGH.")}
${formatRequirement("Recommend significantly reduced stakes.")}
${formatRequirement("Do NOT use VERIFIED SCHEDULE; assume typical matchups.")}

## OUTPUT CONTRACT - EXACT JSON STRUCTURE REQUIRED (Use estimates/nulls)
Return ONLY the following JSON structure. Mark estimates/provide notes.

\`\`\`json
${PARLAY_OUTPUT_CONTRACT}
\`\`\`

**FALLBACK INTEGRITY**: Focus on logic. Acknowledge data limits.`;
  }

  // --- Helper methods remain the same ---
   static #buildContextIntelligence(context, date) { /* ... remains the same ... */
        const intelligence = ['## CONTEXTUAL INTELLIGENCE & ENVIRONMENT', `• Analysis Timestamp: ${date}`, `• Market Conditions: ${context?.marketConditions || 'Assume standard liquidity'}`, `• Season Phase: ${context?.seasonPhase || 'Assume mid-season'}`];
        if (context?.scheduleInfo) intelligence.push(context.scheduleInfo);
        if (context?.injuryReport) intelligence.push(`• KEY INJURY REPORT: ${context.injuryReport}`);
        else intelligence.push('• KEY INJURY REPORT: Injury data N/A; list assumptions in injury_gates.');
        return intelligence.join('\n');
   }
   static #buildUserContext(userConfig) { /* ... remains the same ... */
        if (!userConfig) return '## USER CONTEXT\n• No specific user preferences provided.';
        const context = ['## USER CONTEXT & PREFERENCES'];
        if (userConfig.risk_tolerance) context.push(`• User Risk Profile: ${userConfig.risk_tolerance.toUpperCase()}.`);
        if (userConfig.favorite_teams?.length) context.push(`• User Team Preferences: ${userConfig.favorite_teams.join(', ')}. Avoid bias.`);
        if (userConfig.proQuantMode === true) context.push('• User Mode: PRO QUANT ACTIVATED.');
        if (userConfig.avoid_players?.length) context.push(`• User Excluded Players: ${userConfig.avoid_players.join(', ')}.`);
        if (userConfig.bookmakers?.length) context.push(`• User Preferred Books: ${userConfig.bookmakers.join(', ')}. Use representative odds.`);
        return context.join('\n');
   }
   static #selectAnalystTier(context) { return this.#ANALYST_TIERS.QUANT; }
   static #calculateTargetEV(analyst) { return 0.03; } // Min EV target
   static #getSportConfig(sportKey) { /* ... remains the same ... */
     const defaultConfig = { title: String(sportKey).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), edges: [], keyMarkets: ['moneyline', 'spread', 'total'] };
     return this.#SPORT_CONFIG.get(sportKey) || defaultConfig;
   }

} // End ElitePromptService Class

export default ElitePromptService;
export { LEG_OUTPUT_CONTRACT, PARLAY_OUTPUT_CONTRACT }; // Export contracts if needed
