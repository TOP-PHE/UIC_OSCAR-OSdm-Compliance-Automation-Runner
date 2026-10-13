// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * catalogueMatch.js — reference scenarios adapted to the company they are
 * copied into (#681, part 2). Pure: plain objects in, plain objects out.
 *
 * A reference scenario comes from the simulator's data file. Before it is
 * copied, adaptReferenceScenario() replaces what only the simulator's
 * provider gives with what the company's Test Framework declares (an overrule
 * code), removes what cannot be guessed (a product code), takes a tariff
 * the framework declares that fits the after-sale, and says what is left: `toComplete` (the
 * scenario cannot run as it is) and `toCheck` (it can, if the provider's data
 * has what it needs and OSCAR cannot see it in the Test Data: a mandatory
 * reservation, a first class, passenger details asked for).
 *
 * suggestTrip() proposes, for each trip of the copy, the train or journey of
 * the company's Test Data to use: a journey of as many legs when the trip has
 * several, else the first train. The person copying can change it.
 */

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ARMED = new Set(['on', 'true', 'yes', true]);

// The overrule codes OSDM lists (the ones the editor offers, #596).
const OVERRULE_CODES = [
  'CONNECTION_BROKEN', 'SALES_STAFF_ERROR', 'STRIKE', 'TECHNICAL_FAILURE',
  'DISRUPTION', 'PAYMENT_FAILURE', 'DELAY_COMPENSATION', 'DEATH',
  'INABILITY_TO_TRAVEL', 'JOURNEY_OBSOLETE', 'CERTIFIED_MEDICAL_CONDITION',
  'EQUIPMENT_FAILURE', 'PRM_SUPPORT_UNAVAILABLE', 'STOP_NOT_SERVED',
  'TICKET_NOT_USED', 'EXTERNAL_COMPENSATION',
];

/** The framework config as stored (legacy rows nest it under `config`). */
function frameworkOf(config) {
  if (isObj(config) && isObj(config.config)) return config.config;
  return isObj(config) ? config : {};
}

// The overrule code a copied scenario sends: one the framework declares for
// refunds, or for the refusal probe (#596) one it does not. `null` when there
// is none to take.
function overruleFor(scenario, framework) {
  const declared = arr(framework.iropsCodes?.refund).filter((c) => typeof c === 'string' && c !== '');
  if (ARMED.has(scenario.overruleCodeExpectRejection)) {
    return OVERRULE_CODES.find((c) => !declared.includes(c)) || null;
  }
  return declared.includes(scenario.overruleCode) ? scenario.overruleCode : (declared[0] || null);
}

// Most flexible first: the order in which an after-sale tariff is chosen.
const FLEXIBILITIES = ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'];

// The flexibilities the Test Framework declares.
const declaredFlexibilities = (framework) => arr(framework.offerCriteria?.flexibilities)
  .filter((f) => typeof f === 'string' && f !== '');

// The flexibility of an after-sale scenario (#687). The scenario's own when
// the framework declares it, unless it is the non-flexible one; else the most
// flexible the framework declares. A provider may sell only non-flexible
// tariffs and still refund them: then NON_FLEXIBLE, never a flexibility it
// does not sell. With nothing declared, FULL_FLEXIBLE, as before.
function afterSaleFlexibility(own, framework) {
  const declared = declaredFlexibilities(framework);
  if (!declared.length) return own && own !== 'NON_FLEXIBLE' ? own : 'FULL_FLEXIBLE';
  if (own && own !== 'NON_FLEXIBLE' && declared.includes(own)) return own;
  return FLEXIBILITIES.find((f) => declared.includes(f)) || declared[0];
}

// The flexibility of any other scenario that asks for one (#691): its own
// when the framework declares it, else the most flexible declared. With
// nothing declared, unchanged.
function saleFlexibility(own, framework) {
  const declared = declaredFlexibilities(framework);
  if (!declared.length || declared.includes(own)) return own;
  return FLEXIBILITIES.find((f) => declared.includes(f)) || declared[0];
}

// What a reference scenario needs that OSCAR cannot see in the Test Data.
function needsToCheck(needs) {
  const out = [];
  for (const kind of arr(needs.reservations)) {
    out.push(`the chosen train must carry ${kind === 'MANDATORY' ? 'a mandatory' : 'an optional'} seat reservation`);
  }
  if (arr(needs.legClasses).length) out.push(`each leg must be sold in its class: ${needs.legClasses.join(', ')}`);
  if (needs.requestedInformation) out.push('the provider must ask for passenger details on the chosen trip');
  if (needs.reductionCards) out.push('the passengers\' reduction cards must be ones the provider accepts');
  return out;
}

/**
 * A reference scenario as it is copied into a company with this framework:
 * { scenario, toComplete, toCheck }. The scenario given is not changed.
 */
