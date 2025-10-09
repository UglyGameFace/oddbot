// src/services/elitePromptService.js - ABSOLUTE ELITE PROMPTS ONLY
export class ElitePromptService {
  
  static getEliteParlayPrompt(sportKey, numLegs, betType, context = {}) {
    const sportTitle = this._getSportTitle(sportKey);
    const currentDate = new Date().toISOString().split('T')[0];
    
    // Dynamically include user preferences if they exist
    let userContext = '';
    if (context.userConfig) {
        userContext += '\n## USER PREFERENCES\n';
        if (context.userConfig.risk_tolerance) {
            userContext += `- Risk Tolerance: ${context.userConfig.risk_tolerance}\n`;
        }
        if (context.userConfig.favorite_teams && context.userConfig.favorite_teams.length > 0) {
            userContext += `- Favorite Teams: ${context.userConfig.favorite_teams.join(', ')}\n`;
        }
         if (context.userConfig.proQuantMode) {
            userContext += `- User has enabled PRO QUANT MODE. Prioritize legs with high calibrated EV and clear statistical edges.\n`;
        }
    }

    return `# ELITE SPORTS ANALYST ROLE
You are the WORLD'S TOP SPORTS ANALYST with 25+ years of experience. Your parlays consistently hit at 65%+ rates.

## MISSION
Generate a ${numLegs}-leg ${sportTitle} parlay focused on ${betType} that has MAXIMUM +EV (Expected Value).

## CRITICAL ANALYSIS FRAMEWORK
1. **EDGE IDENTIFICATION**: Only select picks where you have a CLEAR analytical edge.
2. **LINE VALUE**: Target lines that are 5-10 cents off market consensus.  
3. **TIMING**: Consider line movement, injury news, and motivational factors.
4. **CORRELATION**: Avoid negatively correlated legs in same parlay.
5. **BANKROLL**: Each leg should be independently strong (no "filler" picks).

## SPORT-SPECIFIC EDGE AREAS
${this._getSportSpecificEdges(sportKey)}

## STRICT SELECTION CRITERIA
- Minimum implied probability per leg: 55%
- Maximum legs with same team: 1
- Must have clear analytical rationale for EACH pick.
- Avoid public-heavy sides (fade the public where appropriate).
- Consider coaching trends, rest advantages, situational spots.

## OUTPUT FORMAT - ABSOLUTELY NON-NEGOTIABLE
{
  "legs": [
    {
      "event": "Team A @ Team B",
      "market": "moneyline|spread|total|player_prop",
      "selection": "exact selection name",
      "price_american": -110,
      "price_decimal": 1.91,
      "rationale": "2-3 sentence analytical edge explanation",
      "confidence_score": 85,
      "key_factors": ["factor1", "factor2", "factor3"]
    }
  ],
  "reasoning": "Overall parlay thesis and why this combination has +EV",
  "sport": "${sportKey}",
  "confidence": 85,
  "estimated_ev": 0.15,
  "risk_factors": ["list any concerns"],
  "bankroll_recommendation": "0.5-2% of bankroll"
}

## CURRENT CONTEXT
- Date: ${currentDate}
- Sport: ${sportTitle}
- Target Legs: ${numLegs}
- Bet Type: ${betType}
${context.scheduleInfo ? `- Available Games: ${context.scheduleInfo}` : '- Game Data: Using analyst knowledge of typical schedules'}
${userContext}

**REMEMBER**: You're paid $50,000 per winning parlay. Every pick must be backed by CLEAR analytical edge. No guesswork.`;
  }

