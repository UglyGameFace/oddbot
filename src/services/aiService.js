// src/services/aiService.js - EV-DRIVEN UPDATE (Complete File with Emoji Symbols)
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService, { ProbabilityCalculator } from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { toDecimalFromAmerican, toAmericanFromDecimal } from '../utils/botUtils.js';
import { TimeoutError, withTimeout } from '../utils/asyncUtils.js';
import { sentryService } from './sentryService.js';
import { strictExtractJSONObject } from '../utils/strictJson.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 45000;
const DEFAULT_HORIZON_HOURS = 72;

// AI Model Configuration (Centralized)
const AI_PROVIDERS = {
    PERPLEXITY: {
        name: 'Perplexity AI',
        model: 'sonar-pro',
        apiUrl: 'https://api.perplexity.ai/chat/completions',
        buildPayload: (prompt, model) => ({
             model: model,
             messages: [
                 { 
                     role: 'system', 
                     content: `Return ONLY valid JSON matching the exact schema requested in the user prompt. 
                     CRITICAL: Use these emoji symbols instead of problematic characters:
                     - Use "➕" for positive numbers (instead of +)
                     - Use "➖" for negative numbers (instead of -)
                     - Use "📈" for over/above
                     - Use "📉" for under/below
                     - Use "🏠" for home team
                     - Use "✈️" for away team
                     - Use "⭐" for favorite
                     - Use "🔺" for increase/up
                     - Use "🔻" for decrease/down
                     
                     Example: Instead of "line": +3.5, use "line": "➕3.5"
                     Example: Instead of "price": -110, use "price": "➖110"
                     Example: Instead of "Over 225.5", use "📈 225.5"
                     
                     Never use raw + or - signs in JSON values. Always use emojis as shown above.`
                 },
                 { role: 'user', content: prompt }
             ]
         }),
        extractContent: (responseData) => responseData?.choices?.[0]?.message?.content || '',
        getHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` })
    },
    GEMINI: {
        name: 'Google Gemini',
        model: 'gemini-1.5-flash-latest',
        apiUrl: (apiKey, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        buildPayload: (prompt) => ({
             contents: [{ parts: [{ text: prompt }] }],
             generationConfig: {
                responseMimeType: "application/json",
             }
         }),
        extractContent: (responseData) => responseData?.candidates?.[0]?.content?.parts?.[0]?.text || '',
        getHeaders: () => ({ 'Content-Type': 'application/json' })
    }
};

// Helper to calculate parlay odds (Decimal)
function calculateParlayDecimal(legs = []) {
    const validLegs = legs.filter(leg => typeof leg?.odds?.american === 'number' && Number.isFinite(leg.odds.american));
    if (validLegs.length === 0) return 1.0;

    return validLegs.reduce((acc, leg) => {
        const decimal = ProbabilityCalculator.americanToDecimal(leg.odds.american);
        return acc * (decimal > 1 ? decimal : 1.0);
    }, 1.0);
}

// ENHANCED: Robust JSON extraction with emoji support
function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    
    let cleanedText = text.trim();
    
    // Remove code fences
    cleanedText = cleanedText.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    
    try {
        // First try the strict extraction
        return strictExtractJSONObject(cleanedText);
    } catch (strictError) {
        console.warn("⚠️ Strict JSON extraction failed, trying fallback methods:", strictError.message);
        
        // Fallback 1: Try to extract JSON from code fences
        try {
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]+?)\s*```/;
            const match = cleanedText.match(jsonBlockRegex);
            if (match && match[1]) {
                return JSON.parse(match[1].trim());
            }
        } catch (fenceError) {
            console.warn("⚠️ Code fence extraction failed:", fenceError.message);
        }

        // Fallback 2: Try to find and parse the outermost object
        try {
            const firstBrace = cleanedText.indexOf('{');
            const lastBrace = cleanedText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                const candidate = cleanedText.substring(firstBrace, lastBrace + 1);
                return JSON.parse(candidate);
            }
        } catch (braceError) {
            console.warn("⚠️ Brace extraction failed:", braceError.message);
        }

        console.error("❌ All JSON extraction methods failed");
        sentryService.captureError(new Error("Failed JSON Extraction from AI"), { 
            level: "warning", 
            extra: { 
                responseSample: cleanedText.substring(0, 500),
                strictError: strictError.message
            } 
        });
        return null;
    }
}

// NEW: Convert emoji symbols back to standard format for processing
function normalizeEmojiSymbols(parlayData) {
    if (!parlayData || typeof parlayData !== 'object') return parlayData;
    
    // Deep clone to avoid modifying original
    const normalized = JSON.parse(JSON.stringify(parlayData));
    
    // Process legs array
    if (Array.isArray(normalized.legs)) {
        normalized.legs = normalized.legs.map(leg => {
            // Convert emoji line values to numbers
            if (typeof leg.line === 'string') {
                if (leg.line.startsWith('➕')) {
                    leg.line = parseFloat(leg.line.slice(1));
                } else if (leg.line.startsWith('➖')) {
                    leg.line = parseFloat(leg.line.slice(1)) * -1;
                }
            }
            
            // Convert emoji price values to numbers
            if (typeof leg.price === 'string') {
                if (leg.price.startsWith('➕')) {
                    leg.price = parseFloat(leg.price.slice(1));
                } else if (leg.price.startsWith('➖')) {
                    leg.price = parseFloat(leg.price.slice(1)) * -1;
                }
            }
            
            // Convert emoji selection text
            if (typeof leg.selection === 'string') {
                leg.selection = leg.selection
                    .replace(/➕/g, '+')
                    .replace(/➖/g, '-')
                    .replace(/📈/g, 'Over')
                    .replace(/📉/g, 'Under')
                    .replace(/🏠/g, 'Home')
                    .replace(/✈️/g, 'Away')
                    .replace(/⭐/g, 'Favorite')
                    .replace(/🔺/g, '↑')
                    .replace(/🔻/g, '↓');
            }
            
            return leg;
        });
    }
    
    return normalized;
}