function adaptReferenceScenario(scenario, needs, frameworkConfig) {
  const framework = frameworkOf(frameworkConfig);
  const n = isObj(needs) ? needs : {};
  const out = structuredClone(scenario);
  const toComplete = [];

  if (arr(n.providerValues).includes('overruleCode')) {
    const code = overruleFor(out, framework);
    out.overruleCode = code;
    if (!code) toComplete.push('an overrule code: declare the provider\'s codes for refunds in the Test Framework (IROPS)');
  }
  if (arr(n.providerValues).includes('expectedProduct')) {
    delete out.expectedProduct;
    toComplete.push('the provider\'s product (expectedProduct)');
  }
  const toCheck = needsToCheck(n);
  // An after-sale needs a tariff that allows it, among those the provider
  // sells: the Test Framework's flexibilities (#687).
  if (n.tariff === 'REFUNDABLE' || n.tariff === 'EXCHANGEABLE') {
    out.desiredFlexibility = afterSaleFlexibility(out.desiredFlexibility, framework);
    if (out.desiredFlexibility === 'NON_FLEXIBLE') {
      toCheck.push(`the provider's non-flexible tariff must allow the ${n.tariff === 'REFUNDABLE' ? 'refund' : 'exchange'}`);
    }
  } else if (out.desiredFlexibility) {
    out.desiredFlexibility = saleFlexibility(out.desiredFlexibility, framework);
  }
  return { scenario: out, toComplete, toCheck };
}

// #699: a passenger list of `count` passengers made from `source`: its own
// passengers first, then copies of them, each with its own reference, first
// name, e-mail and phone number.
function resizedPassengers(source, count) {
  const given = arr(source).filter(isObj);
  if (given.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const p = structuredClone(given[i % given.length]);
    p.reference = String(i + 1).padStart(5, '0');
    if (i >= given.length) {
      const n = i + 1;
      for (const key of ['firstName', 'updateFirstName']) if (typeof p[key] === 'string') p[key] = `${p[key]} ${n}`;
      for (const key of ['email', 'updateEmail']) if (typeof p[key] === 'string') p[key] = p[key].replace('@', `+${n}@`);
      for (const key of ['phoneNumber', 'updatePhoneNumber']) {
        if (typeof p[key] === 'string' && /\d{3}$/.test(p[key])) p[key] = p[key].slice(0, -3) + String(n % 1000).padStart(3, '0');
      }
    }
    return p;
  });
}

/**
 * The reference scenarios of a catalogue data file, adapted: the data file to
 * copy from, and per code what is left to complete or check. #699: a limit
 * entry gets a passenger list of its own, of the framework's maximum (or one
 * more); without a declared maximum it is left as it is (and cannot be copied).
 */
function adaptCatalogueDatafile(datafile, entries, frameworkConfig) {
  const byCode = new Map(arr(entries).map((e) => [e.code, e]));
  const max = maxPassengersOf(frameworkOf(frameworkConfig));
  const notes = {};
  const lists = arr(datafile.passengersList).slice();
  let nextId = Math.max(0, ...lists.filter(isObj).map((l) => Number(l.id) || 0)) + 1;
  const scenarios = arr(datafile.scenarios).map((sc) => {
    if (!isObj(sc) || !byCode.has(sc.code)) return sc;
    const entry = byCode.get(sc.code);
    const { scenario, toComplete, toCheck } = adaptReferenceScenario(sc, entry.needs, frameworkConfig);
    if (entry.limit && max) {
      const count = entry.limit === 'OVER_MAX_PASSENGERS' ? max + 1 : max;
      const source = lists.find((l) => isObj(l) && l.id === sc.passengersListId);
      lists.push({ id: nextId, passengers: resizedPassengers(source?.passengers, count) });
      scenario.passengersListId = nextId;
      nextId += 1;
    }
    notes[sc.code] = { toComplete, toCheck };
    return scenario;
  });
  return { datafile: { ...datafile, scenarios, passengersList: lists }, notes };
}

// #699: the maximum number of passengers a framework declares, or null.
function maxPassengersOf(framework) {
  const n = framework?.maxPassengers;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

/**
 * The train or journey of the Test Data to propose for a trip of the copy, as
 * the copy page writes it ("train::<id>::<service>" or "journey::<id>"), or
 * null when the Test Data has nothing that fits. `trip` is one of planCopy's
 * trips (`legs`, `needsJourney`); `testData` the route's testDataChoices.
 */
function suggestTrip(trip, testData) {
  const legs = Number(trip?.legs) || 1;
  const journeys = arr(testData?.journeys);
  if (trip?.needsJourney || legs > 1) {
    const same = journeys.find((j) => j.legs === legs);
    return same ? `journey::${same.id}` : null;
  }
  const train = arr(testData?.trains)[0];
  if (!train) return journeys[0] ? `journey::${journeys[0].id}` : null;
  const service = arr(train.services)[0];
  return `train::${train.id}::${service ? service.index : 0}`;
}

module.exports = { adaptReferenceScenario, adaptCatalogueDatafile, resizedPassengers, suggestTrip, OVERRULE_CODES };
