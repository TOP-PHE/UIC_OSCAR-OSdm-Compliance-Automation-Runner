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

const { ageRangesOf } = require('./scenarioCatalogue');

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
  // #766 PR 4: the simulator's coach and place mean nothing on another train.
  if (arr(n.providerValues).includes('referencePlace')) {
    toComplete.push(`a coach and place of the provider's train to sit near (referencePlace, now the simulator's ${out.referencePlace})`);
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
    if (i >= given.length) makeDistinct(p, i + 1);
    return p;
  });
}

// A copied passenger made the n-th: its own first name, e-mail and phone number.
function makeDistinct(p, n) {
  const text = (key) => typeof p[key] === 'string';
  for (const key of ['firstName', 'updateFirstName'].filter(text)) p[key] = `${p[key]} ${n}`;
  for (const key of ['email', 'updateEmail'].filter(text)) p[key] = p[key].replace('@', `+${n}@`);
  for (const key of ['phoneNumber', 'updatePhoneNumber'].filter((k) => text(k) && /\d{3}$/.test(p[k]))) {
    p[key] = p[key].slice(0, -3) + String(n % 1000).padStart(3, '0');
  }
}

/**
 * The reference scenarios of a catalogue data file, adapted: the data file to
 * copy from, and per code what is left to complete or check. #699: a limit
 * entry gets a passenger list of its own, of the framework's maximum (or one
 * more); without a declared maximum it is left as it is (and cannot be copied).
 * #704: a sales-horizon entry departs on the horizon's last day, or the day after.
 * #705: the age entry gets a passenger list of its own, on the edges of the
 * framework's age ranges. #709: with `passengerUpdate: false` in the framework,
 * no scenario updates its passengers. #748: an entry sent as a trip
 * specification (`tripAs`) gets a trip of its own, of one leg; #759: one
 * sent by trip id keeps its search trip and asks by `offersByTripIds`.
 */
function adaptCatalogueDatafile(catalogueFile, entries, frameworkConfig) {
  const datafile = withOfferOptions(withOfferRequestForms(catalogueFile, entries), entries);
  const byCode = new Map(arr(entries).map((e) => [e.code, e]));
  const fw = frameworkOf(frameworkConfig);
  const notes = {};
  const lists = arr(datafile.passengersList).slice();
  const ids = { next: Math.max(0, ...lists.filter(isObj).map((l) => Number(l.id) || 0)) + 1 };
  const scenarios = arr(datafile.scenarios).map((sc) => {
    if (!isObj(sc) || !byCode.has(sc.code)) return sc;
    const entry = byCode.get(sc.code);
    const { scenario, toComplete, toCheck } = adaptReferenceScenario(sc, entry.needs, frameworkConfig);
    const source = lists.find((l) => isObj(l) && l.id === sc.passengersListId);
    const ownList = (passengers) => {
      lists.push({ id: ids.next, passengers });
      scenario.passengersListId = ids.next;
      ids.next += 1;
    };
    applyLimit(entry.limit, scenario, source, fw, { ownList, toCheck });
    // #748: OSDM's DatedJourney requires the train number and the carrier.
    if (entry.tripAs === 'SPECIFICATION') {
      toCheck.push('the chosen train must have its number and operator code in Test Data: a trip specification names both');
    }
    // #759: the trip id comes from the provider's own trip search.
    if (entry.tripAs === 'TRIP_IDS') {
      toCheck.push('the provider\'s POST /trips-collection must list a trip for the chosen train\'s stations and time');
    }
    // #709: a provider without the passenger update gets none.
    if (fw.passengerUpdate === false && isObj(scenario.salesFlowActions)) {
      scenario.salesFlowActions = { ...scenario.salesFlowActions, patchPassengers: false };
    }
    notes[sc.code] = { toComplete, toCheck };
    return scenario;
  });
  return { datafile: { ...datafile, scenarios, passengersList: lists }, notes };
}

// The fields of a trip that make a leg (as the editor's TRIP_LEG_FIELDS, #749).
const TRIP_LEG_FIELDS = ['origin', 'destination', 'startDatetime', 'endDatetime', 'vehicleNumber', 'operatorCode',
  'productCategoryRef', 'productCategoryName', 'productCategoryShortName'];

// #748: a search trip as a trip specification of one leg, under a new id.
// The copy then fills the leg from the train chosen (scenarioCopy mapToTrain).
function specificationTrip(entry, id) {
  const trip = isObj(entry.trip) ? entry.trip : {};
  const leg = Object.fromEntries(TRIP_LEG_FIELDS.filter((k) => trip[k] !== undefined && trip[k] !== '').map((k) => [k, trip[k]]));
  return { ...structuredClone(entry), id, tripType: 'SPECIFICATION', legs: [leg] };
}

/**
 * #748/#759: the catalogue data file with the entries sent in another form
 * than a search: a trip specification on a trip of its own (one per search
 * trip, however many entries use it), a trip id with `offersByTripIds` on.
 * An entry under the source's own code replaces it; a twin (`variantOf`) is
 * added after it, in the entries' order. The data file given is not changed.
 */