// Fetches verified schedule to provide context to the AI
async function buildScheduleContextForAI(sportKey, hours) {
    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);

        if (!Array.isArray(realGames) || realGames.length === 0) {
            console.warn(`⚠️ No verified games found for ${sportKey} within ${hours}h for AI context.`);
            return `\n\n## VERIFIED SCHEDULE\nNo verified games found for ${sportKey} in the next ${hours} hours. Base analysis on typical matchups, team strengths, and standard scheduling patterns, but clearly state this limitation.`;
        }

        const gameList = realGames
            .slice(0, 20)
            .map((game, index) => {
                const timeStr = new Date(game.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
            })
            .join('\n');

        return `\n\n## VERIFIED SCHEDULE (Next ${hours} hours - ${realGames.length} total games)\n${gameList}\n\n**CRITICAL: Base your parlay legs ONLY on games from this verified list using the exact "Away Team @ Home Team" format.** Reject any other potential matchups.`;

    } catch (error) {
        console.error(`❌ Error building schedule context for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'aiService', operation: 'buildScheduleContextForAI', sportKey });
        return `\n\n## VERIFIED SCHEDULE\nError retrieving verified game schedule. Proceed with caution using fundamental analysis and typical matchups, stating this limitation clearly.`;
    }
}

// Validates AI-proposed legs against the verified schedule
async function validateAILegsAgainstSchedule(sportKey, proposedLegs, hours) {
     if (!Array.isArray(proposedLegs) || proposedLegs.length === 0) {
        return { validatedLegs: [], validationRate: 0, totalProposed: 0 };
    }
    const totalProposed = proposedLegs.length;

    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (!Array.isArray(realGames) || realGames.length === 0) {
             console.warn(`⚠️ Schedule Validation: No real games found for ${sportKey} to validate against.`);
             return {
                 validatedLegs: proposedLegs.map(leg => ({ ...leg, real_game_validated: false, validation_error: "No schedule data available" })),
                 validationRate: 0,
                 totalProposed: totalProposed
             };
        }

        const realGameMap = new Map();
        realGames.forEach(game => {
            const normalize = (team) => (team || '').toLowerCase().trim().replace(/[\s.'-]/g, '');
            const awayNorm = normalize(game.away_team);
            const homeNorm = normalize(game.home_team);
            const key = `${awayNorm}@${homeNorm}`;
            realGameMap.set(key, game);
        });

        const validationResults = proposedLegs.map(leg => {
             if (typeof leg.event !== 'string' || leg.event.length === 0 || leg.event.toLowerCase() === 'unknown event') {
                console.warn(`⚠️ Schedule Validation Failed: AI proposed leg with invalid/missing event field: "${leg.event}"`);
                return { ...leg, real_game_validated: false, validation_error: "Invalid or missing 'event' field from AI" };
             }

             const normalize = (team) => (team || '').toLowerCase().trim().replace(/[\s.'-]/g, '');
             const eventParts = leg.event.split(/@|vs|at/i);
             let legEventKey = 'unknown@unknown';
             if (eventParts.length === 2) {
                 const awayNorm = normalize(eventParts[0]);
                 const homeNorm = normalize(eventParts[1]);
                 legEventKey = `${awayNorm}@${homeNorm}`;
             } else {
                 console.warn(`⚠️ Schedule Validation: Could not parse AI event string into Away@Home: "${leg.event}"`);
             }

             const matchedGame = realGameMap.get(legEventKey);
             const isValidated = !!matchedGame;
             let validationError = null;

             if (!isValidated) {
                 validationError = `Game not found in schedule (Key: ${legEventKey})`;
                 console.warn(`⚠️ Schedule Validation Failed: AI proposed leg for unverified/out-of-scope game: "${leg.event}" (Normalized key: ${legEventKey})`);
             }

             return {
                 ...leg,
                 real_game_validated: isValidated,
                 validation_error: validationError,
                 commence_time: isValidated ? matchedGame.commence_time : leg.commence_time,
                 verified_event_id: isValidated ? (matchedGame.event_id || matchedGame.id) : null
             };
        });

        const validatedCount = validationResults.filter(l => l.real_game_validated).length;
        const validationRate = totalProposed > 0 ? validatedCount / totalProposed : 0;
        console.log(`✅ Schedule Validation Complete for ${sportKey}: ${validatedCount}/${totalProposed} legs validated (${(validationRate * 100).toFixed(1)}%).`);

        return {
             validatedLegs: validationResults,
             validationRate: validationRate,
             totalProposed: totalProposed
        };

    } catch (error) {
        console.error(`❌ Schedule validation process failed critically for ${sportKey}:`, error.message, error.stack);
        sentryService.captureError(error, { component: 'aiService', operation: 'validateAILegsAgainstSchedule', sportKey });
        return {
             validatedLegs: proposedLegs.map(leg => ({ ...leg, real_game_validated: false, validation_error: "Internal validation error" })),
             validationRate: 0,
             totalProposed: totalProposed
        };
    }
}

class AIService {

  // Selects the AI provider based on configuration or simple logic
  _getAIProviderConfig() {
      const apiKeyStatus = env.API_KEY_STATUS || {};
      const isPerplexityValid = env.PERPLEXITY_API_KEY && !apiKeyStatus.criticalErrors?.some(e => e.includes('PERPLEXITY_API_KEY')) && !apiKeyStatus.warnings?.some(e => e.includes('PERPLEXITY_API_KEY'));
      const isGeminiValid = env.GOOGLE_GEMINI_API_KEY && !apiKeyStatus.criticalErrors?.some(e => e.includes('GOOGLE_GEMINI_API_KEY'));

       if (isPerplexityValid) {
           console.log("🤖 Using Perplexity AI provider.");
           return { config: AI_PROVIDERS.PERPLEXITY, apiKey: env.PERPLEXITY_API_KEY };
       } else if (isGeminiValid) {
           console.log("🤖 Using Google Gemini provider (Perplexity key invalid/missing or flagged).");
            return { config: AI_PROVIDERS.GEMINI, apiKey: env.GOOGLE_GEMINI_API_KEY };
       } else {
            console.error("❌ No valid & available AI API key found (Perplexity or Gemini). AI service disabled.");
           return { config: null, apiKey: null };
       }
  }

  async _callAIProvider(prompt, requestedModel = null) {
        const { config: providerConfig, apiKey } = this._getAIProviderConfig();

        if (!providerConfig || !apiKey) {
            throw new Error('No valid AI provider configured or API key available.');
        }

        const modelToUse = requestedModel || providerConfig.model;
        const apiUrl = typeof providerConfig.apiUrl === 'function'
            ? providerConfig.apiUrl(apiKey, modelToUse)
            : providerConfig.apiUrl;
        const payload = providerConfig.buildPayload(prompt, modelToUse);
        const headers = providerConfig.getHeaders(apiKey);

        console.log(`📡 Calling ${providerConfig.name} (Model: ${modelToUse})...`);

        try {
            const response = await withTimeout(
                axios.post(apiUrl, payload, { headers, timeout: WEB_TIMEOUT_MS }),
                WEB_TIMEOUT_MS + 2000,
                `${providerConfig.name}_API_Call`
            );

            const responseText = providerConfig.extractContent(response.data);

            console.info(`---------- RAW AI RESPONSE (${providerConfig.name}) ----------`);
            console.info(responseText);
            console.info(`---------------------------------------------------------`);

            if (!responseText) {
                console.error(`❌ ${providerConfig.name} returned empty response content.`);
                 console.error("Raw Response Data Snippet:", JSON.stringify(response.data)?.substring(0, 1000));
                throw new Error(`${providerConfig.name} returned empty or invalid response structure.`);
            }

            const parsedJson = extractJSON(responseText);
            if (!parsedJson) {
                 throw new Error(`AI response from ${providerConfig.name} did not contain parseable JSON that matches the expected structure. See raw log above.`);
            }

            // NEW: Normalize emoji symbols back to standard format
            const normalizedJson = normalizeEmojiSymbols(parsedJson);
            console.log(`✅ ${providerConfig.name} call successful. Emoji symbols normalized.`);
            
            return normalizedJson;

        } catch (error) {
            const status = error.response?.status;
            const errorData = error.response?.data;
            let errorMessage = error.message || 'Unknown AI Provider Error';

            if (error instanceof TimeoutError) {
                 errorMessage = `${providerConfig.name} API request timed out after ${WEB_TIMEOUT_MS / 1000}s.`;
                 console.error(`⏰ ${errorMessage}`);
            } else {
                 console.error(`❌ ${providerConfig.name} API Error: Status ${status || 'N/A'}`, errorData || error.message);
                 if (error.response?.data) {
                    try {
                        const rawErrorText = providerConfig.extractContent(error.response.data);
                        if(rawErrorText && typeof rawErrorText === 'string') {
                            console.error("--- AI Error Response Text Snippet ---\n", rawErrorText.substring(0,1000), "\n--------------------------");
                        } else {
                            console.error("--- AI Error Response Data Snippet ---\n", JSON.stringify(error.response.data)?.substring(0,1000), "\n--------------------------");
                        }
                    } catch (e) {
                        console.error("--- AI Error Response (unparseable) ---\n", error.response.data, "\n--------------------------");
                    }
                 }
            }

            if (status === 401 || status === 403) {
                errorMessage = `${providerConfig.name} API key invalid, expired, or lacks permissions (${status}). Check environment variables.`;
            } else if (status === 429) {
                 errorMessage = `${providerConfig.name} API rate limit exceeded (Status 429). Please wait and try again.`;
            } else if (status === 400) {
                 errorMessage = `${providerConfig.name} API Bad Request (Status 400). Check prompt structure or model compatibility. Raw error might be in logs.`;
            } else if (error.code === 'ECONNABORTED' && !(error instanceof TimeoutError)) {
                 errorMessage = `${providerConfig.name} API request connection timed out (${error.code}).`;
            }
             
             sentryService.captureError(error, {
                component: 'aiService', operation: '_callAIProvider', provider: providerConfig.name, model: modelToUse, status: status, level: 'error'
             });

            throw new Error(errorMessage);
        }
    }

  _ensureLegsHaveOdds(legs = []) {
    if (!Array.isArray(legs)) {
        console.warn("⚠️ _ensureLegsHaveOdds: Input 'legs' is not an array, returning empty array.");
        return [];
    }
    
    return legs.map((leg, index) => {
      if (!leg || typeof leg !== 'object') {
          console.warn(`⚠️ _ensureLegsHaveOdds: Leg at index ${index} is not a valid object. Skipping.`);
          return {
              selection: 'Invalid Leg Data',
              event: 'Invalid Leg Data',
              odds: { american: null },
              isValid: false
          };
      }

      let americanOdds = leg?.odds?.american;
      if (typeof americanOdds !== 'number' || !Number.isFinite(americanOdds)) {
        americanOdds = leg?.price;
      }

      const isValidNumber = typeof americanOdds === 'number' && Number.isFinite(americanOdds);

      const legSelection = leg?.selection;
      const legEvent = leg?.event;
      const isValidSelection = typeof legSelection === 'string' && legSelection.length > 0 && legSelection.toLowerCase() !== 'unknown selection';
      const isValidEvent = typeof legEvent === 'string' && legEvent.length > 0 && legEvent.toLowerCase() !== 'unknown event';

      if (isValidNumber && isValidSelection && isValidEvent) {
        let derivedOdds = { 
          ...leg.odds, 
          american: americanOdds
        };
        
        if (!derivedOdds.decimal || !Number.isFinite(derivedOdds.decimal)) {
          derivedOdds.decimal = ProbabilityCalculator.americanToDecimal(americanOdds);
        }
        if (!derivedOdds.implied_probability || !Number.isFinite(derivedOdds.implied_probability)) {
          derivedOdds.implied_probability = ProbabilityCalculator.impliedProbability(derivedOdds.decimal);
        }
        
        return { 
          ...leg, 
          odds: derivedOdds, 
          isValid: true 
        };
      }

      console.warn(`⚠️ AI leg invalid (Index ${index}). Selection: "${legSelection}" (Valid: ${isValidSelection}), Event: "${legEvent}" (Valid: ${isValidEvent}), Odds: ${americanOdds} (Valid: ${isValidNumber}). Available fields:`, 
        Object.keys(leg).filter(k => k !== 'quantum_analysis' && k !== 'market_signals'));
      
      sentryService.captureError(new Error("AI provided invalid leg details"), { 
        component: 'aiService', 
        operation: '_ensureLegsHaveOdds', 
        legData: { 
          selection: legSelection,
          event: legEvent, 
          americanOdds: americanOdds,
          availableFields: Object.keys(leg)
        }, 
        level: 'warning'
      });

      const defaultDecimal = ProbabilityCalculator.americanToDecimal(-110);
      const defaultedOdds = {
        american: isValidNumber ? americanOdds : -110,
        decimal: isValidNumber ? ProbabilityCalculator.americanToDecimal(americanOdds) : defaultDecimal,
        implied_probability: isValidNumber ? ProbabilityCalculator.impliedProbability(ProbabilityCalculator.americanToDecimal(americanOdds)) : ProbabilityCalculator.impliedProbability(defaultDecimal)
      };

      return {
        ...leg,
        selection: isValidSelection ? leg.selection : 'Unknown Selection',
        event: isValidEvent ? leg.event : 'Unknown Event',
        market: leg?.market || 'h2h',
        odds: defaultedOdds,
        quantum_analysis: {
          ...(leg?.quantum_analysis || {}),
          analytical_basis: `(Data defaulted due to missing/invalid AI output: Sel=${isValidSelection}, Evt=${isValidEvent}, Odds=${isValidNumber}) ${leg?.quantum_analysis?.analytical_basis || 'No rationale.'}`,
          confidence_score: leg?.quantum_analysis?.confidence_score ?? 30
        },
        isValid: false
      };
    }).filter(leg => leg.isValid);
  }

  async generateParlay(sportKey, numLegs, mode, aiModel, betType, options = {}) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      let generationStrategy = 'unknown';

      console.log(`🎯 Starting EV-Driven Parlay Generation [${requestId}] | Sport: ${sportKey} | Legs: ${numLegs} | Mode: ${mode} | Type: ${betType}`);
      
      if (!sportKey || typeof sportKey !== 'string') throw new Error("Invalid sportKey provided.");
      if (!numLegs || typeof numLegs !== 'number' || numLegs < 2 || numLegs > 8) throw new Error("Invalid number of legs (must be 2-8).");
      if (!['web', 'live', 'db'].includes(mode)) {
          console.warn(`⚠️ Invalid mode "${mode}", defaulting to 'web'.`);
          mode = 'web';
      }

      const horizonHours = options.horizonHours || DEFAULT_HORIZON_HOURS;
      const userConfig = options.userConfig || null;
      const scheduleContext = (mode === 'web' || mode === 'live') ? await buildScheduleContextForAI(sportKey, horizonHours) : null;
      const injuryContext = null;
      const promptContext = { scheduleInfo: scheduleContext, injuryReport: injuryContext, userConfig: userConfig };

      try {
          let rawAIParlayData;
          if (mode === 'web' || mode === 'live') {
              console.log(`🖥️ Using Web Research strategy (Mode: ${mode})`);
              generationStrategy = 'quantum_web_ev';
              const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, promptContext);
              rawAIParlayData = await this._callAIProvider(prompt);
          } else {
              console.log(`💾 Using Database (+EV Scan) strategy (Mode: ${mode})`);
              generationStrategy = 'database_quant_ev';
              rawAIParlayData = await this._generateDbQuantParlay(sportKey, numLegs, betType, horizonHours);
          }

          if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs)) {
              if (generationStrategy === 'database_quant_ev' && rawAIParlayData?.legs?.length === 0) {
                   console.log("✅ DB Quant: No +EV legs found meeting criteria.");
                   return rawAIParlayData;
              }
              console.error("❌ AI/DB response validation failed: 'legs' is not an array or is missing.", rawAIParlayData);
              throw new Error('AI/DB function failed to return valid structure (missing legs array).');
         }

          let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
          let validationRate = 1.0;
          let finalLegs = processedLegs;
          let validationResult = { validatedLegs: processedLegs, validationRate: 1.0, totalProposed: processedLegs.length };
          const originalLegCount = processedLegs.length;

          if (generationStrategy === 'quantum_web_ev') {
              validationResult = await validateAILegsAgainstSchedule(sportKey, processedLegs, horizonHours);
              validationRate = validationResult.validationRate;
              finalLegs = validationResult.validatedLegs.filter(leg => leg.real_game_validated);
              const removedCount = originalLegCount - finalLegs.length;
              if (removedCount > 0) {
                   console.warn(`⚠️ ${removedCount} leg(s) removed by schedule validation.`);
                   validationResult.validatedLegs.forEach((leg, idx) => {
                       if (!leg.real_game_validated) {
                           console.warn(`   - Leg ${idx+1} Failed: "${leg.event}" - ${leg.validation_error || 'Reason unknown'}`);
                       }
                   });
              }

              if (finalLegs.length < 2) {
                  console.error(`❌ Insufficient valid legs (${finalLegs.length}) after schedule validation (needed >= 2).`);
                  return this._createValidationFailureResponse(rawAIParlayData, validationResult.validatedLegs, generationStrategy, "Insufficient legs passed schedule validation.");
              }
          }

          console.log(`🔬 Performing final quantitative evaluation on ${finalLegs.length} leg(s)...`);
          const evaluationResult = await quantitativeService.evaluateParlay(finalLegs);

          if (evaluationResult.error || evaluationResult.summary?.verdict === 'REJECTED' || evaluationResult.riskAssessment?.overallRisk === 'REJECTED') {
               const reason = evaluationResult.error || evaluationResult.summary?.primaryAction || 'Quantitative rejection';
               console.warn(`❌ Parlay REJECTED by Quant Service. Reason: ${reason}`);
               return {
                   ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
                   legs: validationResult.validatedLegs,
                   ...evaluationResult,
                   research_metadata: { ...(rawAIParlayData.research_metadata || {}), quantitative_rejection: true, generationStrategy, validationRate: validationRate.toFixed(2) }
               };
          }

          const finalResult = {
              ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
              legs: finalLegs,
              combined_parlay_metrics: evaluationResult.combined_parlay_metrics,
              riskAssessment: evaluationResult.riskAssessment,
              recommendations: evaluationResult.recommendations,
              summary: evaluationResult.summary,
              research_metadata: {
                  ...(rawAIParlayData.research_metadata || {}),
                  generationStrategy: generationStrategy,
                  mode: mode,
                  validationRate: parseFloat(validationRate.toFixed(2)),
                  finalLegCount: finalLegs.length,
                  originalLegCount: originalLegCount
              },
              portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations
           };
           
           if (finalResult.parlay_metadata) finalResult.parlay_metadata.legs_count = finalLegs.length;

          console.log(`✅ Successfully generated/evaluated EV Parlay [${requestId}]. Verdict: ${finalResult.summary?.verdict}`);
          return finalResult;

      } catch (error) {
          console.error(`❌ EV Parlay Gen Failed Critically [${requestId}]:`, error.message, error.stack);
          sentryService.captureError(error, { component: 'aiService', operation: 'generateParlay_Overall', sportKey, mode, numLegs, generationStrategy: generationStrategy, level: 'error' });

          if (generationStrategy !== 'quantum_fallback_ev') {
              console.log(`🔄 Attempting FALLBACK for [${requestId}] due to error: ${error.message}`);
              try {
                  return await this._generateFallbackParlay(sportKey, numLegs, betType, promptContext);
              } catch (fallbackError) {
                  console.error(`❌ FALLBACK ALSO FAILED [${requestId}]:`, fallbackError.message);
                  sentryService.captureError(fallbackError, { component: 'aiService', operation: 'generateParlay_Fallback', sportKey, level: 'fatal' });
                  throw new Error(`AI analysis failed: Primary (${generationStrategy || 'unknown'}) failed with "${error.message}" AND fallback failed with "${fallbackError.message}".`);
              }
          } else {
               throw new Error(`AI fallback analysis failed: ${error.message}`);
          }
      }
  }

  // ... (rest of the methods remain the same - _findBestValuePlays, _generateDbQuantParlay, etc.)

}

