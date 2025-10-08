// src/services/elitePromptService.js - V2 ARCHITECTURE

export class ElitePromptService {
  
  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const sportTitle = this._getSportTitle(sportKey);
    const currentDate = new Date().toISOString().split('T')[0];
    
    // New context variables
    const gameFocus = context.gameId ? `\n- **Game Focus**: At least ONE leg MUST be from the game: ${context.gameId}` : '';
    const teamBlacklist = context.excludedTeams?.length > 0 ? `\n- **Team Blacklist**: AVOID picks involving: ${context.excludedTeams.join(', ')}` : '';

    return `
# ROLE: Quantitative Sports Analyst & Senior Software Architect

## SYSTEM DIRECTIVE
You are an advanced analytical engine designed for a high-frequency sports betting fund. Your prime directive is to construct high-alpha parlays by identifying and exploiting market inefficiencies. You operate with surgical precision, absolute data integrity, and zero emotional bias.

## MISSION PARAMETERS
- **Target Sport**: ${sportTitle} (${sportKey})
- **Parlay Structure**: ${numLegs} legs
- **Market Focus**: ${betType}
- **Date**: ${currentDate}
- **Time Horizon**: Up to ${context.horizonHours || 72} hours
${gameFocus}
${teamBlacklist}

## CORE ANALYTICAL FRAMEWORK (MANDATORY)
1.  **Vig Removal & True Probability**: For every potential leg, remove the bookmaker's vigorish to calculate the "true" underlying probability.
2.  **Edge Identification (+EV)**: A leg is only valid if your calculated true probability is higher than the implied probability of the offered odds. The Expected Value (EV) must be positive.
3.  **Closing Line Value (CLV) Mindset**: Prioritize picks where you anticipate the line will move in your favor. Justify why the current line is inefficient.
4.  **Correlation Analysis**: Model the correlation between legs. Avoid strongly negatively correlated picks. Acknowledge and slightly discount positively correlated picks in the final EV calculation.
5.  **Threat Modeling (Risks)**: For each leg, identify the primary risk factors (e.g., key player dependency, high variance, public over-betting, situational factors like back-to-backs).

## SPORT-SPECIFIC DATA VECTORS
${this._getSportSpecificEdges(sportKey)}

## STRICT OUTPUT CONTRACT (NON-NEGOTIABLE JSON)
Return ONLY a single, valid JSON object. No prose, no apologies, no text outside the JSON.
{
  "legs": [
    {
      "event": "Team A @ Team B",
      "market": "moneyline|spread|total|player_prop",
      "selection": "Exact selection name",
      "price_american": -110,
      "rationale": "Concise, data-driven justification for the identified edge. Reference true probability vs. implied.",
      "risks": ["Primary risk factor 1", "Risk factor 2"]
    }
  ],
  "parlay_analysis": {
    "reasoning": "Overall thesis for why this combination of legs provides value and how correlations were considered.",
    "total_american_odds": 595,
    "true_win_probability": 0.18,
    "expected_value_pct": 15.5
  },
  "metadata": {
    "sport": "${sportKey}",
    "model_version": "v2.1"
  }
}

## FINAL COMMAND
Execute mission.`;
  }

  static _getSportTitle(sportKey) {
    // ... (this function remains the same)
    const titles = {
      'basketball_nba': 'NBA Basketball',
      'americanfootball_nfl': 'NFL Football', 
      'baseball_mlb': 'MLB Baseball',
      'icehockey_nhl': 'NHL Hockey',
      'soccer_england_premier_league': 'English Premier League'
    };
    return titles[sportKey] || sportKey;
  }

  static _getSportSpecificEdges(sportKey) {
    // ... (this function remains the same)
    const edges = {
      'basketball_nba': `
- **Pace & Efficiency Mismatches**: Exploit differences in pace (possessions per game) vs. offensive/defensive efficiency ratings.
- **Player Prop Vectors**: Analyze player usage rates, minutes projections, and individual defensive matchups (e.g., opponent DvP).
- **Situational Factors**: Heavily weight rest advantage (e.g., 3+ days rest vs. 2nd night of a back-to-back).`,

      'americanfootball_nfl': `
- **Scheme Mismatches**: Analyze offense vs. defense DVOA (e.g., pass-heavy offense vs. weak secondary).
- **Situational Edges**: Model impact of bye weeks, short weeks (Thursday Night Football), and cross-country travel.
- **Weather Vectors**: Quantify impact of wind speed (>15mph) on passing/kicking games and totals.`,

      'baseball_mlb': `
- **Pitching Differentials**: Model matchups using advanced metrics (xFIP, SIERA) not just ERA. Compare starter vs. bullpen strength.
- **Ballpark Factors**: Adjust for park-specific effects on home runs, doubles, and runs scored.
- **Umpire Tendencies**: Note home plate umpires with strong tendencies toward pitcher or batter-friendly strike zones.`,

      'icehockey_nhl': `
- **Goaltending Edge**: Compare starter's Goals Saved Above Expected (GSAx). A backup goalie is a significant variable.
- **Special Teams**: Model power play percentage (PP%) vs. penalty kill percentage (PK%) matchups.
- **Travel & Fatigue**: Quantify performance degradation from long road trips, especially across time zones.`
    };

    return edges[sportKey] || `- General Vectors: Analyze team form, head-to-head history, and motivational factors.`;
  }
}