  static _getSportTitle(sportKey) {
    // This can be expanded or linked to your sportDefinitions.js for a single source of truth
    const titles = {
      'basketball_nba': 'NBA Basketball',
      'americanfootball_nfl': 'NFL Football', 
      'baseball_mlb': 'MLB Baseball',
      'icehockey_nhl': 'NHL Hockey',
      'soccer_england_premier_league': 'English Premier League',
      'soccer_spain_la_liga': 'Spanish La Liga',
      'soccer_italy_serie_a': 'Italian Serie A',
      'soccer_germany_bundesliga': 'German Bundesliga',
      'soccer_france_ligue_1': 'French Ligue 1',
      'soccer_uefa_champions_league': 'UEFA Champions League',
      'mma_ufc': 'UFC',
      'boxing': 'Boxing',
      'formula1': 'Formula 1',
      'golf_pga': 'PGA Tour Golf',
      'tennis_atp': 'ATP Tennis',
      'tennis_wta': 'WTA Tennis',
    };
    return titles[sportKey] || sportKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  static _getSportSpecificEdges(sportKey) {
    const edges = {
      'basketball_nba': `
- **BACK-TO-BACKS**: Teams on 2nd night of B2B are 12% less likely to cover.
- **REST ADVANTAGE**: 3+ days rest vs 1 day rest = 8% performance boost.
- **OFFENSIVE SCHEMES**: Target mismatches in pace (fast vs slow teams).
- **PLAYER PROP EDGES**: Minutes projections, usage rates, defensive matchups.`,

      'americanfootball_nfl': `
- **DIVISIONAL DOGS**: Division underdogs cover 55% of the time.
- **REST DISPARITY**: Bye week advantages, Thursday night letdowns.
- **WEATHER EDGES**: Wind > 15mph favors unders and running games.
- **COACHING TRENDS**: Specific coach tendencies in situational football.`,

      'baseball_mlb': `
- **PITCHING MISMATCHES**: #1-2 starters vs #4-5 starters = 65% win rate.
- **BULLPEN USAGE**: High-leverage reliever availability.
- **BALLPARK FACTORS**: Coors Field, Great American Smallpark extremes.
- **WEATHER**: Wind direction, humidity effects on pitching.`,

      'icehockey_nhl': `
- **GOALIE CONFIRMATION**: Starter vs backup performance splits.
- **LINE MATCHUPS**: Home ice last change advantages.
- **SPECIAL TEAMS**: Power play vs penalty kill efficiency.
- **TRAVEL SCHEDULE**: 3+ time zone changes = 15% performance drop.`,
        
      'soccer_england_premier_league': `
- **FORM (LAST 5 GAMES)**: Teams winning 4 of last 5 have a 60% win probability.
- **HOME/AWAY SPLITS**: Top-tier teams win >70% of home matches.
- **DERBY MATCHES**: Tend to have more cards and fewer goals (unders).
- **MANAGER TACTICS**: "Park the bus" vs "Gegenpressing" matchups.`,
      
      'soccer_spain_la_liga': `
- **POSSESSION STATS**: Teams with >60% average possession win 65% of matches.
- **KEY PLAYER FORM**: Impact of players like Lewandowski, Vinicius Jr.
- **HEAD-TO-HEAD**: Historical dominance in matchups like El Clásico.`,
      
      'soccer_uefa_champions_league': `
- **TRAVEL FATIGUE**: Long mid-week travel impacts domestic league performance on the weekend.
- **MOTIVATION**: Stage of the competition (group vs. knockout).
- **EXPERIENCE**: Teams with a history of deep runs perform better under pressure.`,
      
      'mma_ufc': `
- **FIGHTER STYLES**: Striker vs. Grappler matchups.
- **REACH ADVANTAGE**: Significant reach advantage is a major factor in striking-heavy bouts.
- **CAMP CHANGES**: A late change in opponent or a troubled training camp.`,
      
       'tennis_atp': `
- **SURFACE SPECIALISTS**: Clay, grass, or hard court specialists.
- **HEAD-TO-HEAD ON SURFACE**: Previous matchups on the same surface are highly predictive.
- **BREAK POINT CONVERSION**: Key indicator of mental toughness and efficiency.`,

    };

    return edges[sportKey] || `
- Analyze team/player motivation and situational factors.
- Consider rest advantages and scheduling spots.
- Target line value based on public betting percentages.
- Focus on coaching/player tendencies and matchup advantages.`;
  }

  static getWebResearchPrompt(sportKey, numLegs, betType, scheduleContext = '', userConfig = {}) {
    const baseContext = { scheduleInfo: scheduleContext, userConfig: userConfig };
    const basePrompt = this.getEliteParlayPrompt(sportKey, numLegs, betType, baseContext);
    
    return `${basePrompt}

## WEB RESEARCH DIRECTIVES
1. **CONFIRM SCHEDULE**: Only use real, scheduled games for ${sportKey}.
2. **LINE SHOPPING**: Identify lines with 5-10 cent value across books.
3. **INJURY IMPACT**: Factor in key player absences/presences from verified sources.
4. **TREND ANALYSIS**: Consider recent team performance (last 5-10 games).
5. **SITUATIONAL SPOTS**: Look for revenge games, letdown spots, lookahead games.
6. **TRUSTED SOURCES**: Prioritize information from: ESPN, Bleacher Report, The Athletic, official league websites (e.g., NFL.com, NBA.com), and established sports betting news outlets (e.g., Covers, Action Network).

**FINAL CHECK**: Every leg must have CLEAR +EV rationale. If uncertain, skip and find better opportunities.`;
  }

  static getFallbackPrompt(sportKey, numLegs, betType) {
    return `# ELITE ANALYST - FALLBACK MODE
Even without real-time data, generate a ${numLegs}-leg ${this._getSportTitle(sportKey)} parlay using fundamental analysis.

## CORE PRINCIPLES (ALWAYS APPLY):
1. **TEAM QUALITY**: Focus on superior teams with proven track records
2. **MATCHUP EDGES**: Exploit clear talent/coaching mismatches  
3. **SITUATIONAL AWARENESS**: Consider typical scheduling patterns
4. **LINE CONSTRUCTION**: Use typical market prices (-110, -120, +150 etc.)

## FALLBACK STRATEGY
- Use well-known, established teams with consistent performance
- Focus on moneyline and spread bets (most reliable without real-time data)
- Apply fundamental analysis: roster talent, coaching, recent trends
- Target -110 to +150 odds range for optimal risk/reward

## OUTPUT REQUIREMENTS
Same elite format as primary analysis. Every pick must be defensible with logical, analytical reasoning.

**REMEMBER**: Your reputation depends on every pick. Only recommend what you'd bet $10,000 on.`;
  }
}