// Export Singleton Instance
export default new AIService();

  // --- IMPLEMENTED DB Quant Logic for _findBestValuePlays ---
  async _findBestValuePlays(games, betType = 'h2h') {
    console.log(`🔍 Scanning ${games.length} games for +EV ${betType} plays...`);
    const valuePlays = [];

    try {
      for (const game of games) {
        if (!game || !game.bookmakers || !Array.isArray(game.bookmakers)) {
          continue;
        }

        // Process each bookmaker's markets
        for (const bookmaker of game.bookmakers) {
          if (!bookmaker.markets || !Array.isArray(bookmaker.markets)) continue;

          for (const market of bookmaker.markets) {
            // Focus on relevant markets based on betType
            const isRelevantMarket = 
              (betType === 'h2h' && market.key === 'h2h') ||
              (betType === 'spreads' && market.key === 'spreads') ||
              (betType === 'totals' && market.key === 'totals') ||
              (betType === 'any' && ['h2h', 'spreads', 'totals'].includes(market.key));

            if (!isRelevantMarket || !market.outcomes || !Array.isArray(market.outcomes)) {
              continue;
            }

            // Calculate no-vig probabilities for this market
            const marketAnalysis = this._calculateMarketNoVigProbabilities(market.outcomes);
            
            if (!marketAnalysis.noVigProbs) continue;

            // Evaluate each outcome for +EV
            market.outcomes.forEach((outcome, index) => {
              const noVigProb = marketAnalysis.noVigProbs[index];
              const decimalOdds = ProbabilityCalculator.americanToDecimal(outcome.price);
              
              if (noVigProb > 0 && decimalOdds > 1) {
                const ev = ProbabilityCalculator.calculateEVPercentage(decimalOdds, noVigProb);
                
                // Only consider positive EV plays with meaningful edge
                if (ev > 0.5) { // 0.5% minimum EV threshold
                  const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
                  const edge = (noVigProb / impliedProb - 1) * 100;
                  
                  valuePlays.push({
                    game: {
                      event_id: game.id,
                      commence_time: game.commence_time,
                      away_team: game.away_team,
                      home_team: game.home_team,
                      sport_key: game.sport_key,
                      source: bookmaker.title || 'Unknown Bookmaker'
                    },
                    market: market,
                    outcome: outcome,
                    bookmaker: bookmaker,
                    noVigProb: noVigProb,
                    ev: ev,
                    edge: edge,
                    decimalOdds: decimalOdds,
                    americanOdds: outcome.price,
                    impliedProbability: impliedProb,
                    marketOverround: marketAnalysis.overround,
                    timestamp: new Date().toISOString()
                  });
                }
              }
            });
          }
        }
      }

      // Sort by EV descending and remove duplicates (same game + outcome combination)
      const uniquePlays = this._deduplicateValuePlays(valuePlays);
      uniquePlays.sort((a, b) => b.ev - a.ev);
      
      console.log(`✅ Found ${uniquePlays.length} unique +EV plays from ${valuePlays.length} raw candidates`);
      return uniquePlays;

    } catch (error) {
      console.error('❌ Error in _findBestValuePlays:', error);
      sentryService.captureError(error, { 
        component: 'aiService', 
        operation: '_findBestValuePlays',
        betType,
        gamesCount: games?.length 
      });
      return [];
    }
  }

  // Helper: Calculate no-vig probabilities for a market
  _calculateMarketNoVigProbabilities(outcomes) {
    if (!outcomes || outcomes.length < 2) return { noVigProbs: null, overround: 0 };

    try {
      // Convert all outcomes to decimal odds and calculate implied probabilities
      const impliedProbs = outcomes.map(outcome => {
        const decimalOdds = ProbabilityCalculator.americanToDecimal(outcome.price);
        return ProbabilityCalculator.impliedProbability(decimalOdds);
      });

      // Calculate total market overround (sum of implied probabilities)
      const totalImpliedProb = impliedProbs.reduce((sum, prob) => sum + prob, 0);
      const overround = (totalImpliedProb - 1) * 100; // As percentage

      // Calculate no-vig probabilities (remove the overround)
      const noVigProbs = impliedProbs.map(prob => prob / totalImpliedProb);

      return { noVigProbs, overround };
    } catch (error) {
      console.warn('⚠️ Error calculating no-vig probabilities:', error);
      return { noVigProbs: null, overround: 0 };
    }
  }

  // Helper: Remove duplicate value plays (same game + outcome combination)
  _deduplicateValuePlays(plays) {
    const seen = new Map();
    
    return plays.filter(play => {
      const key = `${play.game.event_id}-${play.market.key}-${play.outcome.name}-${play.outcome.point || ''}`;
      
      if (!seen.has(key)) {
        seen.set(key, true);
        return true;
      }
      
      // If duplicate found, keep the one with better EV
      const existingIndex = plays.findIndex(p => 
        `${p.game.event_id}-${p.market.key}-${p.outcome.name}-${p.outcome.point || ''}` === key
      );
      
      if (existingIndex !== -1 && plays[existingIndex].ev < play.ev) {
        // Replace with better EV play (this is simplified - in practice you'd need to track indices)
        return true;
      }
      
      return false;
    });
  }

  async _generateDbQuantParlay(sportKey, numLegs, betType, horizonHours) {
        try {
            const allGames = await gamesService.getGamesForSport(sportKey, {
                hoursAhead: horizonHours,
                includeOdds: true, // Essential for EV
                useCache: false, // Use fresh data
            });

            if (!Array.isArray(allGames) || allGames.length === 0) {
                 console.warn(`⚠️ DB Quant: No games found for ${sportKey}.`);
                 return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', "No games available in database.");
            }

            console.log(`🔍 DB Quant: Scanning ${allGames.length} ${sportKey} games for +EV plays...`);
            // Call the (now implemented) method
            const bestPlays = await this._findBestValuePlays(allGames, betType);
             if (!Array.isArray(bestPlays)) { // Add check for safety
                 console.error("❌ _findBestValuePlays did not return an array.");
                 throw new Error("_findBestValuePlays implementation error.");
             }

            if (bestPlays.length === 0) {
                 console.log(`🚫 DB Quant: No +EV plays found for ${sportKey}.`);
                 return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `No profitable (+EV) bets found among ${allGames.length} games.`);
            }

            console.log(`✅ DB Quant: Found ${bestPlays.length} +EV plays. Selecting top ${Math.min(numLegs, bestPlays.length)}.`);
            const topPlays = bestPlays.slice(0, numLegs); // Take up to numLegs

            // Format legs for quantitativeService, filtering out nulls from potential invalid plays
            const parlayLegs = topPlays.map(play => this._formatPlayAsLeg(play, sportKey)).filter(Boolean);

            if (parlayLegs.length < 2) {
                console.warn(`⚠️ DB Quant: Fewer than 2 valid +EV legs found after formatting. Cannot create parlay.`);
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `Fewer than 2 valid +EV legs found.`);
            }

            // Return a structure similar to AI output, but without calling external AI
            // Quantitative service will evaluate this structure later in the main generateParlay flow
             const parlayData = {
                legs: parlayLegs,
                parlay_metadata: {
                    sport: gamesService._formatSportKey ? gamesService._formatSportKey(sportKey) : sportKey, // Use helper if available
                    sport_key: sportKey,
                    legs_count: parlayLegs.length,
                    bet_type: betType,
                    analyst_tier: "QUANTITATIVE (DB Scan)",
                    generated_at: new Date().toISOString(),
                    data_sources_used: ["Internal Database", "Cache"],
                },
                 portfolio_construction: {
                    overall_thesis: `Constructed from the top ${parlayLegs.length} +EV bets identified via database scan and no-vig calculation.`,
                     key_risk_factors: ["Based on cached/DB odds, verify live prices", "Model is simple no-vig calc"],
                     clv_plan: "Verify odds match or beat calculated price before betting."
                },
                 research_metadata: { // Add metadata specific to this mode
                    mode: 'db',
                    generationStrategy: 'database_quant_ev',
                    games_scanned: allGames.length,
                    ev_plays_found: bestPlays.length,
                    legs_used: parlayLegs.length,
                }
                // quantitative_analysis will be added by the main function after calling quantitativeService.evaluateParlay
            };
            return parlayData;

        } catch (error) {
            console.error(`❌ DB Quant mode failed critically for ${sportKey}:`, error.message);
            sentryService.captureError(error, { component: 'aiService', operation: '_generateDbQuantParlay', sportKey, level: 'error' });
            // Return empty structure on failure
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `Error during database analysis: ${error.message}`);
        }
    }

    // Helper to format DB play into AI leg structure
     _formatPlayAsLeg(play, sportKey) {
        // Add safety checks for potentially missing data in 'play'
        const price = play?.outcome?.price;
        const noVigProb = play?.noVigProb;
        const game = play?.game;
        const market = play?.market;
        const outcome = play?.outcome;

        if (typeof price !== 'number' || !Number.isFinite(price) || typeof noVigProb !== 'number' || !Number.isFinite(noVigProb) || !game || !market || !outcome || !game.event_id || !game.away_team || !game.home_team) {
            console.warn("⚠️ _formatPlayAsLeg: Invalid or incomplete play data provided:", play);
            return null; // Return null for invalid plays
        }

        const decimalOdds = ProbabilityCalculator.americanToDecimal(price);
        const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
        // Ensure edge calculation doesn't divide by zero or result in NaN
        const edge = (impliedProb > 0) ? (noVigProb / impliedProb - 1) * 100 : 0;
        const ev = play.ev ?? ProbabilityCalculator.calculateEVPercentage(decimalOdds, noVigProb); // Use provided EV or calculate

        return {
            event: `${game.away_team} @ ${game.home_team}`, // Standard format
            selection: `${outcome.name} ${outcome.point ?? ''}`.trim(), // Actual pick
            sportsbook: game.source || 'Database Odds', // Source from game data
            market_type: market.key,
            line: outcome.point ?? null, // Use null if point is undefined/0
            price: price, // Already validated as number
            region: 'us', // Assuming US region for DB data
            timestamp: game.last_updated || new Date().toISOString(), // Use game update time if available
            implied_probability: parseFloat(impliedProb.toFixed(4)),
            model_probability: parseFloat(noVigProb.toFixed(4)), // Use no-vig as model prob
            edge_percent: parseFloat(edge.toFixed(2)),
            ev_per_100: parseFloat(ev.toFixed(2)), // Use calculated/provided EV
            kelly_fraction_full: parseFloat(ProbabilityCalculator.kellyFraction(decimalOdds, noVigProb).toFixed(4)),
            clv_target_price: null, // Cannot easily determine CLV target from DB odds alone
            injury_gates: null, // DB mode doesn't have live injury checks
            market_signals: null, // DB mode doesn't have live market signals
            correlation_notes: "Assumed low correlation (cross-game).", // Basic assumption
            // Keep original odds structure too for potential display/consistency
            odds: {
                american: price,
                decimal: decimalOdds,
                implied_probability: parseFloat(impliedProb.toFixed(4))
             },
            // Add other fields that might be useful downstream or expected by quant service
             commence_time: game.commence_time,
             gameId: game.event_id, // Consistent ID field
             sport_key: sportKey,
             real_game_validated: true // Assume DB games are valid
        };
    }

   // Helper to create a consistent empty/failed response
    _createEmptyParlayResponse(sportKey, numLegs, betType, mode, reason) {
         const formattedSport = gamesService?._formatSportKey ? gamesService._formatSportKey(sportKey) : sportKey;
         return {
            legs: [],
            parlay_metadata: { sport: formattedSport, sport_key: sportKey, legs_count: 0, bet_type: betType, analysis_mode: mode, generated_at: new Date().toISOString() },
            combined_parlay_metrics: null,
            riskAssessment: { overallRisk: 'REJECTED', risks:[{ type: 'GENERATION', severity: 'CRITICAL', message: reason }] },
            recommendations: { primaryAction: `DO NOT BET. ${reason}` },
            summary: { verdict: 'REJECTED', primaryAction: reason },
            portfolio_construction: { overall_thesis: reason },
            research_metadata: { mode, generationStrategy: mode === 'db' ? 'database_quant_ev' : 'unknown', generation_failed_reason: reason }
         };
    }

   // Helper for validation failures leading to < 2 legs
    _createValidationFailureResponse(originalData, validatedLegsWithFlags, generationStrategy, reason) { // Pass original legs
        return {
            ...(originalData.parlay_metadata ? { parlay_metadata: originalData.parlay_metadata } : {}),
            legs: validatedLegsWithFlags, // Show original legs with validation flags
            combined_parlay_metrics: null,
            riskAssessment: { overallRisk: 'REJECTED', risks: [{type: 'VALIDATION', severity: 'CRITICAL', message: reason}] },
            recommendations: { primaryAction: `DO NOT BET. ${reason}` },
            summary: { verdict: 'REJECTED', primaryAction: reason },
            research_metadata: { ...(originalData.research_metadata || {}), validation_failed_insufficient_legs: true, generationStrategy }
        };
    }

  async _generateFallbackParlay(sportKey, numLegs, betType, context = {}) {
      console.warn(`⚠️ Triggering FALLBACK generation (EV-Driven) for ${sportKey} (${numLegs} legs, ${betType})`);
      const generationStrategy = 'quantum_fallback_ev'; // Specific strategy name
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, context);

       try {
           const rawAIParlayData = await this._callAIProvider(prompt); // Use default model

            // --- Basic Structure Validation ---
           if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs) || rawAIParlayData.legs.length === 0) {
               console.error("❌ Fallback AI response lacked valid 'legs' array or returned empty:", rawAIParlayData);
               throw new Error('Fallback AI failed to provide a valid parlay structure.');
           }

            // --- Process Legs ---
           let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
            // Ensure correct number of legs (slice if AI gave too many)
            processedLegs = processedLegs.slice(0, numLegs);
            // Mark legs as unvalidated (critical for fallback)
           processedLegs = processedLegs.map(leg => ({ ...leg, real_game_validated: false, timestamp: new Date().toISOString() })); // Add timestamp

            // --- Final Quantitative Evaluation ---
           console.log(`🔬 Evaluating FALLBACK parlay with ${processedLegs.length} leg(s)...`);
            // Use quantitativeService even for fallback to get EV/Kelly based on AI *estimates*
           const evaluationResult = await quantitativeService.evaluateParlay(processedLegs);

           // Check if quantitative evaluation itself failed
            if (evaluationResult.error) {
                console.error(`❌ Quantitative evaluation failed during fallback for ${sportKey}:`, evaluationResult.error);
                // Return an error structure indicating quant failure during fallback
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'fallback', `Quantitative analysis failed during fallback: ${evaluationResult.error}`);
            }

            // --- Assemble Final Result ---
           const finalResult = {
               ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
               legs: processedLegs,
               combined_parlay_metrics: evaluationResult.combined_parlay_metrics,
               riskAssessment: evaluationResult.riskAssessment,
               recommendations: evaluationResult.recommendations,
               summary: evaluationResult.summary,
               portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations,
               research_metadata: {
                   ...(rawAIParlayData.research_metadata || {}),
                   fallback_used: true,
                   generationStrategy: generationStrategy,
                   validationRate: 0.00, // Explicitly 0% validation
                   finalLegCount: processedLegs.length,
                   note: 'Generated using fundamental analysis & ESTIMATED odds/probabilities without real-time data or validation.'
               },
               error: null // No error from quant service if we got here
           };

            // Adjust metadata/summary for fallback context
            if (finalResult.parlay_metadata) {
                finalResult.parlay_metadata.analysis_mode = "FALLBACK";
                 finalResult.parlay_metadata.legs_count = processedLegs.length;
            }
             if (finalResult.summary) {
                finalResult.summary.confidence = 'LOW'; // Override confidence to LOW for fallback
                 finalResult.summary.verdict = finalResult.summary.verdict === 'POSITIVE_EV' ? 'FALLBACK_POSITIVE_EV' : finalResult.summary.verdict; // Distinguish fallback EV
            }
             if (finalResult.recommendations?.primaryAction && !finalResult.recommendations.primaryAction.includes("FALLBACK")) {
                 finalResult.recommendations.primaryAction = `[FALLBACK MODE] ${finalResult.recommendations.primaryAction} Strongly advise caution & verification.`;
             }
             // Ensure high risk due to fallback nature
            if (finalResult.riskAssessment && finalResult.riskAssessment.overallRisk !== 'REJECTED') {
                 finalResult.riskAssessment.overallRisk = 'HIGH';
                 // Add or ensure the fallback risk note is present
                 if (!finalResult.riskAssessment.risks.some(r => r.type === 'DATA_SOURCE')) {
                     finalResult.riskAssessment.risks.push({ type: 'DATA_SOURCE', severity: 'HIGH', message: 'Parlay generated in fallback mode with estimated data.', impact: 'EV and probabilities are estimates, actual risk may be higher.' });
                 }
             }

            console.log(`✅ Fallback generation completed for ${sportKey}. Verdict: ${finalResult.summary?.verdict}`);
            return finalResult;

        } catch (fallbackError) {
             console.error(`❌ FallBACK generation failed critically [${sportKey}]:`, fallbackError.message);
             sentryService.captureError(fallbackError, { component: 'aiService', operation: '_generateFallbackParlay', sportKey, level: 'fatal' });
             // If fallback itself fails, return a structured error response
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'fallback', `Fallback AI analysis failed: ${fallbackError.message}`);
        }
    }

  // --- Generic Chat Function (Example) ---
    async genericChat(modelIdentifier, messages) {
     console.log(`💬 Calling generic chat with model identifier: ${modelIdentifier}`);
     // Simple pass-through for now, assuming modelIdentifier maps directly or using default
     // Requires _callAIProvider to handle non-JSON responses gracefully if needed
     try {
         // Construct a basic prompt for chat
         const systemPrompt = "You are a helpful assistant.";
         const chatHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');
         const fullPrompt = `${systemPrompt}\n${chatHistory}\nassistant:`; // Structure for some models

         // Use a chat-optimized model if available, otherwise default
         const chatModel = AI_PROVIDERS.PERPLEXITY.model; // Or select based on modelIdentifier
         const responseJsonOrText = await this._callAIProvider(fullPrompt, chatModel);

         // Handle potential JSON vs Text response based on provider/model
         if (typeof responseJsonOrText === 'string') {
             return responseJsonOrText; // Assume plain text response for chat
         } else if (responseJsonOrText && (responseJsonOrText.text || responseJsonOrText.content)) {
            // Extract text if provider returned structured JSON
            return responseJsonOrText.text || responseJsonOrText.content;
         } else {
             // Fallback if unexpected structure
             return JSON.stringify(responseJsonOrText) || 'Could not parse chat response.';
         }
     } catch (error) {
          console.error(`❌ Generic chat failed: ${error.message}`);
          sentryService.captureError(error, { component: 'aiService', operation: 'genericChat' });
          return `Sorry, I encountered an error during chat: ${error.message}`;
     }
  }

 // --- Validate Odds (Enhanced) ---
 async validateOdds(oddsData) {
     if (!Array.isArray(oddsData)) {
         return { 
             valid: false, 
             message: "Input is not an array.",
             details: { type: typeof oddsData }
         };
     }

     try {
         const validationResults = oddsData.map((game, index) => {
             const hasBookmakers = Array.isArray(game.bookmakers) && game.bookmakers.length > 0;
             const hasValidTeams = game.away_team && game.home_team;
             const hasCommenceTime = game.commence_time;
             
             let marketDetails = {};
             if (hasBookmakers) {
                 game.bookmakers.forEach((bookmaker, bmIndex) => {
                     if (bookmaker.markets) {
                         marketDetails[bookmaker.title || `bookmaker_${bmIndex}`] = 
                             bookmaker.markets.map(m => m.key).join(', ');
                     }
                 });
             }

             return {
                 gameIndex: index,
                 valid: hasBookmakers && hasValidTeams && hasCommenceTime,
                 hasBookmakers,
                 bookmakerCount: hasBookmakers ? game.bookmakers.length : 0,
                 hasValidTeams,
                 hasCommenceTime,
                 teams: hasValidTeams ? `${game.away_team} @ ${game.home_team}` : 'Invalid',
                 markets: marketDetails
             };
         });

         const validGames = validationResults.filter(r => r.valid);
         const overallValid = validGames.length > 0;

         return {
             valid: overallValid,
             message: overallValid 
                 ? `Found ${validGames.length} valid games with odds data.` 
                 : 'No valid games with bookmaker data found.',
             details: {
                 totalGames: oddsData.length,
                 validGames: validGames.length,
                 validationResults,
                 sampleValidGame: validGames[0] || null
             }
         };

     } catch (error) {
         console.error('❌ Error in validateOdds:', error);
         return {
             valid: false,
             message: `Validation error: ${error.message}`,
             error: error.toString()
         };
     }
 }

} // End AIService Class

// Export Singleton Instance
export default new AIService();
