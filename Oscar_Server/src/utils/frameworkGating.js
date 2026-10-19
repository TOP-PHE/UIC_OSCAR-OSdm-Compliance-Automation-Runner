// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * frameworkGating.js — pure helpers that enforce the "framework declares =>
 * scenario may exercise" rule.
 *
 * The Test Framework (per-company config in test_frameworks.config) declares
 * the OSDM capabilities the provider implements. Scenarios in the datafile
 * arm those capabilities (e.g. `partialRefundByLeg='on'`). The golden rule:
 * a scenario must not arm a capability the framework hasn't declared,
 * because there is no way to verify the result of an undeclared capability.
 *
 * This module is the single source of truth for the mapping between a
 * scenario field and the framework declaration it depends on, used by:
 *
 *   1. Server lazy migration (company-test-framework.js GET): derives the
 *      missing salesFlows entries from existing scenarios so an upgrade
 *      doesn't silently break a Test Manager's running configuration. The
 *      migration is conservative — it ADDS declarations to match the
 *      scenarios; it never removes anything.
 *
 *   2. Server datafile annotator (company.js GET /datafile): when the
 *      datafile is served to Bruno, each scenario whose armed field
 *      isn't declared in the current framework gets a
 *      `__featureNotDeclaredWarnings: [field, ...]` array — the Bruno
 *      collection emits a [WARNING] log line per entry at scenario load.
 *
 *   3. Wizard UI (scenarios.js): inline ⚠ chip next to an armed-but-not-
 *      declared dropdown, and a top-of-page banner with the count of
 *      scenarios in that state.
 *
 * Scope today (#218 follow-up):
 *   - partialRefundByLeg / partialRefundByPax  ↔  salesFlows: REFUND_PARTIAL
 *     and, when the framework lists them, partialRefundScopes (#713)
 *   - a return's model (offerSearchCriteria.returnModel)  ↔  returnModels (#619)
 *   - the offer request's form (trip type, trip ids)  ↔  offerRequestForms (#748),
 *     in annotateDatafile only: it reads the scenario's trip entry
 *   - the place selection flow (placeSelectionFlow, or the place fields)  ↔
 *     placeSelectionFlows (#766)
 *   - (future) partialExchangeByLeg / partialExchangeByPax  ↔  EXCHANGE_PARTIAL
 *   - (future) requestedInformationProbe                    ↔  ???
 *
 * The function `gatingRules()` returns the active rule table. Each rule has:
 *   - `field`            : the scenario field to inspect
 *   - `isArmed(value)`   : returns true when the field value represents "ON"
 *   - `requiresFlow`     : the salesFlows[] entry that must be declared
 *   - `requiresScenarioType` : optional, scopes the rule to a scenario type
 *   - `scope`            : optional, the partialRefundScopes entry it needs
 */

// #619: the return models a Test Framework may declare (framework.returnModels),
// as the collection names them (library-bruno/returnJourney.js).
const RETURN_MODELS = ['SEPARATE', 'COMBINED'];

// #713: how a provider takes a partial refund (framework.partialRefundScopes).
// Absent = every scope (frameworks from before 1.11.271); [] = none.
const PARTIAL_REFUND_SCOPES = ['FULFILLMENT', 'LEG', 'PASSENGER'];

// #748: how a provider takes an offer request (framework.offerRequestForms):
// by trip search (tripSearchCriteria), by trip specification
// (tripSpecifications), by trip id (tripIds). Absent = every form
// (frameworks from before 1.11.289); [] = none.
const OFFER_REQUEST_FORMS = ['SEARCH', 'SPECIFICATION', 'TRIP_IDS'];
const OFFER_REQUEST_TEXT = Object.freeze({
  SEARCH: 'by trip search', SPECIFICATION: 'by trip specification', TRIP_IDS: 'by trip id',
});

// #766: how a provider lets a place be chosen (framework.placeSelectionFlows),
// OSDM's PlaceSelectionFlow. Absent = every flow (frameworks from before
// 1.11.297); [] = none.
const PLACE_SELECTION_FLOWS = [
  'AUTOMATIC_PLACE_SELECTION',
  'AUTOMATIC_PLACE_SELECTION_PREFERENCES',
  'AUTOMATIC_PLACE_SELECTION_NEARBY',
  'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
  'MANUAL_PLACE_SELECTION_WITH_FEE',
];
const PLACE_SELECTION_TEXT = Object.freeze({
  AUTOMATIC_PLACE_SELECTION: 'by accommodation and place properties',
  AUTOMATIC_PLACE_SELECTION_PREFERENCES: 'by the available preferences',
  AUTOMATIC_PLACE_SELECTION_NEARBY: 'next to a given place',
  MANUAL_PLACE_SELECTION_WITHOUT_FEE: 'of a named place, without fee',
  MANUAL_PLACE_SELECTION_WITH_FEE: 'of a named place, with a fee',
});

// #780: the offer search options a provider takes (framework.offerSearchOptions):
// per OSDM OfferSearchCriteria member, the values it supports. A key absent =
// every value (frameworks from before 1.11.306); [] = none. `field` is the
// member of a scenario's offerSearchCriteria that holds it.
const PRODUCT_TAGS = Object.freeze(['ADMISSION_POINT2POINT', 'ADMISSION_MULTI_RIDE', 'ADMISSION_PASS', 'UPGRADE_POINT2POINT',
  'UPGRADE_MULTI_RIDE', 'UPGRADE_PASS', 'RESERVATION', 'SPLIT_RESERVATION', 'ANCILLARY_SERVICE', 'ANCILLARY_ITEM',
  'REDUCTION_CARD', 'CARD_LOST', 'TICKET_LOST']);

// #780 PR A: the forms of a scenario's productSelections entries.
function selectionForms(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const forms = [];
  for (const s of list) {
    if (typeof s?.productCode === 'string' && s.productCode.trim() !== '') forms.push('PRODUCT_CODE');
    else if (typeof s?.productTag === 'string' && s.productTag.trim() !== '') forms.push('PRODUCT_TAG');
  }
  return forms;
}

const OFFER_SEARCH_OPTIONS = Object.freeze({
  offerModes: { member: 'offerMode', field: 'offerMode', values: ['INDIVIDUAL', 'COLLECTIVE'] },
  requestedOfferParts: { member: 'requestedOfferParts', field: 'requestedOfferParts', values: ['ADMISSION', 'RESERVATION', 'ANCILLARY', 'FARE_ADMISSION', 'FARE_RESERVATION', 'FARE_ANCILLARY', 'CONTINUOUS_SERVICE', 'ALL'] },
  travelClasses: { member: 'travelClasses', field: 'travelClass', values: ['FIRST', 'SECOND', 'ANY_CLASS'] },
  serviceClassTypes: { member: 'serviceClassTypes', field: 'serviceClass', values: ['BEST', 'HIGH', 'STANDARD', 'BASIC', 'ANY_CLASS'] },
  // #780 PR A: the OSDM ProductTag list (extensible: a tag outside it is not
  // declarable, and warns as not declared only when a list is declared).
  productTags: { member: 'productTags', field: 'productTags', values: PRODUCT_TAGS },
  // How products are selected: an entry naming a productCode, or a productTag.
  productSelections: { member: 'productSelections', field: 'productSelections', values: ['PRODUCT_CODE', 'PRODUCT_TAG'], valuesOf: selectionForms },
});

module.exports = {
  gatingRules,
  isScenarioArmedForField,
  scenarioWarnings,
  RETURN_MODELS,
  PARTIAL_REFUND_SCOPES,
  partialRefundScopeDeclared,
  OFFER_REQUEST_FORMS,
  OFFER_REQUEST_TEXT,
  offerRequestFormOf,
  offerRequestFormDeclared,
  PLACE_SELECTION_FLOWS,
  PLACE_SELECTION_TEXT,
  placeSelectionFlowOf,
  placeSelectionFlowDeclared,
  scenarioReturnModel,
  returnModelsUsed,
  needsFrameworkMigration,
  deriveSalesFlowsAdditions,
  applyFrameworkMigration,
  annotateDatafile,
  OFFER_SEARCH_OPTIONS,
  scenarioOfferCriteria,
  offerSearchOptionsOf,
  offerSearchOptionDeclared,
};

// Truthy values used across the codebase to mean "on" for scenario flags.
// Keep aligned with Bruno_Collection/library-bruno/scenarioParser.js (which
// treats 'on', 'true', 'yes', boolean true as armed).
const ARMED_VALUES = new Set(['on', 'true', 'yes', '1', true, 1]);


function isArmedValue(v) {
  if (v === true || v === 1) return true;
  if (v == null) return false;
  return ARMED_VALUES.has(String(v).toLowerCase());
}

/**
 * The rule table. Add new rules here as features are added.
 * Pure data — no side effects.
 */
function gatingRules() {
  return [
    {
      field: 'partialRefundByLeg',
      isArmed: isArmedValue,
      requiresFlow: 'REFUND_PARTIAL',
      requiresScenarioType: 'REFUND',
      scope: 'LEG',
      humanLabel: 'Partial refund per-leg',
    },
    {
      field: 'partialRefundByPax',
      isArmed: isArmedValue,
      requiresFlow: 'REFUND_PARTIAL',
      requiresScenarioType: 'REFUND',
      scope: 'PASSENGER',
      humanLabel: 'Partial refund per-passenger',
    },
    {
      field: 'partialRefundByFulfillment',
      isArmed: isArmedValue,
      requiresFlow: 'REFUND_PARTIAL',
      requiresScenarioType: 'REFUND',
      scope: 'FULFILLMENT',
      humanLabel: 'Partial refund per-fulfillment',
    },
  ];
}

/**
 * #713: true when the framework lets a partial refund take `scope`: no scope
 * asked, or no list declared (every scope), or the scope is in the list.
 */
function partialRefundScopeDeclared(framework, scope) {
  if (!scope) return true;
  const declared = framework?.partialRefundScopes;
  return !Array.isArray(declared) || declared.includes(scope);
}

/**
 * #748: the form of a scenario's offer request: TRIP_IDS when it asks offers
 * by trip id (offersByTripIds, or the tripIdsExpectRejection probe), else its
 * trip's type, SPECIFICATION or SEARCH (the collection's default).
 */
function offerRequestFormOf(scenario, datafile) {
  if (!scenario || typeof scenario !== 'object') return 'SEARCH';
  if (isArmedValue(scenario.offersByTripIds) || isArmedValue(scenario.tripIdsExpectRejection)) return 'TRIP_IDS';
  const trips = Array.isArray(datafile?.tripRequirements) ? datafile.tripRequirements : [];
  const trip = trips.find(t => t && typeof t === 'object' && t.id === scenario.tripRequirementId);
  return trip?.tripType === 'SPECIFICATION' ? 'SPECIFICATION' : 'SEARCH';
}

/** #748: true when the framework takes this form: no list declared, or listed. */
function offerRequestFormDeclared(framework, form) {
  const declared = framework?.offerRequestForms;
  return !Array.isArray(declared) || declared.includes(form);
}

/**
 * #766: the place selection flow a scenario exercises, or null when it
 * chooses no place: its own `placeSelectionFlow` when it names one, else what
 * its place fields send. A seat taken from the seat map (placeSelectionMode)
 * is a named place; a couchette or berth (accommodationSelection), or a
 * reservation booked by placeSelections without a place (reservationBookingForm
 * PLACE_SELECTION), is an automatic selection. Kept alike with
 * library-bruno/placeSelection.js (flowOfScenario), pinned by a test.
 */
function placeSelectionFlowOf(scenario) {
  if (!scenario || typeof scenario !== 'object') return null;
  const own = String(scenario.placeSelectionFlow || '').trim().toUpperCase();
  if (PLACE_SELECTION_FLOWS.includes(own)) return own;
  const mode = String(scenario.placeSelectionMode || '').trim().toUpperCase();
  if (mode === 'SEATMAP_AT_OFFER' || mode === 'ADD_TO_BOOKING') return 'MANUAL_PLACE_SELECTION_WITHOUT_FEE';
  const accommodation = String(scenario.accommodationSelection || '').trim().toUpperCase();
  if (accommodation === 'COUCHETTE' || accommodation === 'BERTH') return 'AUTOMATIC_PLACE_SELECTION';
  if (String(scenario.reservationBookingForm || '').trim().toUpperCase() === 'PLACE_SELECTION') return 'AUTOMATIC_PLACE_SELECTION';
  const raw = scenario.placePreferences;
  let preferences = Array.isArray(raw) ? raw : [];
  if (typeof raw === 'string') preferences = raw.split(/[\s,;]+/);
  if (preferences.some((p) => typeof p === 'string' && p.trim() !== '')) return 'AUTOMATIC_PLACE_SELECTION';
  return null;
}

/**
 * #780: the offerSearchCriteria a scenario sends, as the collection resolves
 * it (scenarioParser): its own, else the first of its offerSearchCriteriaList
 * entry. null when it has none.
 */
function scenarioOfferCriteria(scenario, datafile) {
  if (!scenario || typeof scenario !== 'object') return null;
  if (scenario.offerSearchCriteria && typeof scenario.offerSearchCriteria === 'object') return scenario.offerSearchCriteria;
  if (scenario.offerSearchCriteriaListId == null) return null;
  const lists = Array.isArray(datafile?.offerSearchCriteriaList) ? datafile.offerSearchCriteriaList : [];
  const entry = lists.find((e) => e && typeof e === 'object' && e.id === scenario.offerSearchCriteriaListId);
  const first = Array.isArray(entry?.offerSearchCriteria) ? entry.offerSearchCriteria[0] : null;
  return first && typeof first === 'object' ? first : null;
}

/** #780: the values of each offer search option a scenario sends, by framework key. */
function offerSearchOptionsOf(scenario, datafile) {
  const criteria = scenarioOfferCriteria(scenario, datafile) || {};
  const out = {};
  for (const [key, { field, valuesOf }] of Object.entries(OFFER_SEARCH_OPTIONS)) {
    const raw = criteria[field];
    let list = Array.isArray(raw) ? raw : [raw];
    if (valuesOf) list = valuesOf(raw);
    out[key] = [...new Set(list.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
  }
  return out;
}

/** #780: true when the framework takes this value of the option: no list, or listed. */
function offerSearchOptionDeclared(framework, key, value) {
  const declared = framework?.offerSearchOptions?.[key];
  return !Array.isArray(declared) || declared.includes(value);
}

/** #766: true when the framework lets a place be chosen this way: no flow, no list, or listed. */
function placeSelectionFlowDeclared(framework, flow) {
  if (!flow) return true;
  const declared = framework?.placeSelectionFlows;
  return !Array.isArray(declared) || declared.includes(flow);
}

/**
 * True if scenario[field] represents an armed value AND the rule applies
 * to this scenario's type. Returns false for unrelated scenario types.
 */
function isScenarioArmedForField(scenario, rule) {
  if (!scenario || !rule) return false;
  if (rule.requiresScenarioType) {
    const t = String(scenario.scenarioType || 'SALE').toUpperCase();
    if (t !== rule.requiresScenarioType) return false;
  }
  return rule.isArmed(scenario[rule.field]);
}

/**
 * Return the list of fields the scenario has armed but the framework
 * hasn't declared. Empty array when the scenario is fully covered.
 */
function scenarioWarnings(scenario, framework, rules) {
  rules = rules || gatingRules();
  const flows = (framework && Array.isArray(framework.salesFlows)) ? framework.salesFlows : [];
  const out = [];
  for (const rule of rules) {
    if (!isScenarioArmedForField(scenario, rule)) continue;
    if (flows.includes(rule.requiresFlow) && partialRefundScopeDeclared(framework, rule.scope)) continue;
    out.push(rule.field);
  }
  // #619: a return whose model the framework does not list. A framework with
  // no returnModels at all has not been asked yet (before 1.11.236): no
  // warning until the lazy migration below has filled it in.
  const model = scenarioReturnModel(scenario);
  const declared = Array.isArray(framework?.returnModels) ? framework.returnModels : null;
  if (model && declared && !declared.includes(model)) out.push('returnModel');
  return out;
}

/**
 * #619: the return model a scenario asks for, or null when it has no return.
 * A return is a non-negative whole offerSearchCriteria.returnOffsetDays, as
 * the collection reads it (scenarioParser buildReturnSearchParameters); the
 * model defaults to SEPARATE, as normaliseReturnModel does.
 */
function scenarioReturnModel(scenario) {
  const c = scenario && typeof scenario === 'object' ? scenario.offerSearchCriteria : null;
  if (!c || typeof c !== 'object' || c.returnOffsetDays == null || c.returnOffsetDays === '') return null;
  const offset = Number.parseInt(c.returnOffsetDays, 10);
  if (!Number.isInteger(offset) || offset < 0) return null;
  return RETURN_MODELS.includes(c.returnModel) ? c.returnModel : 'SEPARATE';
}

/** #619: the return models the scenarios use, in RETURN_MODELS order. */
function returnModelsUsed(scenarios) {
  const used = new Set();
  for (const sc of (Array.isArray(scenarios) ? scenarios : [])) {
    const model = scenarioReturnModel(sc);
    if (model) used.add(model);
  }
  return RETURN_MODELS.filter(m => used.has(m));
}

/** True when applyFrameworkMigration still has something to do. */
function needsFrameworkMigration(framework) {
  if (!framework || typeof framework !== 'object') return false;
  return !framework._salesFlowsMigratedAt || !Array.isArray(framework.returnModels);
}

/**
 * Walk all scenarios; return the set of `requiresFlow` strings that should
 * be added to `framework.salesFlows[]` to cover everything that's currently
 * armed. Conservative: only ADDS, never removes — so the migration never
 * silently breaks a Test Manager's existing configuration.
 *
 * @param {object[]} scenarios
 * @param {object}   framework
 * @returns {string[]} flow entries to add (no duplicates)
 */
function deriveSalesFlowsAdditions(scenarios, framework) {
  const rules = gatingRules();
  const have  = new Set((framework && Array.isArray(framework.salesFlows)) ? framework.salesFlows : []);
  const want  = new Set();
  for (const sc of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const rule of rules) {
      if (isScenarioArmedForField(sc, rule)) want.add(rule.requiresFlow);
    }
  }
  const additions = [];
  for (const flow of want) {
    if (!have.has(flow)) additions.push(flow);
  }
  return additions;
}

/**
 * Apply the lazy migration to a framework config in place. Returns
 * `{ migrated: boolean, additions: string[] }`. Caller decides whether to
 * persist the result.
 *
 * Idempotent: when `_salesFlowsMigratedAt` is already set, the migration
 * skips (no second derivation). When there is nothing to add, the stamp is
 * still set so we don't keep re-scanning every GET. `returnModels` (#619) is
 * derived the same way, once, when the framework has none.
 *
 * @param {object} framework  the decrypted config object (mutated)
 * @param {object[]} scenarios  the company datafile scenarios array (may be empty)
 * @param {string} nowIso  ISO timestamp for the audit stamp
 * @returns {{migrated: boolean, additions: string[]}}
 */
function applyFrameworkMigration(framework, scenarios, nowIso) {
  if (!framework || typeof framework !== 'object') {
    return { migrated: false, additions: [] };
  }
  let migrated = false;
  let additions = [];
  if (!framework._salesFlowsMigratedAt) {
    if (!Array.isArray(framework.salesFlows)) framework.salesFlows = [];
    additions = deriveSalesFlowsAdditions(scenarios, framework);
    if (additions.length > 0) {
      framework.salesFlows = [...framework.salesFlows, ...additions];
    }
    framework._salesFlowsMigratedAt = nowIso || new Date().toISOString();
    migrated = true;
  }
  // #619: a framework from before returnModels declares what its scenarios
  // already use, so an upgrade adds no warning. Once the list exists (even
  // empty) it is the Test Manager's and is never derived again.
  if (!Array.isArray(framework.returnModels)) {
    framework.returnModels = returnModelsUsed(scenarios);
    migrated = true;
  }
  return { migrated, additions };
}

// One scenario's warnings, including those that need the data file.
function datafileScenarioWarnings(sc, framework, datafile) {
  const warnings = scenarioWarnings(sc, framework);
  // #748: an offer request in a form the framework does not take. Named
  // with the form, so that the collection can say which.
  const form = offerRequestFormOf(sc, datafile);
  if (!offerRequestFormDeclared(framework, form)) warnings.push(`offerRequestBy:${form}`);
  // #766: a place chosen in a way the framework does not declare.
  const flow = placeSelectionFlowOf(sc);
  if (!placeSelectionFlowDeclared(framework, flow)) warnings.push(`placeSelectionBy:${flow}`);
  // #780: an offer search option value the framework does not declare,
  // unless that is the point of the scenario (the PR C probe).
  const optionProbe = isArmedValue(sc.offerOptionExpectRejection);
  for (const [key, values] of Object.entries(optionProbe ? {} : offerSearchOptionsOf(sc, datafile))) {
    for (const value of values) if (!offerSearchOptionDeclared(framework, key, value)) warnings.push(`offerOption:${key}=${value}`);
  }
  // #781: a currency the framework does not declare, unless that is the
  // point of the scenario (the not-sold probe).
  const currency = scenarioOfferCriteria(sc, datafile)?.currency;
  if (typeof currency === 'string' && currency && !isArmedValue(sc.currencyExpectRejection)
      && !require('./currencies').currencyDeclared(framework, currency)) warnings.push(`currency:${currency}`);
  // #809: a passenger update or a late purchaser the provider does not offer.
  warnings.push(...require('./undeclaredSteps').undeclaredStepWarnings(sc, framework));
  // #780 PR B: a trip search parameter the framework does not declare.
  const { tripSearchParametersOf, tripSearchParameterDeclared } = require('./tripSearchParameters');
  for (const name of tripSearchParametersOf(sc, datafile)) {
    if (!tripSearchParameterDeclared(framework, name)) warnings.push(`tripParameter:${name}`);
  }
  return warnings;
}

/**
 * Annotate a datafile object in place: each scenario that arms an
 * undeclared feature gets `__featureNotDeclaredWarnings: [field, ...]`, and
 * one whose offer request form is not declared `offerRequestBy:<form>` (#748),
 * one whose place selection flow is not declared `placeSelectionBy:<flow>` (#766),
 * one per offer search option value not declared `offerOption:<key>=<value>` (#780),
 * one per trip search parameter not declared `tripParameter:<NAME>` (#780 PR B).
 * Removes the field when there are no warnings (avoids stale annotations
 * surviving a framework change).
 *
 * @param {object} datafile  parsed datafile (mutated)
 * @param {object} framework  the framework config
 * @returns {{annotatedCount: number}}
 */
function annotateDatafile(datafile, framework) {
  if (!datafile || !Array.isArray(datafile.scenarios)) return { annotatedCount: 0 };
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (!sc || typeof sc !== 'object') continue; // a Test Manager's save can store null
    const warnings = datafileScenarioWarnings(sc, framework, datafile);
    if (warnings.length > 0) {
      sc.__featureNotDeclaredWarnings = warnings;
      count++;
    } else if (Object.hasOwn(sc, '__featureNotDeclaredWarnings')) {
      delete sc.__featureNotDeclaredWarnings;
    }
  }
  return { annotatedCount: count };
}
