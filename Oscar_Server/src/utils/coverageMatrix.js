// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverageMatrix.js — the coverage of a Test Framework read by flow and by
 * element tested (#956, part 3). Pure.
 *
 * `frameworkCoverage.js` answers "is each declared function tested?". This
 * answers the question the other way round: for each sales flow, which
 * elements its scenarios test (a passenger type, a seat selection flow, a
 * currency, a card…), and with what result. An element is listed whether or
 * not the framework declares it, so that what is tested without being
 * declared shows too.
 *
 * A row also counts, in `providerNotSupported`, its scenarios whose latest run
 * holds a warning saying the provider does not support something (501,
 * PARAMETER_NOT_SUPPORTED…). That stays beside the result, never in it: such a
 * warning is about one request of the scenario (often an optional read), not
 * about every element the scenario tests.
 *
 * Results of a row:
 *   passed / failed / never-run   from the latest finished run of its scenarios
 *   not-declared                  OSCAR warns that a scenario tests it without
 *                                 the framework declaring it (#218's warnings;
 *                                 a probe of what is not declared gets none,
 *                                 and keeps its run's result)
 *   declared-not-supported        the framework says the provider does not
 *                                 do it (passenger update, purchaser after the
 *                                 booking, an offer request option): no scenario
 */

const { salesFlowsOf } = require('./scenarioCatalogue');
const { OFFER_REQUEST_TEXT, PLACE_SELECTION_TEXT } = require('./frameworkGating');
const { declaredCards } = require('./reductionCards');
const { declaredProducts, declaredGroupProducts } = require('./namedProducts');
const { currenciesOf } = require('./currencies');
const { declarationsOf } = require('./offerOptionDiscovery');
const { TRIP_SEARCH_PARAMETER_TEXT } = require('./tripSearchParameters');
const {
  declaredFunctions, functionsOf, scenarioEntry, withDefaultCurrency, notDeclaredOf, frameworkOf, stateOf,
  SALES_FLOW_TEXT, OPTION_TEXT, FARE_TEXT,
} = require('./frameworkCoverage');
const { catalogueEntryForScenario } = require('./scenarioCatalogue');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (code) => String(code).toLowerCase().replaceAll('_', ' ');
const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const flowLabel = (flow) => SALES_FLOW_TEXT[flow] || capital(words(flow));
const FLOW_ORDER = ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'REFUND_IROPS', 'EXCHANGE_FULL', 'EXCHANGE_PARTIAL', 'EXCHANGE_IROPS'];
const WHOLE_FLOW = 'Whole flow';
const LIMIT_TEXT = { maxPassengers: 'Passenger limit', salesHorizon: 'Sales horizon', ageRanges: 'Passenger age ranges' };
const RESULT_TEXT = Object.freeze({
  passed: 'Passed', defects: 'Passed with defects', failed: 'Failed', 'never-run': 'Never run', 'not-covered': 'No scenario',
  'not-declared': 'Not supported (not declared)', 'declared-not-supported': 'Not supported (declared)',
});
const MAX_REFUSAL_LINES = 5;
const MAX_REFUSAL_LENGTH = 400;

// Each kind of element: its group, its label and what the framework lists of
// it (undefined = not listed, so every value is declared).
const FAMILIES = {
  salesFlow: { group: 'Sales flows', label: (f) => flowLabel(f), listed: (fw) => fw.salesFlows },
  distribution: { group: 'Distribution', label: (m) => (m === 'FARE' ? 'Fare-based' : 'Product-based'),
    listed: (fw) => (Array.isArray(fw.distributionModes) ? fw.distributionModes : ['PRODUCT']) },
  partialRefund: { group: 'Partial refund', label: (s) => `By ${words(s)}`, listed: (fw) => fw.partialRefundScopes },
  returnModel: { group: 'Return journeys', label: (m) => (m === 'COMBINED' ? 'One offer for both directions' : 'One offer per direction'),
    listed: (fw) => fw.returnModels },
  offerRequestForm: { group: 'Offer requests', label: (f) => `Offers ${OFFER_REQUEST_TEXT[f] || words(f)}`, listed: (fw) => fw.offerRequestForms },
  tripParameter: { group: 'Trip search parameters', label: (p) => capital(TRIP_SEARCH_PARAMETER_TEXT[p] || words(p)),
    listed: (fw) => fw.tripSearchParameters },
  passengerType: { group: 'Passenger types', label: (t) => capital(words(t)), listed: (fw) => fw.passengerTypes },
  placeSelection: { group: 'Seat selection', label: (f) => capital(PLACE_SELECTION_TEXT[f] || words(f)), listed: (fw) => fw.placeSelectionFlows },
  currency: { group: 'Currencies', label: (c) => c, listed: (fw) => { const sold = currenciesOf(fw).sold; return sold.length ? sold : undefined; } },
  card: { group: 'Reduction cards', label: (c) => c,
    listed: (fw) => (Array.isArray(fw.reductionCards) ? declaredCards(fw).map((c) => c.code) : undefined) },
  product: { group: 'Products', label: (p) => p, listed: (fw) => ((Array.isArray(fw.products) || Array.isArray(fw.groupProducts))
    ? [...declaredProducts(fw), ...declaredGroupProducts(fw)].map((p) => p.code) : undefined) },
  overrule: { group: 'IROPS reason codes', label: (c) => c, listed: (fw) => fw.iropsCodes?.refund },
  fareCluster: { group: 'Fares', label: (c) => `Fare cluster ${c}`, listed: (fw) => fw.fares?.clusters },
  fareCombination: { group: 'Fares', label: (c) => `Fares combined by ${c}`, listed: (fw) => fw.fares?.combinationModels },
  fareReservation: { group: 'Fares', label: (r) => `Fare reservation for a ${words(r)}`, listed: (fw) => fw.fares?.reservations },
  fareSalesFlow: { group: 'Fares', label: (f) => `Fares: ${flowLabel(f).toLowerCase()}`, listed: (fw) => fw.fares?.salesFlows },
  fare: { group: 'Fares', label: (k) => FARE_TEXT[k] || k, listed: fareFlagsOf },
  limit: { group: 'Limits', label: (k) => LIMIT_TEXT[k] || k,
    listed: (fw) => declaredFunctions(fw).filter((f) => f.id.startsWith('limit:')).map((f) => f.id.slice(6)) },
};
// #937's yes/no fare declarations as a list: undefined when the framework has no `fares`.
function fareFlagsOf(fw) {
  if (!isObj(fw.fares)) return undefined;
  const out = [];
  if (fw.fares.statedRefundFee === true) out.push('statedRefundFee');
  if (Number.isInteger(fw.fares.freeUnderAge)) out.push('freeUnderAge');
  return out;
}
const GROUP_ORDER = [WHOLE_FLOW, ...Object.values(FAMILIES).map((f) => f.group), 'Offer search options', 'Offer request options', 'Booking'];

const splitId = (id) => {
  const at = id.indexOf(':');
  return at === -1 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
};

// The group and label of an element: the framework's own row when it declares
// it (a card or product by its name), else the kind's.
function describe(id, declaredRows) {
  const row = declaredRows.get(id);
  if (row) return { group: row.group, label: row.label };
  const [prefix, value] = splitId(id);
  if (prefix === 'offerOption') {
    const [key, v] = splitId(value);
    return { group: 'Offer search options', label: `${OPTION_TEXT[key] || capital(words(key))} ${v}` };
  }
  if (prefix === 'offerOptionDiscovery') return { group: 'Offer search options', label: 'Offer request options (which optional members the provider takes)' };
  const family = FAMILIES[prefix];
  return family ? { group: family.group, label: family.label(value) } : { group: 'Other', label: id };
}

/**
 * What the framework says of an element: 'declared', 'not-declared' (it lists
 * that kind of element and leaves this one out) or 'every-value' (it lists
 * none of that kind, which declares every value).
 */
function declarationOf(id, fw, declaredIds) {
  if (declaredIds.has(id)) return 'declared';
  const [prefix, value] = splitId(id);
  if (prefix === 'offerOptionDiscovery') return 'every-value';
  let listed;
  let item = value;
  if (prefix === 'offerOption') {
    const [key, v] = splitId(value);
    listed = fw.offerSearchOptions?.[key];
    item = v;
  } else {
    listed = FAMILIES[prefix]?.listed(fw);
  }
  if (!Array.isArray(listed)) return 'every-value';
  return listed.includes(item) ? 'declared' : 'not-declared';
}

/** The flow a scenario tests: its after-sale (IROPS when it sends a code), else the sale. */
function mainFlowOf(scenario, ids) {
  for (const irops of ['REFUND_IROPS', 'EXCHANGE_IROPS']) if (ids.has(`salesFlow:${irops}`)) return irops;
  return salesFlowsOf(scenario)[1] || 'SALE';
}

const NOT_SUPPORTED = /\bnot supported\b|PARAMETER_NOT_SUPPORTED|OPERATION_NOT_PERMITTED|\bnot implemented\b|\b501\b/i;

/**
 * The warning lines of a run saying the provider does not support something
 * (at most five, each cut to 400 characters). `lines` are its log lines.
 */
function providerRefusalsOf(lines) {
  const out = [];
  for (const line of arr(lines)) {
    if (typeof line !== 'string') continue;
    const at = line.indexOf('[WARNING]');
    if (at === -1 || !NOT_SUPPORTED.test(line)) continue;
    out.push(line.slice(at + 9).trim().slice(0, MAX_REFUSAL_LENGTH));
    if (out.length >= MAX_REFUSAL_LINES) break;
  }
  return out;
}

// #218's warning names -> the element they are about. A rule field (a flag
// whose flow is not declared) is about the whole flow.
const WARNING_PREFIXES = [
  ['currency:', 'currency:'], ['placeSelectionBy:', 'placeSelection:'], ['offerRequestBy:', 'offerRequestForm:'],
  ['tripParameter:', 'tripParameter:'], ['distributionMode:', 'distribution:'],
];
const STEP_WARNINGS = new Set(['passengerUpdate', 'passengerUpdateScope', 'purchaserAfterBooking']);
function warnedElements(warnings, ids) {
  const out = new Set();
  for (const w of arr(warnings)) {
    if (typeof w !== 'string' || STEP_WARNINGS.has(w)) continue;
    const pair = WARNING_PREFIXES.find(([from]) => w.startsWith(from));
    if (pair) out.add(pair[1] + w.slice(pair[0].length));
    else if (w.startsWith('offerOption:')) out.add(`offerOption:${w.slice(12).replace('=', ':')}`);
    else if (w === 'returnModel') out.add([...ids].find((id) => id.startsWith('returnModel:')));
    else out.add(null);
  }
  return out;
}

// A row's result: failed when one of its scenarios was blocked, passed with
// defects when some failed checks let every flow go through, else passed.
function resultOfRow(warned, entries) {
  return warned ? 'not-declared' : stateOf(entries);
}

// The scenarios of a row that failed, blocked ones first: what to look at.
function failedScenariosOf(entries) {
  return entries.filter((e) => e.result === 'failed' || e.result === 'defects')
    .map((e) => ({
      code: e.code, result: e.result, runId: e.run?.id || null,
      step: e.run?.failedStep || null, check: e.run?.failedCheck || null,
    }))
    .sort((a, b) => (a.result === b.result ? 0 : Number(a.result === 'defects') - Number(b.result === 'defects')));
}

// What the framework says the provider does not do: one row each, no scenario.
function declaredNotSupportedRows(fw) {
  const rows = [];
  if (fw.passengerUpdate === false) rows.push({ element: 'notSupported:passengerUpdate', group: 'Booking', label: 'Passenger update after the booking' });
  if (fw.purchaserAfterBooking === false) rows.push({ element: 'notSupported:purchaserAfterBooking', group: 'Booking', label: 'Purchaser given after the booking' });
  for (const [key, ok] of Object.entries(declarationsOf(fw).declared)) {
    if (ok === false) rows.push({ element: `notSupported:offerOption:${key}`, group: 'Offer request options', label: `Offer request option ${key}` });
  }
  return rows.map((r) => ({
    flow: 'SALE', flowLabel: flowLabel('SALE'), ...r, declaration: 'declared-not-supported', result: 'declared-not-supported',
    scenarios: [], counts: { scenarios: 0, passed: 0, withDefects: 0, failed: 0, neverRun: 0 }, failedScenarios: [], providerNotSupported: 0, toRunAgain: false, findings: [],
  }));
}

function rowOf(flow, element, cell, context) {
  const entries = cell.codes.map((c) => context.entries.get(c));
  const codes = new Set(cell.codes);
  return {
    flow, flowLabel: flowLabel(flow), element, group: cell.group, label: cell.label, declaration: cell.declaration,
    result: resultOfRow(cell.warned, entries),
    providerNotSupported: entries.filter((e) => arr(context.refusals[e.code]).length > 0).length,
    scenarios: cell.codes,
    counts: {
      scenarios: entries.length, passed: entries.filter((e) => e.result === 'passed').length,
      withDefects: entries.filter((e) => e.result === 'defects').length,
      failed: entries.filter((e) => e.result === 'failed').length, neverRun: entries.filter((e) => e.result === 'never-run').length,
    },
    failedScenarios: failedScenariosOf(entries),
    toRunAgain: entries.some((e) => e.toRunAgain === true),
    findings: context.findings.filter((f) => codes.has(f.scenario_code)).map((f) => ({ id: f.id, title: f.title, category: f.category, status: f.status, scenarioCode: f.scenario_code })),
  };
}

const groupRank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
const flowRank = (f) => { const i = FLOW_ORDER.indexOf(f); return i === -1 ? FLOW_ORDER.length : i; };
function compareRows(a, b) {
  return flowRank(a.flow) - flowRank(b.flow) || a.flow.localeCompare(b.flow)
    || groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label);
}

