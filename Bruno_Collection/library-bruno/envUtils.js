// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// envUtils.js — safe accessors for the scenario env vars set by
// scenarioParser.js / getScenarioData().
//
// parseEnvJson(name[, fallback]) reads a Bruno env var and JSON-parses it,
// turning the two SILENT failure modes into ACTIONABLE errors:
//
//   1. missing / empty var  — previously `JSON.parse(bru.getEnvVar(x))`
//      became `JSON.parse(undefined)` → "Unexpected token u in JSON at
//      position 0", with no hint which variable or why. Now: a clear message
//      naming the variable and the likely cause (data file didn't load).
//   2. malformed JSON       — now: a message naming the variable plus a
//      snippet of the offending value.
//
// Pass a second argument to make the variable OPTIONAL with that default —
// this preserves the old `JSON.parse(bru.getEnvVar(x) || '[]')` behaviour as
// `parseEnvJson(x, [])`. With no second argument the variable is REQUIRED.
//
// Happy path is unchanged: a valid JSON string parses exactly as before.
function parseEnvJson(name, fallback) {
  var hasFallback = arguments.length >= 2;
  var raw;
  try {
    raw = (typeof bru !== 'undefined' && bru && typeof bru.getEnvVar === 'function')
      ? bru.getEnvVar(name)
      : undefined;
  } catch (e) {
    // bru.getEnvVar threw (no / broken bru context) — treat the var as unset.
    console.log('[envUtils] getEnvVar("' + name + '") threw, treating as unset: ' + (e && e.message));
    raw = undefined;
  }

  if (raw === null || raw === undefined || raw === '') {
    if (hasFallback) return fallback;
    // #328 (v1.11.109): some variables are populated only when an UPSTREAM
    // resolver in scenarioParser.js succeeds. When the scenario's id
    // references (tripRequirementId, passengersListId, …) don't match any
    // entry in the datafile, the resolver silently skips, leaving these
    // variables unset and producing a confusing "data_base missing"-style
    // diagnostic. For the variables affected, append a precise hint
    // naming the upstream resolver + the linkage gap.
    var hint = '';
    if (name === 'offerTripSearchCriteria' || name === 'offerTripSpecifications') {
      var _tt = '';
      try { _tt = (typeof bru !== 'undefined' && bru.getEnvVar('TripType')) || ''; } catch (_e) { _tt = ''; }
      hint = ' Upstream resolver: scenarioParser.osdmTripSearchCriteria() / osdmTripSpecification(). TripType currently="' +
        (_tt || '(unset)') + '". When this variable is empty the cause is almost always ' +
        'an unresolved scenario.tripRequirementId — look for "Scenario \\"...\\" references tripRequirementId=... but no matching entry exists" in the run log above. Fix: open the Test Data → Trip Requirements section in the wizard and link the scenario to a defined entry.';
    } else if (name === 'offerPassengerSpecifications') {
      hint = ' Upstream resolver: scenarioParser passengers block. Cause is almost always an unresolved scenario.passengersListId — look for the matching [ERROR] line about passengersList above. Fix: open Test Data → Passengers in the wizard.';
    } else if (name === 'offerSearchCriteria') {
      hint = ' Upstream resolver: scenarioParser populates this from either the legacy scenario.offerSearchCriteriaListId → offerSearchCriteriaList[] link or the modern inline scenario.offerSearchCriteria object. Fix: open Test Data → Offer Search Criteria in the wizard and link this scenario to a defined entry.';
    }
    throw new Error(
      '[ERROR] Required scenario variable "' + name + '" is empty or not set. ' +
      'This usually means getScenarioData() did not run, or the data file failed ' +
      'to load / had no matching data set for this scenario (check data_base and ' +
      'the scenario code). When running locally in Bruno, check that the data-file ' +
      'server is running and reachable at the data_base URL (e.g. run ' +
      '"python -m http.server 8000" in Bruno_Collection/data_base). See scenarioParser.js.' +
      hint
    );
  }

  // Some Bruno sandbox modes hand back an already-parsed object/array.
  if (typeof raw !== 'string') return raw;

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      '[ERROR] Scenario variable "' + name + '" is not valid JSON: ' +
      ((e && e.message) || e) + '. Value begins: ' + String(raw).slice(0, 80)
    );
  }
}

module.exports = { parseEnvJson };

// Expose to global for parity with the other library modules (so .bru scripts
// can call it unqualified if needed), matching the require-or-eval loader flow.
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
