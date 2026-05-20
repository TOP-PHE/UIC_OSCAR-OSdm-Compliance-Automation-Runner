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
  } catch (_e) {
    raw = undefined;
  }

  if (raw === null || raw === undefined || raw === '') {
    if (hasFallback) return fallback;
    throw new Error(
      '[ERROR] Required scenario variable "' + name + '" is empty or not set. ' +
      'This usually means getScenarioData() did not run, or the data file failed ' +
      'to load / had no matching data set for this scenario (check data_base and ' +
      'the scenario code). See scenarioParser.js.'
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
  // no-op
}
