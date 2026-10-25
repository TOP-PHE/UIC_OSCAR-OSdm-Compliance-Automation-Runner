// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offerOptionDiscovery.js — what the Test Framework tells the offer request
 * options scenario (#227, part 2). Pure.
 *
 * The framework holds:
 *   offerOptionDiscovery: { maxRequests, invalidValues }   the ceiling of
 *     requests (3 to 200; absent = 30) and what to do with an option only the
 *     provider can give a value for ('random', the default, or 'skip');
 *   corporateCodes: [{ code, issuer }]   the provider's corporate codes;
 *   promotionCodes: [{ code }]           its promotion codes.
 *
 * The run's copy (`withOfferOptionDeclarations()`) gives each discovery
 * scenario the ceiling and the choice (its own win), the values the framework
 * declares (`offerOptionValues`, its own win) and, in `__offerOptionDeclared`,
 * which options the framework says the provider supports (true) or not
 * (false). Only what is explicitly declared is named there: an absent list
 * means "every value" elsewhere in the framework, and the collection compares
 * nothing for it. The collection fails a declared option the provider refuses
 * or ignores (a finding draft, #735) and suggests declaring one it supports.
 */

const { declaredCards } = require('./reductionCards');
const { declaredProducts } = require('./namedProducts');
const { currenciesOf } = require('./currencies');

const MIN_REQUESTS = 3;
const MAX_REQUESTS = 200;
const INVALID_VALUES = ['random', 'skip'];
const MAX_CODES = 20;
const ARMED = new Set(['on', 'true', 'yes', true]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const frameworkOf = (fw) => (isObj(fw?.config) ? fw.config : fw);

/** The provider's codes of one list ({ code, issuer? }), each code once. */
function codesOf(list, withIssuer) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const code = text(entry?.code);
    if (!code || out.some((c) => c.code === code)) continue;
    const issuer = text(entry?.issuer);
    out.push(withIssuer && issuer ? { code, issuer } : { code });
    if (out.length === MAX_CODES) break;
  }
  return out;
}

const codeProblem = (key, list, withIssuer) => {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > MAX_CODES) return `${key} must be a list of at most ${MAX_CODES} codes.`;
  const bad = list.find((e) => !isObj(e) || typeof e.code !== 'string' || e.code.length > 60
    || (withIssuer && e.issuer !== undefined && (typeof e.issuer !== 'string' || e.issuer.length > 200)));
  if (bad !== undefined) return `${key} holds an entry that is not { code${withIssuer ? ', issuer' : ''} } (text, code up to 60 characters).`;
  // The run's copy carries these codes, and Bruno fills in {{...}} wherever a
  // value is read: {{access_token}} would put the run's token in its log.
  return list.some((e) => `${e.code}${e.issuer || ''}`.includes('{{')) ? `${key} holds "{{", which a run would read as a template.` : null;
};

/**
 * Why the framework's discovery settings or codes cannot be stored, or null.
 * Answered as a 400 by the framework's writers.
 */
function offerOptionDiscoveryProblem(fw) {
  const value = fw?.offerOptionDiscovery;
  if (value !== undefined) {
    if (!isObj(value)) return 'offerOptionDiscovery must be an object: { maxRequests, invalidValues }.';
    const unknown = Object.keys(value).filter((k) => !['maxRequests', 'invalidValues'].includes(k));
    if (unknown.length > 0) return `offerOptionDiscovery holds ${unknown.map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}, which it does not know: maxRequests, invalidValues.`;
    const n = value.maxRequests;
    if (n !== undefined && n !== null && !(Number.isInteger(n) && n >= MIN_REQUESTS && n <= MAX_REQUESTS)) {
      return `offerOptionDiscovery.maxRequests must be a whole number from ${MIN_REQUESTS} to ${MAX_REQUESTS}.`;
    }
    if (value.invalidValues !== undefined && value.invalidValues !== null && !INVALID_VALUES.includes(value.invalidValues)) {
      return `offerOptionDiscovery.invalidValues must be ${INVALID_VALUES.join(' or ')}.`;
    }
  }
  return codeProblem('corporateCodes', fw?.corporateCodes, true) || codeProblem('promotionCodes', fw?.promotionCodes, false);
}

// The first value of an explicit list, less the values that ask nothing.
const firstOf = (list, skip = []) => (Array.isArray(list) ? list.find((v) => typeof v === 'string' && !skip.includes(v)) : undefined);

// Trip search parameters (#780 PR B) and the options that send them.
const TRIP_PARAMETER_OPTIONS = [
  ['ARRIVAL_TIME', 'tripSearchCriteria.arrivalTime'],
  ['VIAS', 'tripSearchCriteria.vias'],
  ['NOT_VIAS', 'tripSearchCriteria.notVias'],
  ['NUMBER_OF_RESULTS', 'tripSearchCriteria.parameters'],
];

// Offer search options (#780) that are lists of values, and their option keys.
const SEARCH_OPTIONS = [
  ['productTags', 'offerSearchCriteria.productTags', []],
  ['travelClasses', 'offerSearchCriteria.travelClasses', ['ANY_CLASS']],
  ['serviceClassTypes', 'offerSearchCriteria.serviceClassTypes', ['ANY_CLASS']],
];