function withOfferRequestForms(datafile, entries) {
  const variants = arr(entries).filter((e) => e.tripAs);
  if (!variants.length) return datafile;
  const trips = arr(datafile.tripRequirements).slice();
  let next = Math.max(0, ...trips.filter(isObj).map((t) => Number(t.id) || 0)) + 1;
  const specTrip = new Map();
  const onSpecTrip = (scenario) => {
    const id = scenario.tripRequirementId;
    if (!specTrip.has(id)) {
      const entry = trips.find((t) => isObj(t) && t.id === id);
      if (!entry) return scenario;
      trips.push(specificationTrip(entry, next));
      specTrip.set(id, next);
      next += 1;
    }
    return { ...scenario, tripRequirementId: specTrip.get(id) };
  };
  const inForm = (sc, entry) => (entry.tripAs === 'SPECIFICATION'
    ? onSpecTrip(structuredClone(sc))
    : { ...structuredClone(sc), offersByTripIds: 'on' });
  const byOriginal = new Map();
  for (const e of variants) {
    const key = e.variantOf || e.code;
    byOriginal.set(key, [...(byOriginal.get(key) || []), e]);
  }
  const scenarios = arr(datafile.scenarios).flatMap((sc) => {
    const list = isObj(sc) ? byOriginal.get(sc.code) : null;
    if (!list) return [sc];
    const inPlace = list.find((e) => !e.variantOf);
    const twins = list.filter((e) => e.variantOf).map((e) => ({ ...inForm(sc, e), code: e.code, description: e.purpose }));
    return [inPlace ? inForm(sc, inPlace) : sc, ...twins];
  });
  return { ...datafile, scenarios, tripRequirements: trips };
}

/**
 * #780: the catalogue data file with the offer search probes: each twin
 * (`optionOf`) is its source asking for that one option value, with
 * `offerSearchProbe` on; a flexibility probe also chooses that flexibility.
 * The probe entry itself gives way to its twins. The data file given is not
 * changed.
 */
function withOfferOptions(datafile, entries) {
  const probes = arr(entries).filter((e) => e.optionOf);
  if (!probes.length) return datafile;
  const scenarios = arr(datafile.scenarios).flatMap((sc) => {
    const twins = isObj(sc) ? probes.filter((e) => e.variantOf === sc.code) : [];
    if (!twins.length) return [sc];
    return twins.map((e) => {
      const { field, value } = e.optionOf;
      const criteria = { serviceClass: [], travelClass: [], flexibilities: [], offerMode: null, requestedOfferParts: [] };
      criteria[field] = field === 'offerMode' ? value : [value];
      const twin = { ...structuredClone(sc), code: e.code, description: e.purpose, offerSearchCriteria: criteria, offerSearchProbe: 'on' };
      if (field === 'flexibilities') twin.desiredFlexibility = value;
      return twin;
    });
  });
  return { ...datafile, scenarios };
}

// What a limit entry takes from the framework: #699 its passenger count, #704
// its departure day, #705 its passengers' ages. Nothing when the framework
// does not declare it (the entry then cannot be copied).
function applyLimit(limit, scenario, source, fw, { ownList, toCheck }) {
  if (limit === 'SALES_HORIZON' || limit === 'OVER_SALES_HORIZON') {
    const horizon = salesHorizonOf(fw);
    if (horizon) scenario.departureDaysFromToday = limit === 'OVER_SALES_HORIZON' ? horizon + 1 : horizon;
  } else if (limit === 'AGE_RANGES') {
    const declared = ageRangesOf(fw);
    if (declared) ownList(agedPassengers(source?.passengers, declared, toCheck));
  } else if (limit) {
    const max = maxPassengersOf(fw);
    if (max) ownList(resizedPassengers(source?.passengers, limit === 'OVER_MAX_PASSENGERS' ? max + 1 : max));
  }
}

// #705: the type, other than CHILD, a passenger of this age is priced as: the
// first of these the framework declares with a range holding the age.
const NEXT_TYPES = ['YOUTH', 'ADULT', 'SENIOR'];
function typeAtAge(age, { ranges, types }) {
  return NEXT_TYPES.find((t) => types.includes(t) && isObj(ranges[t]) && ranges[t].min <= age && age <= ranges[t].max) || null;
}

/**
 * #705: the three passengers of the age entry, on the framework's edges: a
 * child on the last day of the CHILD range, a passenger the day it leaves it
 * (priced as the declared type that holds that age, unchecked when none
 * does), an adult on the first day of the ADULT range. Copies; the source
 * list is not changed.
 */
function agedPassengers(source, declared, toCheck) {
  const leaving = declared.child.max + 1;
  const next = typeAtAge(leaving, declared);
  if (!next) toCheck.push(`the type a passenger of ${leaving} is priced as: no declared passenger type's age range holds ${leaving}`);
  const edges = [
    { bornYearsBeforeTravel: leaving, bornDaysAfter: 1, expectedPassengerType: 'CHILD' },
    { bornYearsBeforeTravel: leaving, bornDaysAfter: undefined, expectedPassengerType: next || undefined },
    { bornYearsBeforeTravel: declared.adult.min, bornDaysAfter: undefined, expectedPassengerType: 'ADULT' },
  ];
  return arr(source).slice(0, edges.length).map((p, i) => {
    const out = { ...structuredClone(p), ...edges[i] };
    for (const key of ['bornDaysAfter', 'expectedPassengerType']) if (out[key] === undefined) delete out[key];
    return out;
  });
}

// #699: the maximum number of passengers a framework declares, or null.
function maxPassengersOf(framework) {
  const n = framework?.maxPassengers;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

// #704: the sales horizon a framework declares, in days, or null.
function salesHorizonOf(framework) {
  const n = framework?.salesHorizonDays;
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
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

module.exports = {
  adaptReferenceScenario, adaptCatalogueDatafile, resizedPassengers, suggestTrip, withOfferRequestForms, withOfferOptions, OVERRULE_CODES,
};