// Under an after-sale flow, only what the after-sale itself tests (its
// partial refund scope, its IROPS code): the trip, passengers, currency… of
// such a scenario belong to the sale before it, and listing them under the
// refund read as if the refund tested them.
const AFTER_SALE_ELEMENTS = ['partialRefund:', 'overrule:', 'fareSalesFlow:REFUND_FULL', 'fare:statedRefundFee', 'fareCombination:'];
function shownUnder(flow, id) {
  return flow === 'SALE' || AFTER_SALE_ELEMENTS.some((p) => id.startsWith(p));
}

// One cell per (flow, element): its scenarios, group, label, declaration and
// whether a scenario of it is warned for it.
function cellsOf(exercised, fw, declaredRows) {
  const declaredIds = new Set(declaredRows.keys());
  const cells = new Map();
  const add = (flow, element, item, info) => {
    const key = `${flow}|${element}`;
    if (!cells.has(key)) cells.set(key, { flow, element, codes: [], warned: false, ...info() });
    const cell = cells.get(key);
    cell.codes.push(item.scenario.code);
    if (item.warned.has(element)) cell.warned = true;
  };
  for (const item of exercised) {
    // A flow the framework leaves out is not supported, warned or not: #218
    // warns about the flags of a flow, not about a scenario's type.
    add(item.flow, null, item, () => {
      const declaration = declarationOf(`salesFlow:${item.flow}`, fw, declaredIds);
      return { group: WHOLE_FLOW, label: `${flowLabel(item.flow)} (every scenario)`, declaration, warned: declaration === 'not-declared' };
    });
    for (const id of item.ids) {
      if (id.startsWith('salesFlow:') || !shownUnder(item.flow, id)) continue;
      add(item.flow, id, item, () => ({ ...describe(id, declaredRows), declaration: declarationOf(id, fw, declaredIds) }));
    }
  }
  return cells;
}