// The provider's own values: first card, product, currency, flexibility.
function declareProviderValues(fw, offer) {
  const cards = declaredCards(fw);
  if (cards.length > 0) {
    const [card] = cards;
    offer('passenger.cards', [{ type: 'REDUCTION_CARD', code: card.code, ...(card.issuer ? { issuer: card.issuer } : {}) }]);
  }
  const products = declaredProducts(fw);
  if (products.length > 0) offer('offerSearchCriteria.productSelections', [{ productCode: products[0].code }]);
  const { sold, default: def } = currenciesOf(fw);
  if (sold.length > 0) offer('offerSearchCriteria.currency', def || sold[0]);
  const flexibility = firstOf(fw.offerCriteria?.flexibilities);
  if (flexibility) offer('offerSearchCriteria.flexibilities', [flexibility]);
}

// An explicit list: its first value is sent; an empty one declares the option unsupported.
function declareList(list, key, value, offer, declared) {
  if (!Array.isArray(list)) return;
  if (value) offer(key, [value]);
  else declared[key] = false;
}

/**
 * What the framework declares for the discovery:
 * { values: { optionKey: value }, declared: { optionKey: true|false } }.
 */
function declarationsOf(framework) {
  const fw = frameworkOf(framework) || {};
  const values = {};
  const declared = {};
  const offer = (key, value) => {
    values[key] = value;
    declared[key] = true;
  };
  declareProviderValues(fw, offer);
  for (const [member, key, skip] of SEARCH_OPTIONS) {
    const list = fw.offerSearchOptions?.[member];
    declareList(list, key, firstOf(list, skip), offer, declared);
  }
  declareList(fw.corporateCodes, 'corporateCodes', codesOf(fw.corporateCodes, true)[0], offer, declared);
  declareList(fw.promotionCodes, 'promotionCodes', codesOf(fw.promotionCodes, false)[0], offer, declared);
  if (Array.isArray(fw.tripSearchParameters)) {
    for (const [name, key] of TRIP_PARAMETER_OPTIONS) declared[key] = fw.tripSearchParameters.includes(name);
  }
  if (Array.isArray(fw.distributionModes)) declared.requestedSections = fw.distributionModes.includes('FARE');
  return { values, declared };
}

/**
 * The run's copy of a data file (changed in place): each scenario arming the
 * discovery gets the framework's ceiling, choice, values and declarations,
 * its own settings kept. Returns how many scenarios it changed.
 */
function withOfferOptionDeclarations(datafile, framework) {
  if (!isObj(datafile) || !Array.isArray(datafile.scenarios)) return 0;
  const armed = datafile.scenarios.filter((s) => isObj(s) && ARMED.has(s.offerOptionDiscovery));
  if (armed.length === 0) return 0;
  const fw = frameworkOf(framework) || {};
  const settings = isObj(fw.offerOptionDiscovery) ? fw.offerOptionDiscovery : {};
  const { values, declared } = declarationsOf(fw);
  for (const scenario of armed) {
    if (scenario.offerOptionMaxRequests == null && Number.isInteger(settings.maxRequests)) scenario.offerOptionMaxRequests = settings.maxRequests;
    if (!scenario.offerOptionInvalidValues && INVALID_VALUES.includes(settings.invalidValues)) scenario.offerOptionInvalidValues = settings.invalidValues;
    const own = isObj(scenario.offerOptionValues) ? scenario.offerOptionValues : {};
    if (Object.keys(values).length > 0) scenario.offerOptionValues = { ...values, ...own };
    scenario.__offerOptionDeclared = declared;
  }
  return armed.length;
}

// A code the framework's writers take (see codeProblem).
const storable = (c) => c.code.length <= 60 && (c.issuer || '').length <= 200 && !`${c.code}${c.issuer || ''}`.includes('{{');

/**
 * #227 part 3: the checklist's answers for the discovery, over `framework`
 * (changed in place). A2.5 `fw.offerOptionDiscovery.maxRequests` and P1.21
 * `fw.offerOptionDiscovery.invalidValues` are placed by
 * `frameworkFromChecklist()`; a ceiling outside 3 to 200, or a choice it does
 * not know, is dropped here, so an import never stores what the framework's
 * writers refuse. P1.19 / P1.20 are tables (`data.corporateCode.<n>.code|issuer`,
 * `data.promotionCode.<n>.code`): NO is an empty list, unanswered changes
 * nothing.
 */
function withOfferOptionChecklist(framework, answers) {
  const settings = framework.offerOptionDiscovery;
  if (isObj(settings)) {
    const n = settings.maxRequests;
    if (n !== undefined && !(Number.isInteger(n) && n >= MIN_REQUESTS && n <= MAX_REQUESTS)) delete settings.maxRequests;
    if (settings.invalidValues !== undefined && !INVALID_VALUES.includes(settings.invalidValues)) delete settings.invalidValues;
    if (Object.keys(settings).length === 0) delete framework.offerOptionDiscovery;
  }
  const { rowsFromChecklist } = require('./namedProducts');
  const corporate = rowsFromChecklist(answers, 'corporateCodes', 'corporateCode', ['code', 'issuer']);
  if (corporate) framework.corporateCodes = codesOf(corporate, true).filter(storable);
  const promotion = rowsFromChecklist(answers, 'promotionCodes', 'promotionCode', ['code']);
  if (promotion) framework.promotionCodes = codesOf(promotion, false).filter(storable);
  return framework;
}

module.exports = {
  MIN_REQUESTS, MAX_REQUESTS, INVALID_VALUES, codesOf, offerOptionDiscoveryProblem, declarationsOf, withOfferOptionDeclarations,
  withOfferOptionChecklist,
};
