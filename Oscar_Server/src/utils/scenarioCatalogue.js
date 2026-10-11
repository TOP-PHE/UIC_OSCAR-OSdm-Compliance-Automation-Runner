// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenarioCatalogue.js — the scenario catalogue (#612): reference scenarios a
 * company can pick and copy. Pure: plain objects in, plain objects out; the
 * route reads the two files.
 *
 * The catalogue file (Bruno_Collection/data_base/scenario_catalogue.json)
 * lists reference scenarios by a generic code. Each names the scenario of the
 * simulator's data file it is made from (`source`), so that the catalogue
 * holds no scenario data of its own: one copy, proven by the replay on the
 * simulator (#611), with the number of checks it gave there (`checks`).
 * `set` overrides a few fields for a real provider (a longer wait), and
 * `purpose` says what it tests.
 *
 * From the two files, catalogueDatafile() makes a data file: the reference
 * scenarios under their catalogue codes, and every list entry they use. It is
 * the source of the ordinary scenario copy (utils/scenarioCopy.js), which
 * re-maps trips onto the company's Test Data and gives every entry a fresh id.
 *
 * requirementsOf() says what a reference scenario needs the Test Framework to
 * declare (sales flow, return model, OSDM version, passenger types), and
 * missingFor() which of those a framework does not: the golden rule (#218).
 */

const { scenarioReturnModel } = require('./frameworkGating');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const ARMED = new Set(['on', 'true', 'yes', true]);
const LISTS = [
  ['tripRequirementId', 'tripRequirements'],
  ['passengersListId', 'passengersList'],
  ['purchaserListId', 'purchaserList'],
  ['offerSearchCriteriaListId', 'offerSearchCriteriaList'],
  ['requestedFulfillmentOptionsListId', 'requestedFulfillmentOptionsList'],
];
const CODE = /^(OTST|NHF)_[A-Z0-9_]{3,60}$/;
// Fields of a scenario that `set` may change: waits and nothing that points
// at another entry or changes what the scenario is.
const SETTABLE = /^[a-z][A-Za-z]*MaxWaitMinutes$/;

// The problems of one entry of the catalogue.
function entryProblems(e, at, scenarios, codes) {
  if (!isObj(e)) return [`${at} is not an object`];
  const problems = [];
  if (typeof e.code !== 'string' || !CODE.test(e.code)) problems.push(`${at}.code "${e.code}" is not OTST_… or NHF_… in capitals`);
  if (codes.has(e.code)) problems.push(`${at}.code "${e.code}" appears twice`);
  if (!scenarios.has(e.source)) problems.push(`${at}.source "${e.source}" is not a scenario of the simulator's data file`);
  if (typeof e.purpose !== 'string' || e.purpose.length < 10) problems.push(`${at}.purpose is missing`);
  if (!Number.isInteger(e.checks) || e.checks <= 0) problems.push(`${at}.checks must be the number of checks it gives on the simulator`);
  for (const key of Object.keys(e.set || {})) if (!SETTABLE.test(key)) problems.push(`${at}.set.${key} is not a field the catalogue may change`);
  if (String(e.source).startsWith('SIM_WRONG_')) problems.push(`${at}.source is a deliberately wrong scenario`);
  return problems;
}

/** The problems of a catalogue against the simulator's data file; none when it is sound. */
function catalogueProblems(catalogue, simulator) {
  const problems = [];
  const entries = arr(catalogue?.entries);
  if (entries.length === 0) problems.push('the catalogue has no entry');
  const codes = new Set();
  const scenarios = new Map(arr(simulator?.scenarios).filter(isObj).map((s) => [s.code, s]));
  for (const [i, e] of entries.entries()) {
    problems.push(...entryProblems(e, `entries[${i}]`, scenarios, codes));
    if (isObj(e)) codes.add(e.code);
  }
  return problems;
}

const kindOf = (code) => (String(code).startsWith('NHF_') ? 'NHF' : 'OTST');

/** The sales flows a scenario uses, as the Test Framework names them. */
function salesFlowsOf(scenario) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  const flows = ['SALE'];
  if (type === 'SALE') return flows;
  const partial = ['partialRefundByLeg', 'partialRefundByPax', 'partialRefundByFulfillment'].some((f) => ARMED.has(scenario[f]));
  flows.push(type === 'REFUND' && partial ? 'REFUND_PARTIAL' : `${type}_FULL`);
  return flows;
}

const versionAtLeast = (version, major, minor) => {
  const [a, b] = String(version || '').split('.').map((n) => Number.parseInt(n, 10));
  return Number.isInteger(a) && Number.isInteger(b) && (a > major || (a === major && b >= minor));
};

/** What a reference scenario needs the Test Framework to declare. */
function requirementsOf(scenario, datafile) {
  const list = arr(datafile.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId);
  const types = [...new Set(arr(list?.passengers).map((p) => p?.type).filter((t) => typeof t === 'string' && t !== 'PERSON'))];
  const model = scenarioReturnModel(scenario);
  return {
    salesFlows: salesFlowsOf(scenario),
    returnModel: model,
    minOsdmVersion: model === 'COMBINED' ? '3.7' : null,
    passengerTypes: types,
  };
}

/** The declarations a framework lacks for these requirements, as sentences. */
function missingFor(requirements, framework) {
  let fw = isObj(framework) ? framework : {};
  if (isObj(framework?.config)) fw = framework.config;
  const missing = [];
  const flows = arr(fw.salesFlows);
  for (const flow of requirements.salesFlows) if (!flows.includes(flow)) missing.push(`sales flow ${flow}`);
  if (requirements.returnModel && Array.isArray(fw.returnModels) && !fw.returnModels.includes(requirements.returnModel)) {
    missing.push(`return model ${requirements.returnModel}`);
  }
  if (requirements.minOsdmVersion && !versionAtLeast(fw.osdmVersion, 3, 7)) missing.push(`OSDM ${requirements.minOsdmVersion} or later`);
  const declared = arr(fw.passengerTypes);
  for (const type of requirements.passengerTypes) if (!declared.includes(type)) missing.push(`passenger type ${type}`);
  return missing;
}

/**
 * The data file the catalogue makes: its reference scenarios, under their
 * catalogue codes, and the list entries they use. Throws when the catalogue
 * is not sound.
 */
function catalogueDatafile(catalogue, simulator) {
  const problems = catalogueProblems(catalogue, simulator);
  if (problems.length) throw new Error(`The scenario catalogue is not valid: ${problems.join('; ')}`);
  const out = { scenarios: [] };
  for (const [, list] of LISTS) out[list] = [];
  for (const entry of catalogue.entries) {
    const source = simulator.scenarios.find((s) => isObj(s) && s.code === entry.source);
    const scenario = { ...clone(source), ...clone(entry.set || {}), code: entry.code, description: entry.purpose, shared: true };
    delete scenario.created_by;
    out.scenarios.push(scenario);
    for (const [field, list] of LISTS) {
      const item = arr(simulator[list]).find((e) => isObj(e) && e.id === scenario[field]);
      if (item && !out[list].some((e) => e.id === item.id)) out[list].push(clone(item));
    }
  }
  return out;
}

/** The catalogue as a company sees it: each entry, what it needs, what is missing. */
function catalogueFor(catalogue, simulator, framework) {
  const datafile = catalogueDatafile(catalogue, simulator);
  return catalogue.entries.map((entry) => {
    const scenario = datafile.scenarios.find((s) => s.code === entry.code);
    const requirements = requirementsOf(scenario, datafile);
    return {
      code: entry.code,
      kind: kindOf(entry.code),
      area: String(scenario.scenarioType || 'SALE').toLowerCase(),
      purpose: entry.purpose,
      checks: entry.checks,
      requirements,
      missing: missingFor(requirements, framework),
    };
  });
}

module.exports = { catalogueProblems, catalogueDatafile, catalogueFor, requirementsOf, missingFor, salesFlowsOf };
