// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * frameworkCoverage.js — how far what a Test Framework declares is tested
 * (#956). Pure.
 *
 * `declaredFunctions(framework)` lists the functions the framework declares,
 * one row each (`id`, `group`, `label`): a sales flow, a return model, a
 * currency, a reduction card… `functionsOf(scenario, datafile)` names the
 * functions one scenario exercises, with the same ids. `coverageOf()` joins
 * them with the latest run of each scenario and the open findings.
 *
 * Only what the framework lists explicitly is a row: a list left out means
 * "every value" elsewhere in the framework (no warning), and there is nothing
 * to count against it. The one default kept is the distribution mode
 * (absent = product-based, #936). A new declaration adds its row here, next
 * to the rules that read it (`frameworkGating.js`, `scenarioCatalogue.js`).
 */

const crypto = require('node:crypto');
const {
  offerRequestFormOf, placeSelectionFlowOf, scenarioReturnModel, offerSearchOptionsOf, scenarioOfferCriteria,
  OFFER_REQUEST_TEXT, PLACE_SELECTION_TEXT, annotateDatafile,
} = require('./frameworkGating');
const { salesFlowsOf } = require('./scenarioCatalogue');
const { declaredCards } = require('./reductionCards');
const { declaredProducts, declaredGroupProducts } = require('./namedProducts');
const { currenciesOf } = require('./currencies');
const { distributionModesOf } = require('./distributionModes');
const { tripSearchParametersOf, TRIP_SEARCH_PARAMETER_TEXT } = require('./tripSearchParameters');
const { canonical } = require('./datafileOwnership');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ARMED = new Set(['on', 'true', 'yes', '1', true, 1]);
const armed = (v) => ARMED.has(typeof v === 'string' ? v.toLowerCase() : v);
const strings = (list) => [...new Set(arr(list).filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
function frameworkOf(fw) {
  if (isObj(fw?.config)) return fw.config;
  return isObj(fw) ? fw : {};
}

const SALES_FLOW_TEXT = {
  SALE: 'Sale', REFUND_FULL: 'Full refund', REFUND_PARTIAL: 'Partial refund', REFUND_IROPS: 'Refund for irregular operations (IROPS)',
  EXCHANGE_FULL: 'Full exchange', EXCHANGE_PARTIAL: 'Partial exchange', EXCHANGE_IROPS: 'Exchange for irregular operations (IROPS)',
};
const OPTION_TEXT = {
  offerModes: 'Offer mode', requestedOfferParts: 'Requested offer part', travelClasses: 'Travel class',
  serviceClassTypes: 'Service class', productTags: 'Product tag', productSelections: 'Product selection',
};
const words = (code) => String(code).toLowerCase().replaceAll('_', ' ');
const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
// An overrule code that asks nothing (catalogueMatch's NO_OVERRULE).
const NO_OVERRULE = new Set(['', 'null', 'CODE_DOES_NOT_EXIST']);

// ── What the framework declares ─────────────────────────────────────────────

// One family of rows: [group, ids and labels].
function listRows(group, prefix, values, labelOf) {
  return strings(values).map((v) => ({ id: `${prefix}:${v}`, group, label: labelOf(v) }));
}

function limitRows(fw) {
  const rows = [];
  if (Number.isInteger(fw.maxPassengers) && fw.maxPassengers > 0) rows.push({ id: 'limit:maxPassengers', group: 'Limits', label: `At most ${fw.maxPassengers} passengers` });
  if (Number.isInteger(fw.salesHorizonDays) && fw.salesHorizonDays > 0) rows.push({ id: 'limit:salesHorizon', group: 'Limits', label: `Sold ${fw.salesHorizonDays} days ahead` });
  if (isObj(fw.passengerAgeRanges) && Object.keys(fw.passengerAgeRanges).length > 0) rows.push({ id: 'limit:ageRanges', group: 'Limits', label: 'Passenger age ranges' });
  return rows;
}

function codeRows(fw) {
  return [
    ...declaredCards(fw).map((c) => ({ id: `card:${c.code}`, group: 'Reduction cards', label: c.name ? `${c.name} (${c.code})` : c.code })),
    ...declaredProducts(fw).map((p) => ({ id: `product:${p.code}`, group: 'Products', label: p.name ? `${p.name} (${p.code})` : p.code })),
    ...declaredGroupProducts(fw).map((p) => ({ id: `product:${p.code}`, group: 'Group products', label: p.name ? `${p.name} (${p.code})` : p.code })),
    ...listRows('IROPS reason codes', 'overrule', fw.iropsCodes?.refund, (c) => c),
  ];
}

function optionRows(fw) {
  const rows = [];
  for (const [key, label] of Object.entries(OPTION_TEXT)) {
    rows.push(...listRows('Offer search options', `offerOption:${key}`, fw.offerSearchOptions?.[key], (v) => `${label} ${v}`));
  }
  const discovery = isObj(fw.offerOptionDiscovery) || Array.isArray(fw.corporateCodes) || Array.isArray(fw.promotionCodes);
  if (discovery) rows.push({ id: 'offerOptionDiscovery', group: 'Offer search options', label: 'Offer request options (which optional members the provider takes)' });
  return rows;
}

/** The functions a Test Framework declares: [{ id, group, label }], in reading order. */
function declaredFunctions(framework) {
  const fw = frameworkOf(framework);
  const modes = Array.isArray(fw.distributionModes) ? fw.distributionModes : ['PRODUCT'];
  const rows = [
    ...listRows('Distribution', 'distribution', modes, (m) => (m === 'FARE' ? 'Fare-based' : 'Product-based')),
    ...listRows('Sales flows', 'salesFlow', fw.salesFlows, (f) => SALES_FLOW_TEXT[f] || capital(words(f))),
    ...listRows('Partial refund', 'partialRefund', arr(fw.salesFlows).includes('REFUND_PARTIAL') ? fw.partialRefundScopes : [], (s) => `By ${words(s)}`),
    ...listRows('Return journeys', 'returnModel', fw.returnModels, (m) => (m === 'COMBINED' ? 'One offer for both directions' : 'One offer per direction')),
    ...listRows('Offer requests', 'offerRequestForm', fw.offerRequestForms, (f) => `Offers ${OFFER_REQUEST_TEXT[f] || words(f)}`),
    ...listRows('Trip search parameters', 'tripParameter', fw.tripSearchParameters, (p) => capital(TRIP_SEARCH_PARAMETER_TEXT[p] || words(p))),
    ...listRows('Passenger types', 'passengerType', fw.passengerTypes, (t) => capital(words(t))),
    ...listRows('Seat selection', 'placeSelection', fw.placeSelectionFlows, (f) => capital(PLACE_SELECTION_TEXT[f] || words(f))),
    ...listRows('Currencies', 'currency', currenciesOf(fw).sold, (c) => c),
    ...optionRows(fw),
    ...codeRows(fw),
    ...listRows('Fares', 'fareCluster', fw.fares?.clusters, (c) => `Fare cluster ${c}`),
    ...limitRows(fw),
  ];
  const byId = new Map();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

// ── What a scenario exercises ───────────────────────────────────────────────

const passengersOf = (scenario, datafile) => arr(arr(datafile?.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId)?.passengers)
  .filter(isObj);
const cardCodesOf = (passengers) => passengers.flatMap((p) => arr(p.reductionCards))
  .map((c) => (isObj(c) ? c.code : c)).filter((c) => typeof c === 'string' && c !== '');

function limitFunctions(scenario, passengers) {
  const out = [];
  if (armed(scenario.passengerLimitExpectRejection)) out.push('limit:maxPassengers');
  if (armed(scenario.departureExpectRejection) || (scenario.departureDaysFromToday != null && scenario.departureDaysFromToday !== '')) out.push('limit:salesHorizon');
  if (passengers.some((p) => p.bornYearsBeforeTravel != null || p.expectedPassengerType)) out.push('limit:ageRanges');
  return out;
}

// The passenger types a scenario's passengers stand for. A PERSON (typed by
// its age, OSDM's anonymous passenger) is an adult unless it names the type
// it expects to be priced as (#705's age bands).
function passengerTypesOf(passengers) {
  const typeOf = (p) => {
    if (p.type && p.type !== 'PERSON') return p.type;
    return typeof p.expectedPassengerType === 'string' && p.expectedPassengerType.trim() ? p.expectedPassengerType.trim() : 'ADULT';
  };
  return strings(passengers.map(typeOf));
}

// A refund's partial scopes, and the IROPS flow and code of an after-sale
// asked with an overrule code.
function afterSaleFunctions(scenario) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  const out = [];
  if (type === 'REFUND') {
    for (const [field, scope] of [['partialRefundByFulfillment', 'FULFILLMENT'], ['partialRefundByLeg', 'LEG'], ['partialRefundByPax', 'PASSENGER']]) {
      if (armed(scenario[field])) out.push(`partialRefund:${scope}`);
    }
  }
  const code = typeof scenario.overruleCode === 'string' ? scenario.overruleCode.trim() : '';
  if ((type === 'REFUND' || type === 'EXCHANGE') && !NO_OVERRULE.has(code)) out.push(`salesFlow:${type}_IROPS`, `overrule:${code}`);
  return out;
}

/** The ids of the functions a scenario exercises (as declaredFunctions names them). */
function functionsOf(scenario, datafile) {
  if (!isObj(scenario)) return new Set();
  const passengers = passengersOf(scenario, datafile);
  const ids = [
    ...distributionModesOf(scenario, datafile).map((m) => `distribution:${m}`),
    ...salesFlowsOf(scenario).map((f) => `salesFlow:${f}`),
    `offerRequestForm:${offerRequestFormOf(scenario, datafile)}`,
    ...tripSearchParametersOf(scenario, datafile).map((p) => `tripParameter:${p}`),
    ...passengerTypesOf(passengers).map((t) => `passengerType:${t}`),
    ...cardCodesOf(passengers).map((c) => `card:${c}`),
    ...limitFunctions(scenario, passengers),
  ];
  ids.push(...afterSaleFunctions(scenario));
  const model = scenarioReturnModel(scenario);
  if (model) ids.push(`returnModel:${model}`);
  const flow = placeSelectionFlowOf(scenario);
  if (flow) ids.push(`placeSelection:${flow}`);
  const currency = scenarioOfferCriteria(scenario, datafile)?.currency;
  if (typeof currency === 'string' && currency) ids.push(`currency:${currency}`);
  else ids.push('currency:default');
  for (const [key, values] of Object.entries(offerSearchOptionsOf(scenario, datafile))) ids.push(...values.map((v) => `offerOption:${key}:${v}`));
  if (typeof scenario.expectedProduct === 'string' && scenario.expectedProduct.trim()) ids.push(`product:${scenario.expectedProduct.trim()}`);
  if (typeof scenario.desiredFareCluster === 'string' && scenario.desiredFareCluster) ids.push(`fareCluster:${scenario.desiredFareCluster}`);
  if (armed(scenario.offerOptionDiscovery)) ids.push('offerOptionDiscovery');
  return new Set(ids);
}

/** A scenario's content, as a run records it: sha256 of its canonical text. */
function scenarioHash(scenario) {
  return isObj(scenario) ? crypto.createHash('sha256').update(canonical(scenario)).digest('hex') : null;
}

// ── Runs and the coverage ───────────────────────────────────────────────────

/**
 * The result of one run: passed / failed, from its checks (a run whose
 * Bruno stopped with no check counts as failed).
 */
function resultOf(run) {
  if (!run) return 'never-run';
  if (run.failed > 0) return 'failed';
  if (run.total > 0) return 'passed';
  return run.status === 'COMPLETED' ? 'passed' : 'failed';
}

/** Whether a run should be made again: true, false, or null when the run did not record enough. */
function toRunAgain(run, { collectionVersion, hash }) {
  if (!run) return null;
  const known = [];
  if (run.collection_version && collectionVersion) known.push(run.collection_version !== collectionVersion);
  if (run.scenario_hash && hash) known.push(run.scenario_hash !== hash);
  if (known.length === 0) return null;
  return known.includes(true);
}

function scenarioEntry(scenario, run, context) {
  const entry = { code: scenario.code, result: resultOf(run), toRunAgain: toRunAgain(run, { ...context, hash: scenarioHash(scenario) }) };
  if (run) {
    entry.run = {
      id: run.id, at: run.completed_at || run.queued_at, passed: run.total - run.failed, failed: run.failed,
      serverVersion: run.server_version || null, collectionVersion: run.collection_version || null,
    };
  }
  return entry;
}

// The state of one function from its scenarios.
function stateOf(scenarios) {
  if (scenarios.length === 0) return 'not-covered';
  if (scenarios.some((s) => s.result === 'failed')) return 'failed';
  if (scenarios.some((s) => s.result === 'passed')) return 'passed';
  return 'never-run';
}

const OPEN_FINDING = (f) => f && f.status !== 'resolved' && typeof f.scenario_code === 'string';

/**
 * The coverage of a framework by a data file's scenarios.
 *   framework  the Test Framework config
 *   datafile   the data file (as the reader sees it)
 *   runs       { code: latest finished run row } (id, status, queued_at,
 *              completed_at, total, failed, server_version, collection_version,
 *              scenario_hash)
 *   findings   finding rows (id, title, category, status, scenario_code)
 *   collectionVersion  the collection the runs use now
 */
function coverageOf({ framework, datafile, runs = {}, findings = [], collectionVersion = null }) {
  const scenarios = arr(datafile?.scenarios).filter((s) => isObj(s) && typeof s.code === 'string' && s.code !== '');
  const defaultCurrency = currenciesOf(frameworkOf(framework)).default;
  const exercised = scenarios.map((s) => ({ scenario: s, ids: withDefaultCurrency(functionsOf(s, datafile), defaultCurrency) }));
  const entries = new Map(scenarios.map((s) => [s.code, scenarioEntry(s, runs[s.code] || null, { collectionVersion })]));
  const openFindings = arr(findings).filter(OPEN_FINDING);
  const functions = declaredFunctions(framework).map((fn) => {
    const covering = exercised.filter((e) => e.ids.has(fn.id)).map((e) => entries.get(e.scenario.code));
    const codes = new Set(covering.map((s) => s.code));
    return {
      ...fn,
      state: stateOf(covering),
      toRunAgain: covering.some((s) => s.toRunAgain === true),
      scenarios: covering,
      findings: openFindings.filter((f) => codes.has(f.scenario_code))
        .map((f) => ({ id: f.id, title: f.title, category: f.category, status: f.status, scenarioCode: f.scenario_code })),
    };
  });
  const count = (state) => functions.filter((f) => f.state === state).length;
  const dates = [...entries.values()].map((e) => e.run?.at).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    summary: {
      declared: functions.length, covered: functions.length - count('not-covered'),
      passed: count('passed'), failed: count('failed'), neverRun: count('never-run'), notCovered: count('not-covered'),
      toRunAgain: functions.filter((f) => f.toRunAgain).length, latestRunAt: dates.at(-1) || null,
    },
    functions,
    notDeclared: notDeclaredOf(datafile, framework),
  };
}

// A scenario that asks no currency is answered in the default one (#781).
function withDefaultCurrency(ids, currency) {
  if (!ids.delete('currency:default')) return ids;
  if (currency) ids.add(`currency:${currency}`);
  return ids;
}

// The scenarios that test what the framework does not declare (#218's
// warnings), on a copy: the reader's data file is not changed.
function notDeclaredOf(datafile, framework) {
  if (!isObj(datafile) || !Array.isArray(datafile.scenarios)) return [];
  const copy = structuredClone(datafile);
  annotateDatafile(copy, frameworkOf(framework));
  return copy.scenarios.filter((s) => isObj(s) && Array.isArray(s.__featureNotDeclaredWarnings))
    .map((s) => ({ code: s.code, warnings: s.__featureNotDeclaredWarnings }));
}

/** From run rows of one company, newest first: the latest finished run per scenario code. */
function latestRunsOf(rows) {
  const out = {};
  for (const row of arr(rows)) {
    if (!isObj(row) || typeof row.scenario_code !== 'string' || out[row.scenario_code]) continue;
    if (row.status === 'COMPLETED' || row.status === 'FAILED') out[row.scenario_code] = row;
  }
  return out;
}

module.exports = {
  declaredFunctions, functionsOf, scenarioHash, coverageOf, latestRunsOf, resultOf, toRunAgain,
  scenarioEntry, withDefaultCurrency, notDeclaredOf, frameworkOf, SALES_FLOW_TEXT, OPTION_TEXT,
};
