// src/schemas/parlaySchema.js - Updated Validator for Complex AI Response

/**
 * Validates the structure of the AI's parlay response JSON.
 * Matches the structure defined in ElitePromptService prompts.
 *
 * @param {any} obj - The parsed JSON object from the AI.
 * @param {number} minLegs - The minimum number of legs expected.
 * @returns {boolean} - True if the object matches the expected schema, false otherwise.
 */
export function isValidParlayResponse(obj, minLegs = 1) {
  // Basic object check
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.error("Schema Error: Root is not an object.");
    return false;
  }

  // Check parlay_metadata
  if (!obj.parlay_metadata || typeof obj.parlay_metadata !== 'object') {
    console.error("Schema Error: Missing or invalid 'parlay_metadata' object.");
    return false;
  }
  const meta = obj.parlay_metadata;
  if (typeof meta.sport !== 'string' || meta.sport.length === 0) {
    console.error("Schema Error: Invalid 'parlay_metadata.sport'.");
    return false;
  }
  if (typeof meta.legs_count !== 'number' || meta.legs_count < minLegs) {
    console.error(`Schema Error: Invalid 'parlay_metadata.legs_count' (expected >= ${minLegs}).`);
    return false;
  }
  // Add checks for other metadata fields if strictly needed (bet_type, target_ev, etc.)

  // Check legs array
  const legs = obj.legs;
  if (!Array.isArray(legs)) {
     console.error("Schema Error: 'legs' is not an array.");
     // Attempt recovery: if it's an object, check if values seem like legs
     if (typeof legs === 'object' && legs !== null) {
         const legValues = Object.values(legs);
         if (legValues.length >= minLegs && legValues.every(l => typeof l === 'object')) {
             console.warn("Schema Warning: 'legs' was an object, attempting recovery.");
             // Allow processing to continue, validation will happen on the values
         } else {
             return false; // Unrecoverable format
         }
     } else {
        return false; // Not an array or recoverable object
     }
  }

   // Now validate the actual leg objects (either from array or recovered object)
   const legsToValidate = Array.isArray(legs) ? legs : Object.values(legs);


   // Check if the number of legs matches the metadata count (important consistency check)
   if (legsToValidate.length !== meta.legs_count) {
       console.error(`Schema Error: 'legs' array length (${legsToValidate.length}) does not match 'parlay_metadata.legs_count' (${meta.legs_count}).`);
       return false;
   }

   // Ensure minimum number of legs requirement is met by the validated list
   if (legsToValidate.length < minLegs) {
       console.error(`Schema Error: Not enough legs found (${legsToValidate.length} < ${minLegs}).`);
       return false;
   }


  // Check each leg object structure
  for (let i = 0; i < legsToValidate.length; i++) {
    const l = legsToValidate[i];
    const legNum = i + 1;

    if (!l || typeof l !== 'object') {
      console.error(`Schema Error: Leg ${legNum} is not a valid object.`);
      return false;
    }
    // Required fields in each leg
    if (typeof l.event !== 'string' || l.event.length === 0) {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'event'.`);
      return false;
    }
     // Optional but important: check commence_time format if present
     if (l.commence_time && (typeof l.commence_time !== 'string' || isNaN(Date.parse(l.commence_time)))) {
       console.error(`Schema Error: Leg ${legNum} has invalid 'commence_time' format.`);
       return false;
     }
    if (typeof l.market !== 'string' || l.market.length === 0) {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'market'.`);
      return false;
    }
    if (typeof l.selection !== 'string' || l.selection.length === 0) {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'selection'.`);
      return false;
    }

    // Check odds object
    if (!l.odds || typeof l.odds !== 'object') {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'odds' object.`);
      return false;
    }
    // ** CRITICAL: Check 'american' odds specifically **
    if (typeof l.odds.american !== 'number' || !Number.isFinite(l.odds.american)) {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'odds.american' number.`);
      return false;
    }
    // Optional stricter checks for decimal/implied_probability if needed
    if (typeof l.odds.decimal !== 'number' || l.odds.decimal <= 1) {
       console.warn(`Schema Warning: Leg ${legNum} missing or invalid 'odds.decimal'.`);
       // Allow for now, as it can be calculated
    }
     if (typeof l.odds.implied_probability !== 'number' || l.odds.implied_probability < 0 || l.odds.implied_probability > 1) {
       console.warn(`Schema Warning: Leg ${legNum} missing or invalid 'odds.implied_probability'.`);
       // Allow for now, as it can be calculated
     }


    // Check quantum_analysis object
    if (!l.quantum_analysis || typeof l.quantum_analysis !== 'object') {
      console.error(`Schema Error: Leg ${legNum} missing or invalid 'quantum_analysis' object.`);
      return false;
    }
    if (typeof l.quantum_analysis.confidence_score !== 'number' || l.quantum_analysis.confidence_score < 0 || l.quantum_analysis.confidence_score > 100) {
      console.error(`Schema Error: Leg ${legNum} invalid 'quantum_analysis.confidence_score'.`);
      return false;
    }
    if (typeof l.quantum_analysis.analytical_basis !== 'string' || l.quantum_analysis.analytical_basis.length < 10) {
       console.error(`Schema Error: Leg ${legNum} missing or too short 'quantum_analysis.analytical_basis'.`);
       return false; // Rationale is crucial
     }

     // Add checks for other quantum_analysis fields if needed (key_factors, risk_assessment etc.)
  }

  // Check portfolio_construction object
  if (!obj.portfolio_construction || typeof obj.portfolio_construction !== 'object') {
    console.error("Schema Error: Missing or invalid 'portfolio_construction' object.");
    return false;
  }
  if (typeof obj.portfolio_construction.overall_thesis !== 'string' || obj.portfolio_construction.overall_thesis.length < 10) {
    console.error("Schema Error: Missing or too short 'portfolio_construction.overall_thesis'.");
    return false; // Thesis is crucial
  }
  // Add checks for other portfolio_construction fields if needed

  // If all checks passed
  console.log("✅ AI JSON Schema Validation Passed.");
  return true;
}

// Keep the old simple validator for potential compatibility if needed elsewhere, but clearly name it
export function isValidParlaySimple(obj, minLegs = 1) {
  if (!obj || typeof obj !== 'object') return false;
  const legs = obj.legs;
  if (!Array.isArray(legs) || legs.length < minLegs) return false;
  for (const l of legs) {
    if (!l || typeof l !== 'object') return false;
    // Simple check - adjust if your schema truly used these top-level keys
    // if (typeof l.game_id !== 'string') return false;
    if (typeof l.market !== 'string') return false;
    if (typeof l.selection !== 'string') return false;
    if (typeof l.odds?.american !== 'number') return false; // Check nested odds
  }
  return true;
}