/**
 * The coverage by flow and element, and one row per scenario.
 *   framework, datafile, runs, findings, collectionVersion  as coverageOf()
 *   refusals  { code: [warning lines of its latest run] }
 * -> { matrix: [row], scenarios: [row] }
 */
function coverageMatrixOf({ framework, datafile, runs = {}, findings = [], collectionVersion = null, refusals = {}, catalogue = [] }) {
  const fw = frameworkOf(framework);
  const scenarios = arr(datafile?.scenarios).filter((s) => isObj(s) && typeof s.code === 'string' && s.code !== '');
  const defaultCurrency = currenciesOf(fw).default;
  const declaredRows = new Map(declaredFunctions(fw).map((f) => [f.id, f]));
  const warnings = new Map(notDeclaredOf(datafile, framework).map((n) => [n.code, n.warnings]));
  const exercised = scenarios.map((s) => {
    const ids = withDefaultCurrency(functionsOf(s, datafile, { framework: fw, entry: catalogueEntryForScenario(s.code, catalogue) }), defaultCurrency);
    return { scenario: s, ids, flow: mainFlowOf(s, ids), warned: warnedElements(warnings.get(s.code), ids) };
  });
  const entries = new Map(scenarios.map((s) => [s.code, scenarioEntry(s, runs[s.code] || null, { collectionVersion })]));
  const refusalsOf = {};
  for (const s of scenarios) refusalsOf[s.code] = providerRefusalsOf(refusals[s.code]);
  const context = { entries, refusals: refusalsOf, findings: arr(findings).filter((f) => f && f.status !== 'resolved' && typeof f.scenario_code === 'string') };
  const matrix = [...cellsOf(exercised, fw, declaredRows).values()].map((c) => rowOf(c.flow, c.element, c, context));
  matrix.push(...declaredNotSupportedRows(fw));
  matrix.sort(compareRows);
  const scenarioRows = exercised.map(({ scenario, ids, flow }) => {
    const entry = entries.get(scenario.code);
    return {
      code: scenario.code, description: typeof scenario.description === 'string' ? scenario.description : '',
      flow, flowLabel: flowLabel(flow),
      elements: [...ids].filter((id) => !id.startsWith('salesFlow:')).map((id) => describe(id, declaredRows).label),
      result: entry.result, run: entry.run || null, toRunAgain: entry.toRunAgain,
      notDeclared: warnings.get(scenario.code) || [], providerNotSupported: refusalsOf[scenario.code],
    };
  });
  return { matrix, scenarios: scenarioRows };
}

module.exports = { coverageMatrixOf, providerRefusalsOf, declarationOf, mainFlowOf, warnedElements, RESULT_TEXT };
