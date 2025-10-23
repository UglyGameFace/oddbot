// src/services/aiService.js - EV-DRIVEN UPDATE (Complete File with Fixes + RAW LOGGING + Validation Improvements)
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService, { ProbabilityCalculator } from './quantitativeService.js'; // Import calculator too
import { ElitePromptService } from './elitePromptService.js';
import { toDecimalFromAmerican, toAmericanFromDecimal } from '../utils/botUtils.js';
import { TimeoutError, withTimeout } from '../utils/asyncUtils.js';
import { sentryService } from './sentryService.js'; // Ensure correct import

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 45000; // Increased timeout for potentially complex AI responses
const DEFAULT_HORIZON_HOURS = 72; // Default time horizon for fetching games

// AI Model Configuration (Centralized)
const AI_PROVIDERS = {
    PERPLEXITY: {
        name: 'Perplexity AI',
        model: 'sonar-pro', // Or 'sonar-small-online' for faster/cheaper web research
        apiUrl: 'https://api.perplexity.ai/chat/completions',
        buildPayload: (prompt, model) => ({
             model: model,
             // Stricter system prompt for JSON adherence
             messages: [
                 { role: 'system', content: 'Return ONLY valid JSON matching the exact schema requested in the user prompt. No introductory text, explanations, apologies, or code fences unless the schema explicitly requires string content there.' },
                 { role: 'user', content: prompt }
             ]
         }),
        extractContent: (responseData) => responseData?.choices?.[0]?.message?.content || '',
        getHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` })
    },
    GEMINI: {
        name: 'Google Gemini',
        // Use a model capable of function calling/strict output if needed, Flash might work for JSON
        model: 'gemini-1.5-flash-latest',
        apiUrl: (apiKey, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        buildPayload: (prompt /*, model */) => ({ // Model included in URL for Gemini
            // Ensure prompt structure adheres to Gemini's content format
             contents: [{ parts: [{ text: prompt }] }],
             // Enforce JSON output using Gemini's specific feature
             generationConfig: {
                responseMimeType: "application/json",
             }
         }),
        extractContent: (responseData) => responseData?.candidates?.[0]?.content?.parts?.[0]?.text || '',
        getHeaders: (/* apiKey */) => ({ 'Content-Type': 'application/json' }) // API key is in URL
    }
    // Add other providers here if needed
};

// Helper to calculate parlay odds (Decimal)
function calculateParlayDecimal(legs = []) {
    // Filter out legs without valid numeric American odds before calculating
    const validLegs = legs.filter(leg => typeof leg?.odds?.american === 'number' && Number.isFinite(leg.odds.american));
    if (validLegs.length === 0) return 1.0; // Return 1.0 (even money) if no valid legs

    return validLegs.reduce((acc, leg) => {
        // Use ProbabilityCalculator directly now that it's imported
        const decimal = ProbabilityCalculator.americanToDecimal(leg.odds.american);
        // If conversion results in invalid decimal (e.g., from odds=0), treat as 1.0 multiplier
        return acc * (decimal > 1 ? decimal : 1.0);
    }, 1.0); // Start accumulator at 1.0
}

// Robust JSON extraction
function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    text = text.trim();

    // 1. Check if the entire string is valid JSON
    try {
        // Attempt to parse the whole string first - Gemini might return pure JSON with mime type enforcement
        return JSON.parse(text);
    } catch { /* Ignore */ }

    // 2. Look for Markdown code fences (```json ... ```)
    const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            console.warn("⚠️ Failed to parse content within JSON code fence:", e.message);
            // Continue trying other methods
        }
    }

    // 3. Look for the outermost '{' and '}' brackets
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(text.substring(firstBrace, lastBrace + 1));
        } catch (e) {
            console.warn("⚠️ Failed to parse content between first and last braces:", e.message);
        }
    }

    // 4. If all else fails, log the failure and return null
    console.error("❌ Failed to extract valid JSON from AI response. Response start:", text.substring(0, 200));
    sentryService.captureError(new Error("Failed JSON Extraction from AI"), { level: "warning", extra: { responseSample: text.substring(0, 500) } });
    return null;
}

// Fetches verified schedule to provide context to the AI
async function buildScheduleContextForAI(sportKey, hours) {
    try {
        // Use gamesService to get verified games (handles internal fallbacks)
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);

        if (!Array.isArray(realGames) || realGames.length === 0) {
            console.warn(`⚠️ No verified games found for ${sportKey} within ${hours}h for AI context.`);
            // Provide a clear note for the AI
            return `\n\n## VERIFIED SCHEDULE\nNo verified games found for ${sportKey} in the next ${hours} hours. Base analysis on typical matchups, team strengths, and standard scheduling patterns, but clearly state this limitation.`;
        }

        const gameList = realGames
            .slice(0, 20) // Limit context size
            .map((game, index) => {
                const timeStr = new Date(game.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                // *** Make context match normalization: Away@Home ***
                return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
            })
            .join('\n');

        return `\n\n## VERIFIED SCHEDULE (Next ${hours} hours - ${realGames.length} total games)\n${gameList}\n\n**CRITICAL: Base your parlay legs ONLY on games from this verified list using the exact "Away Team @ Home Team" format.** Reject any other potential matchups.`;

    } catch (error) {
        console.error(`❌ Error building schedule context for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'aiService', operation: 'buildScheduleContextForAI', sportKey });
        // Provide a fallback message indicating the data issue
        return `\n\n## VERIFIED SCHEDULE\nError retrieving verified game schedule. Proceed with caution using fundamental analysis and typical matchups, stating this limitation clearly.`;
    }
}

// Validates AI-proposed legs against the verified schedule
async function validateAILegsAgainstSchedule(sportKey, proposedLegs, hours) {
     if (!Array.isArray(proposedLegs) || proposedLegs.length === 0) {
        return { validatedLegs: [], validationRate: 0, totalProposed: 0 }; // Nothing to validate
    }
    const totalProposed = proposedLegs.length;

    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (!Array.isArray(realGames) || realGames.length === 0) {
             console.warn(`⚠️ Schedule Validation: No real games found for ${sportKey} to validate against.`);
             // Mark all as unvalidated
             return {
                 validatedLegs: proposedLegs.map(leg => ({ ...leg, real_game_validated: false, validation_error: "No schedule data available" })),
                 validationRate: 0,
                 totalProposed: totalProposed
             };
        }

        // Create a map for efficient lookup, normalizing team names
        const realGameMap = new Map();
        realGames.forEach(game => {
            // *** More robust normalization. Lowercase, remove spaces/punctuation, use '@'. ***
            const normalize = (team) => (team || '').toLowerCase().trim().replace(/[\s.'-]/g, '');
            const awayNorm = normalize(game.away_team);
            const homeNorm = normalize(game.home_team);
            const key = `${awayNorm}@${homeNorm}`;
            realGameMap.set(key, game); // Store the full game object
        });
        // console.log("DEBUG: Real Game Map Keys:", Array.from(realGameMap.keys())); // Uncomment for debugging

        // Validate each proposed leg
        const validationResults = proposedLegs.map(leg => {
             // *** Check for invalid leg.event string early ***
             if (typeof leg.event !== 'string' || leg.event.length === 0 || leg.event.toLowerCase() === 'unknown event') {
                console.warn(`⚠️ Schedule Validation Failed: AI proposed leg with invalid/missing event field: "${leg.event}"`);
                return { ...leg, real_game_validated: false, validation_error: "Invalid or missing 'event' field from AI" }; // Mark as invalid immediately
             }

             // *** More robust normalization for AI string. Use same logic as map keys. ***
             const normalize = (team) => (team || '').toLowerCase().trim().replace(/[\s.'-]/g, '');
             const eventParts = leg.event.split(/@|vs|at/i); // Split on common separators
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
             } else {
                 //console.log(`✅ Schedule Validation Success: Matched "${leg.event}" to map key ${legEventKey}`);
             }

             // Return leg with validation status and potentially updated data from verified source
             return {
                 ...leg,
                 real_game_validated: isValidated,
                 validation_error: validationError, // Add error reason
                 // If validated, ensure commence_time matches the verified game
                 commence_time: isValidated ? matchedGame.commence_time : leg.commence_time,
                 // Add verified event ID if useful downstream
                 verified_event_id: isValidated ? (matchedGame.event_id || matchedGame.id) : null
             };
        });

        const validatedCount = validationResults.filter(l => l.real_game_validated).length;
        const validationRate = totalProposed > 0 ? validatedCount / totalProposed : 0;
        console.log(`✅ Schedule Validation Complete for ${sportKey}: ${validatedCount}/${totalProposed} legs validated (${(validationRate * 100).toFixed(1)}%).`);

        return {
             validatedLegs: validationResults, // Return all legs, marked with status
             validationRate: validationRate,
             totalProposed: totalProposed
        };

    } catch (error) {
        console.error(`❌ Schedule validation process failed critically for ${sportKey}:`, error.message, error.stack);
        sentryService.captureError(error, { component: 'aiService', operation: 'validateAILegsAgainstSchedule', sportKey });
        // On error, mark all as unvalidated
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
      // Simple logic: Prefer Perplexity if key is valid, else try Gemini
       const apiKeyStatus = env.API_KEY_STATUS || {};
       // Check if key exists AND is not flagged as bad
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
           return { config: null, apiKey: null }; // Indicate no provider available
       }
  }

  async _callAIProvider(prompt, requestedModel = null) {
        const { config: providerConfig, apiKey } = this._getAIProviderConfig();

        if (!providerConfig || !apiKey) {
            throw new Error('No valid AI provider configured or API key available.');
        }

        const modelToUse = requestedModel || providerConfig.model; // Use requested or provider default
        const apiUrl = typeof providerConfig.apiUrl === 'function'
            ? providerConfig.apiUrl(apiKey, modelToUse) // For Gemini-like APIs where key/model is in URL
            : providerConfig.apiUrl;
        const payload = providerConfig.buildPayload(prompt, modelToUse);
        const headers = providerConfig.getHeaders(apiKey);

        console.log(`📡 Calling ${providerConfig.name} (Model: ${modelToUse})...`);

        try {
            // Use withTimeout for the axios call
            const response = await withTimeout(
                axios.post(apiUrl, payload, { headers, timeout: WEB_TIMEOUT_MS }),
                WEB_TIMEOUT_MS + 2000, // Add a small buffer to the outer timeout
                `${providerConfig.name}_API_Call`
            );

            const responseText = providerConfig.extractContent(response.data);

            // *** FIX: ADD RAW LOGGING ***
            // Use console.info for less alarming logs, but keep visible
            console.info(`---------- RAW AI RESPONSE (${providerConfig.name}) ----------`);
            console.info(responseText); // Log the raw text
            console.info(`---------------------------------------------------------`);
            // *** END FIX ***

            if (!responseText) {
                console.error(`❌ ${providerConfig.name} returned empty response content.`);
                 // Log details if possible
                 console.error("Raw Response Data Snippet:", JSON.stringify(response.data)?.substring(0, 1000));
                throw new Error(`${providerConfig.name} returned empty or invalid response structure.`);
            }

            const parsedJson = extractJSON(responseText);
            if (!parsedJson) {
                // Error logged by extractJSON
                 throw new Error(`AI response from ${providerConfig.name} did not contain parseable JSON that matches the expected structure. See raw log above.`);
            }

            console.log(`✅ ${providerConfig.name} call successful.`);
            return parsedJson;

        } catch (error) {
            const status = error.response?.status;
            const errorData = error.response?.data;
            let errorMessage = error.message || 'Unknown AI Provider Error';

            // Improve error logging and messages
            if (error instanceof TimeoutError) {
                 errorMessage = `${providerConfig.name} API request timed out after ${WEB_TIMEOUT_MS / 1000}s.`;
                 console.error(`⏰ ${errorMessage}`);
            } else {
                 console.error(`❌ ${providerConfig.name} API Error: Status ${status || 'N/A'}`, errorData || error.message);
                 // *** FIX: Log raw error text if available ***
                 if (error.response?.data) {
                    try {
                        // Attempt to extract content even on error
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
                 // Often indicates a bad request / prompt issue
                 errorMessage = `${providerConfig.name} API Bad Request (Status 400). Check prompt structure or model compatibility. Raw error might be in logs.`;
            } else if (error.code === 'ECONNABORTED' && !(error instanceof TimeoutError)) {
                 // Network level timeout, potentially different from application timeout
                 errorMessage = `${providerConfig.name} API request connection timed out (${error.code}).`;
            }
             // Log structured error to Sentry using captureError
             sentryService.captureError(error, {
                component: 'aiService', operation: '_callAIProvider', provider: providerConfig.name, model: modelToUse, status: status, level: 'error'
             });

            // Throw a consistent error format
            throw new Error(errorMessage);
        }
    }

  _ensureLegsHaveOdds(legs = []) { // Add default value
    if (!Array.isArray(legs)) {
        console.warn("⚠️ _ensureLegsHaveOdds: Input 'legs' is not an array, returning empty array.");
        return [];
    }
    return legs.map((leg, index) => {
      // Check if leg itself is a valid object
      if (!leg || typeof leg !== 'object') {
          console.warn(`⚠️ _ensureLegsHaveOdds: Leg at index ${index} is not a valid object. Skipping.`);
          // Optionally return a default invalid structure or filter out later
          return { // Return a minimal invalid structure
              selection: 'Invalid Leg Data',
              event: 'Invalid Leg Data',
              odds: { american: null },
              isValid: false // Flag to filter later if needed
          };
      }

      // More robust check for valid odds structure and numeric value
      const americanOdds = leg?.odds?.american;
      const isValidNumber = typeof americanOdds === 'number' && Number.isFinite(americanOdds);

      // *** FIX: Check for invalid selection/event strings ***
      const legSelection = leg?.selection;
      const legEvent = leg?.event;
      const isValidSelection = typeof legSelection === 'string' && legSelection.length > 0 && legSelection.toLowerCase() !== 'unknown selection';
      const isValidEvent = typeof legEvent === 'string' && legEvent.length > 0 && legEvent.toLowerCase() !== 'unknown event';

      if (isValidNumber && isValidSelection && isValidEvent) {
        // Leg seems valid, ensure derived odds fields exist
        let derivedOdds = { ...leg.odds }; // Copy existing odds
        if (!derivedOdds.decimal || !Number.isFinite(derivedOdds.decimal)) {
             derivedOdds.decimal = ProbabilityCalculator.americanToDecimal(americanOdds);
        }
         if (!derivedOdds.implied_probability || !Number.isFinite(derivedOdds.implied_probability)) {
             derivedOdds.implied_probability = ProbabilityCalculator.impliedProbability(derivedOdds.decimal);
         }
        return { ...leg, odds: derivedOdds, isValid: true }; // Mark as valid
      }

      // *** FIX: Log which check failed ***
      console.warn(`⚠️ AI leg invalid (Index ${index}). Selection: "${legSelection}" (Valid: ${isValidSelection}), Event: "${legEvent}" (Valid: ${isValidEvent}), Odds: ${americanOdds} (Valid: ${isValidNumber}). Defaulting...`);
      sentryService.captureError(new Error("AI provided invalid leg details"), { component: 'aiService', operation: '_ensureLegsHaveOdds', legData: leg, level: 'warning'});

      // Return a structured leg with default odds and placeholders
      const defaultDecimal = ProbabilityCalculator.americanToDecimal(-110);
      const defaultedOdds = {
            american: isValidNumber ? americanOdds : -110, // Use provided odds if valid number, else default
            decimal: isValidNumber ? ProbabilityCalculator.americanToDecimal(americanOdds) : defaultDecimal,
            implied_probability: isValidNumber ? ProbabilityCalculator.impliedProbability(ProbabilityCalculator.americanToDecimal(americanOdds)) : ProbabilityCalculator.impliedProbability(defaultDecimal)
         };

      return {
        ...leg, // Keep other leg data if present
        selection: isValidSelection ? leg.selection : 'Unknown Selection', // Use 'Unknown' placeholders
        event: isValidEvent ? leg.event : 'Unknown Event',                 // Use 'Unknown' placeholders
        market: leg?.market || 'h2h',
        odds: defaultedOdds, // Use the potentially defaulted odds
        // Annotate the rationale
        quantum_analysis: {
            ...(leg?.quantum_analysis || {}), // Keep existing analysis if present
            analytical_basis: `(Data defaulted due to missing/invalid AI output: Sel=${isValidSelection}, Evt=${isValidEvent}, Odds=${isValidNumber}) ${leg?.quantum_analysis?.analytical_basis || 'No rationale.'}`,
            confidence_score: leg?.quantum_analysis?.confidence_score ?? 30 // Lower default confidence for defaulted legs
        },
        isValid: false // Mark as invalid due to defaulting
      };
    }).filter(leg => leg.isValid); // Filter out completely invalid leg structures here
  }

  async generateParlay(sportKey, numLegs, mode, aiModel /* Ignored */, betType, options = {}) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      let generationStrategy = 'unknown';

      console.log(`🎯 Starting EV-Driven Parlay Generation [${requestId}] | Sport: ${sportKey} | Legs: ${numLegs} | Mode: ${mode} | Type: ${betType}`);
      // Input Validation
      if (!sportKey || typeof sportKey !== 'string') throw new Error("Invalid sportKey provided.");
      if (!numLegs || typeof numLegs !== 'number' || numLegs < 2 || numLegs > 8) throw new Error("Invalid number of legs (must be 2-8).");
      if (!['web', 'live', 'db'].includes(mode)) {
          console.warn(`⚠️ Invalid mode "${mode}", defaulting to 'web'.`);
          mode = 'web';
      }

      // Prepare Context
      const horizonHours = options.horizonHours || DEFAULT_HORIZON_HOURS;
      const userConfig = options.userConfig || null;
      // Fetch schedule context ONLY if needed (web/live modes)
      const scheduleContext = (mode === 'web' || mode === 'live') ? await buildScheduleContextForAI(sportKey, horizonHours) : null;
      const injuryContext = null; // Placeholder - implement fetching if needed
      const promptContext = { scheduleInfo: scheduleContext, injuryReport: injuryContext, userConfig: userConfig };

      try {
          let rawAIParlayData;
          // Select Generation Strategy
          if (mode === 'web' || mode === 'live') {
              console.log(`🖥️ Using Web Research strategy (Mode: ${mode})`);
              generationStrategy = 'quantum_web_ev'; // Assign strategy
              const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, promptContext);
              rawAIParlayData = await this._callAIProvider(prompt);
          } else { // mode === 'db'
              console.log(`💾 Using Database (+EV Scan) strategy (Mode: ${mode})`);
              generationStrategy = 'database_quant_ev'; // Assign strategy
              rawAIParlayData = await this._generateDbQuantParlay(sportKey, numLegs, betType, horizonHours);
          }

          // Basic Structure Validation
          if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs)) {
              // Handle DB mode potentially returning empty legs correctly
              if (generationStrategy === 'database_quant_ev' && rawAIParlayData?.legs?.length === 0) {
                   console.log("✅ DB Quant: No +EV legs found meeting criteria.");
                   // Return the structured empty response from _generateDbQuantParlay
                   return rawAIParlayData;
              }
              console.error("❌ AI/DB response validation failed: 'legs' is not an array or is missing.", rawAIParlayData);
              throw new Error('AI/DB function failed to return valid structure (missing legs array).');
         }

          // Process & Validate Legs
          // _ensureLegsHaveOdds now filters out completely invalid structures
          let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
          let validationRate = 1.0; // Default for DB mode
          let finalLegs = processedLegs; // Initially assume all processed legs are final
          let validationResult = { validatedLegs: processedLegs, validationRate: 1.0, totalProposed: processedLegs.length }; // Default structure
          const originalLegCount = processedLegs.length; // Store count *after* initial processing

          if (generationStrategy === 'quantum_web_ev') {
              validationResult = await validateAILegsAgainstSchedule(sportKey, processedLegs, horizonHours);
              validationRate = validationResult.validationRate;
              // Keep all legs from validationResult for potential display, but filter for quant eval
              finalLegs = validationResult.validatedLegs.filter(leg => leg.real_game_validated);
              const removedCount = originalLegCount - finalLegs.length;
              if (removedCount > 0) {
                   console.warn(`⚠️ ${removedCount} leg(s) removed by schedule validation.`);
                   // Log which legs failed
                   validationResult.validatedLegs.forEach((leg, idx) => {
                       if (!leg.real_game_validated) {
                           console.warn(`   - Leg ${idx+1} Failed: "${leg.event}" - ${leg.validation_error || 'Reason unknown'}`);
                       }
                   });
              }

              if (finalLegs.length < 2) { // Check if enough legs remain *after* filtering
                  console.error(`❌ Insufficient valid legs (${finalLegs.length}) after schedule validation (needed >= 2).`);
                  // Pass the validationResult legs (with flags) to the failure response
                  return this._createValidationFailureResponse(rawAIParlayData, validationResult.validatedLegs, generationStrategy, "Insufficient legs passed schedule validation.");
              }
          }

          // Final Quantitative Evaluation (only on validated/filtered legs)
          console.log(`🔬 Performing final quantitative evaluation on ${finalLegs.length} leg(s)...`);
          const evaluationResult = await quantitativeService.evaluateParlay(finalLegs); // Use the filtered 'finalLegs'

          // Handle Rejection from Quant Service
          if (evaluationResult.error || evaluationResult.summary?.verdict === 'REJECTED' || evaluationResult.riskAssessment?.overallRisk === 'REJECTED') {
               const reason = evaluationResult.error || evaluationResult.summary?.primaryAction || 'Quantitative rejection';
               console.warn(`❌ Parlay REJECTED by Quant Service. Reason: ${reason}`);
               return {
                   ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
                   // *** Show the legs *after* validation but *before* quant rejection ***
                   legs: validationResult.validatedLegs,
                   ...evaluationResult, // Include rejection details from quant service
                   research_metadata: { ...(rawAIParlayData.research_metadata || {}), quantitative_rejection: true, generationStrategy, validationRate: validationRate.toFixed(2) }
               };
          }

          // Assemble Final Successful Result
          const finalResult = {
              ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
              // *** Show the final *quant-approved* legs ***
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
                  originalLegCount: originalLegCount // Add original count for context
              },
              portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations // Fallback construction details
           };
           // Ensure metadata leg count matches final legs
           if (finalResult.parlay_metadata) finalResult.parlay_metadata.legs_count = finalLegs.length;

          console.log(`✅ Successfully generated/evaluated EV Parlay [${requestId}]. Verdict: ${finalResult.summary?.verdict}`);
          return finalResult;

      } catch (error) {
          console.error(`❌ EV Parlay Gen Failed Critically [${requestId}]:`, error.message, error.stack); // Log stack too
          sentryService.captureError(error, { component: 'aiService', operation: 'generateParlay_Overall', sportKey, mode, numLegs, generationStrategy: generationStrategy, level: 'error' });

          // Attempt fallback ONLY if the primary strategy was not already fallback
          if (generationStrategy !== 'quantum_fallback_ev') {
              console.log(`🔄 Attempting FALLBACK for [${requestId}] due to error: ${error.message}`);
              try {
                  return await this._generateFallbackParlay(sportKey, numLegs, betType, promptContext); // Pass context
              } catch (fallbackError) {
                  console.error(`❌ FALLBACK ALSO FAILED [${requestId}]:`, fallbackError.message);
                  sentryService.captureError(fallbackError, { component: 'aiService', operation: 'generateParlay_Fallback', sportKey, level: 'fatal' });
                  // Throw a more informative error if both failed
                  throw new Error(`AI analysis failed: Primary (${generationStrategy || 'unknown'}) failed with "${error.message}" AND fallback failed with "${fallbackError.message}".`);
              }
          } else {
               // If fallback itself failed, throw that specific error
               throw new Error(`AI fallback analysis failed: ${error.message}`);
          }
      }
  }

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

      // Sort by EV descending and remove duplicates (same game + outcome)
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
             // best_quote: { decimal: decimalOdds } // Optional, depends if needed
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
