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
 *
 * #681: each entry also says what it needs from the provider's data
 * (`needs`): the trip, the reservations its trains carry, the tariff, the
 * passengers, the values only the provider can give. dataNeedsOf() works
 * them out from the source scenario and the simulator's profile, and a test
 * keeps the file equal to it; the copy will use them to pick a provider's
 * train and tariff, and needsText() says them to the person copying.
 */

const {
  scenarioReturnModel, partialRefundScopeDeclared, offerRequestFormOf, OFFER_REQUEST_TEXT, OFFER_REQUEST_FORMS,
  placeSelectionFlowOf, placeSelectionFlowDeclared, PLACE_SELECTION_TEXT, scenarioOfferCriteria,
} = require('./frameworkGating');
const { fareRequirementsOf, fareMissing, freeUnderAgeOf, versionAtLeast, COMBINATION_MODELS } = require('./fareDeclarations');

const arr = (v) => (Array.isArray(v) ? v : []);
const { declaredCards } = require('./reductionCards');
const { declaredProducts, declaredGroupProducts } = require('./namedProducts');
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
// #699: an entry that tests the provider's passenger limit: its passengers
// become the Test Framework's maxPassengers (MAX_PASSENGERS) or one more
// (OVER_MAX_PASSENGERS) at copy time. #704: one that tests the sales
// horizon departs on its last day (SALES_HORIZON) or the day after
// (OVER_SALES_HORIZON), from the Test Framework's salesHorizonDays.
const PASSENGER_LIMITS = new Set(['MAX_PASSENGERS', 'OVER_MAX_PASSENGERS']);
const HORIZON_LIMITS = new Set(['SALES_HORIZON', 'OVER_SALES_HORIZON']);
// #705: one whose passengers stand on the edges of the age ranges the Test
// Framework declares for CHILD and ADULT (AGE_RANGES). #887: one whose card
// holder takes the first reduction card the Test Framework declares
// (REDUCTION_CARDS). #887 PR 2: one that sells the first product it declares
// (NAMED_PRODUCTS). PR 3: one that sells the first group product it
// declares (GROUP_TARIFF), and one asking it for one passenger more than the
// first group product's maximum (OVER_GROUP_SIZE).
const GROUP_LIMITS = new Set(['GROUP_TARIFF', 'OVER_GROUP_SIZE']);
// #937: one whose child is under the age the Test Framework declares free in
// fares (FREE_CHILD), and so travels on a fare priced 0.
const LIMITS = [...PASSENGER_LIMITS, ...HORIZON_LIMITS, 'AGE_RANGES', 'REDUCTION_CARDS', 'NAMED_PRODUCTS', ...GROUP_LIMITS, 'FREE_CHILD'];
// #780: an entry that stands for the offer search probes (`probe`
// "OFFER_OPTIONS"): it comes once per option value the Test Framework
// declares, each asking for that value alone. Per option: the framework key,
// the scenario's offerSearchCriteria field, the values worth a probe (a
// COLLECTIVE request needs a group, as the group entries have; ALL, FARE_*,
// ANY_CLASS ask for nothing to check), the code part and the OSDM member.
// #780 part 3: an entry (`probe` "OFFER_COMBINATIONS") that comes as random
// combinations of those values, drawn from the framework's count and seed.
// #781: entries that come once per declared currency (CURRENCIES), in the
// default one with none asked (DEFAULT_CURRENCY), and in one not declared
// (CURRENCY_NOT_SOLD).
// #780 PR C: an entry (`probe` "OFFER_OPTION_NOT_DECLARED") that asks for the
// first option value an explicit list of the framework leaves out.
const PROBES = ['OFFER_OPTIONS', 'OFFER_COMBINATIONS', 'CURRENCIES', 'DEFAULT_CURRENCY', 'CURRENCY_NOT_SOLD', 'OFFER_OPTION_NOT_DECLARED'];
const OFFER_OPTION_PROBES = [
  { key: 'offerModes', field: 'offerMode', values: ['INDIVIDUAL'], code: 'OFFER_MODE', member: 'offerMode' },
  { key: 'requestedOfferParts', field: 'requestedOfferParts', values: ['ADMISSION', 'RESERVATION', 'ANCILLARY'], code: 'OFFER_PARTS', member: 'requestedOfferParts' },
  { key: 'travelClasses', field: 'travelClass', values: ['FIRST', 'SECOND'], code: 'TRAVEL_CLASS', member: 'travelClasses' },
  { key: 'serviceClassTypes', field: 'serviceClass', values: ['BEST', 'HIGH', 'STANDARD', 'BASIC'], code: 'SERVICE_CLASS', member: 'serviceClassTypes' },
  { key: 'flexibilities', field: 'flexibilities', values: ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'], code: 'FLEXIBILITY', member: 'flexibilities' },
  // #780 PR A: the tags a one-way sale can hold (passes, multi-ride, cards and
  // lost-ticket products are not sold on a trip). Not combined: the
  // combinations drawn before it came stay the same for a seed.
  { key: 'productTags', field: 'productTags', values: ['ADMISSION_POINT2POINT', 'UPGRADE_POINT2POINT', 'RESERVATION', 'SPLIT_RESERVATION', 'ANCILLARY_SERVICE', 'ANCILLARY_ITEM'], code: 'PRODUCT_TAG', member: 'productTags', combine: false },
];
// The keys of `needs` (#681), in the order dataNeedsOf() writes them.
const NEEDS_KEYS = ['trip', 'legs', 'return', 'reservations', 'legClasses', 'tariff', 'passengers',
  'reductionCards', 'providerValues', 'requestedInformation', 'expiry'];

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
  if (String(e.source).startsWith('SIM_FAULT_')) problems.push(`${at}.source asks the simulator for faults (#833)`);
  if (e.limit !== undefined && !LIMITS.includes(e.limit)) problems.push(`${at}.limit "${e.limit}" is not one of ${LIMITS.join(', ')}`);
  if (e.probe !== undefined && !PROBES.includes(e.probe)) problems.push(`${at}.probe "${e.probe}" is not one of ${PROBES.join(', ')}`);
  problems.push(...combinationModelProblems(e, at), ...needsProblems(e.needs, at));
  return problems;
}

// #937: the fare combination model the source's fares come in, when it matters.
function combinationModelProblems(e, at) {
  if (e.combinationModel === undefined || COMBINATION_MODELS.includes(e.combinationModel)) return [];
  return [`${at}.combinationModel "${e.combinationModel}" is not one of ${COMBINATION_MODELS.join(', ')}`];
}

// The problems of an entry's `needs` (#681): there, and only known keys.
function needsProblems(needs, at) {
  if (!isObj(needs)) return [`${at}.needs is missing`];
  return Object.keys(needs).filter((key) => !NEEDS_KEYS.includes(key)).map((key) => `${at}.needs.${key} is not a known need`);
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

// #713: the partial refund scopes a scenario arms, as the Test Framework names them.
const PARTIAL_REFUND_FIELDS = [
  ['partialRefundByFulfillment', 'FULFILLMENT'], ['partialRefundByLeg', 'LEG'], ['partialRefundByPax', 'PASSENGER'],
];
function partialRefundScopesOf(scenario) {
  if (String(scenario.scenarioType || 'SALE').toUpperCase() !== 'REFUND') return [];
  return PARTIAL_REFUND_FIELDS.filter(([field]) => ARMED.has(scenario[field])).map(([, scope]) => scope);
}

/** The sales flows a scenario uses, as the Test Framework names them. */
function salesFlowsOf(scenario) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  const flows = ['SALE'];
  if (type === 'SALE') return flows;
  const partial = ['partialRefundByLeg', 'partialRefundByPax', 'partialRefundByFulfillment'].some((f) => ARMED.has(scenario[f]));
  flows.push(type === 'REFUND' && partial ? 'REFUND_PARTIAL' : `${type}_FULL`);
  // #700: the exchange of a refunded ticket is asked of a provider that exchanges.
  if (ARMED.has(scenario.exchangeRefundedProbe) && !flows.includes('EXCHANGE_FULL')) flows.push('EXCHANGE_FULL');
  return flows;
}

// The OSDM version a set of requirements asks for at least (#937: fares too),
// as [major, minor, text], or null.
function minimumVersionOf(requirements) {
  const versions = [requirements.minOsdmVersion, requirements.fares?.minOsdmVersion]
    .filter((v) => typeof v === 'string')
    .map((v) => [...v.split('.').map((n) => Number.parseInt(n, 10)), v]);
  versions.sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]));
  return versions[0] || null;
}

/** What a reference scenario needs the Test Framework to declare. */
function requirementsOf(scenario, datafile) {
  const list = arr(datafile.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId);
  const types = [...new Set(arr(list?.passengers).map((p) => p?.type).filter((t) => typeof t === 'string' && t !== 'PERSON'))];
  const model = scenarioReturnModel(scenario);
  return {
    salesFlows: salesFlowsOf(scenario),
    partialRefundScopes: partialRefundScopesOf(scenario),
    returnModel: model,
    minOsdmVersion: model === 'COMBINED' ? '3.7' : null,
    passengerTypes: types,
    offerRequest: offerRequestOf(scenario, datafile),
    placeSelectionFlow: placeSelectionFlowOf(scenario),
    // #809: a purchaser written after the booking (POST /bookings/{id}/purchaser).
    purchaserAfterBooking: require('./undeclaredSteps').purchaserAfterBooking(scenario),
    // #780 PR B: the trip search parameters its search sends.
    tripSearchParameters: require('./tripSearchParameters').tripSearchParametersOf(scenario, datafile),
    // #936: product-based, fare-based, or both.
    distributionModes: require('./distributionModes').distributionModesOf(scenario, datafile),
    // #937: what its fares need declared under `fares`.
    fares: fareRequirementsOf(scenario, scenarioOfferCriteria(scenario, datafile)?.requestedOfferParts),
  };
}

/**
 * #748: the form of a scenario's offer request, and whether a search can be
 * sent as a trip specification instead: a one-way trip of one leg, asked
 * without the train filter (which only a search has).
 */
function offerRequestOf(scenario, datafile) {
  const form = offerRequestFormOf(scenario, datafile);
  if (form !== 'SEARCH') return { form, convertible: false };
  const trip = arr(datafile.tripRequirements).find((t) => isObj(t) && t.id === scenario.tripRequirementId);
  const filtered = ARMED.has(trip?.trip?.searchCriteria?.trainFilter);
  return { form, convertible: Boolean(trip) && !filtered && scenarioReturnModel(scenario) === null };
}

/** The declarations a framework lacks for these requirements, as sentences. */
function missingFor(requirements, framework) {
  let fw = isObj(framework) ? framework : {};
  if (isObj(framework?.config)) fw = framework.config;
  const missing = [];
  const flows = arr(fw.salesFlows);
  for (const flow of requirements.salesFlows) if (!flows.includes(flow)) missing.push(`sales flow ${flow}`);
  for (const scope of arr(requirements.partialRefundScopes)) {
    if (!partialRefundScopeDeclared(fw, scope)) missing.push(`partial refund by ${scope.toLowerCase()}`);
  }
  if (requirements.returnModel && Array.isArray(fw.returnModels) && !fw.returnModels.includes(requirements.returnModel)) {
    missing.push(`return model ${requirements.returnModel}`);
  }
  missing.push(...versionMissing(requirements, fw));
  const declared = arr(fw.passengerTypes);
  for (const type of requirements.passengerTypes) if (!declared.includes(type)) missing.push(`passenger type ${type}`);
  return [
    ...distributionMissing(requirements, fw),
    ...missing, ...placeSelectionMissing(requirements.placeSelectionFlow, fw),
    ...offerRequestMissing(requirements.offerRequest, fw), ...limitsMissing(requirements, fw),
    ...stepsMissing(requirements, fw), ...tripParametersMissing(requirements, fw),
  ];
}

// The OSDM version the requirements need and the framework is below, as a sentence.
function versionMissing(requirements, fw) {
  const minimum = minimumVersionOf(requirements);
  return minimum && !versionAtLeast(fw.osdmVersion, minimum[0], minimum[1]) ? [`OSDM ${minimum[2]} or later`] : [];
}

// #936: a distribution mode the framework does not declare, as a sentence.
// Named first: a fare scenario offered to a product-only provider is out of
// scope, whatever else it lacks. #937: the fare declarations it lacks come
// next, once the provider sells fares.
function distributionMissing(requirements, fw) {
  const { distributionModeDeclared, DISTRIBUTION_MODE_TEXT } = require('./distributionModes');
  const modes = arr(requirements.distributionModes).filter((mode) => !distributionModeDeclared(fw, mode))
    .map((mode) => `${DISTRIBUTION_MODE_TEXT[mode]} distribution (Distribution)`);
  return modes.length ? modes : fareMissing(requirements.fares, fw);
}

// #780 PR B: the trip search parameters a framework does not take, as sentences.
function tripParametersMissing(requirements, fw) {
  const { tripSearchParameterDeclared, TRIP_SEARCH_PARAMETER_TEXT } = require('./tripSearchParameters');
  return arr(requirements.tripSearchParameters).filter((name) => !tripSearchParameterDeclared(fw, name))
    .map((name) => `trip search by ${TRIP_SEARCH_PARAMETER_TEXT[name]} (Trip search parameters)`);
}

// #809: a step the framework says the provider does not offer, as a sentence.
function stepsMissing(requirements, fw) {
  return requirements.purchaserAfterBooking && fw.purchaserAfterBooking === false
    ? ['a purchaser written after the booking (Passenger Types)'] : [];
}

// #766: a place chosen in a way the framework does not declare, as a sentence.
function placeSelectionMissing(flow, fw) {
  return placeSelectionFlowDeclared(fw, flow) ? [] : [`place selection ${PLACE_SELECTION_TEXT[flow]} (Seat Selection)`];
}

// #748: the offer request form a framework does not take, as a sentence:
// none when no list is declared, its form is listed, or it is a search that
// can go in another form the framework takes (#759: by trip id too).
function offerRequestMissing(request, fw) {
  const forms = fw.offerRequestForms;
  if (!request || !Array.isArray(forms) || forms.includes(request.form)) return [];
  if (request.convertible && (forms.includes('SPECIFICATION') || forms.includes('TRIP_IDS'))) return [];
  return [`offer requests ${OFFER_REQUEST_TEXT[request.form]}`];
}

// #699 / #704 / #705: the limits a limit entry needs declared, as sentences.
function limitsMissing(requirements, fw) {
  const missing = [];
  if (requirements.maxPassengers && !maxPassengersOf(fw)) missing.push('the maximum number of passengers (Passenger Types)');
  if (requirements.salesHorizon && !salesHorizonOf(fw)) missing.push('the sales horizon (Tariff Flexibility)');
  if (requirements.ageRanges && !ageRangesOf(fw)) missing.push('passenger types CHILD and ADULT with their age ranges (Passenger Types)');
  if (requirements.reductionCards && declaredCards(fw).length === 0) missing.push('a reduction card the provider accepts (Passenger Types › Reduction cards)');
  if (requirements.namedProducts && declaredProducts(fw).length === 0) missing.push('a product the provider sells (Tariff Flexibility › Products)');
  if (requirements.groupProducts && declaredGroupProducts(fw).length === 0) missing.push('a group product the provider sells (Tariff Flexibility › Group products)');
  if (requirements.groupProductMax && !declaredGroupProducts(fw).some((g) => g.maxPassengers)) missing.push('a group product with its maximum group size (Tariff Flexibility › Group products)');
  return missing;
}

// ─── #681: what a reference scenario needs from the provider's data ───────

/** What dataNeedsOf() reads from the simulator's profile of the source's provider. */
function simulatorFacts(profile) {
  return {
    reservations: isObj(profile?.reservations) ? profile.reservations : {},
    requestedInformationFrom: profile?.personChecks?.requestedInformationFrom || null,
  };
}

const EXPIRY_TESTS = [
  ['expiredOfferTest', 'OFFER'], ['expiredBookingTest', 'BOOKING'],
  ['expiredRefundOfferTest', 'REFUND_OFFER'], ['expiredExchangeOfferTest', 'EXCHANGE_OFFER'],
];
const NO_OVERRULE = new Set(['', 'null', 'CODE_DOES_NOT_EXIST']);

// The tariff a scenario needs: one that can be refunded or exchanged for an
// after-sale, the non-flexible one when the sale asks for it. An overrule
// code refunds whatever the tariff, so it needs none.
function tariffNeed(scenario, overrule) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  if (type === 'REFUND') return overrule ? null : 'REFUNDABLE';
  if (type === 'EXCHANGE') return 'EXCHANGEABLE';
  return scenario.desiredFlexibility === 'NON_FLEXIBLE' ? 'NON_FLEXIBLE' : null;
}

// The reservation a scenario exercises: an optional one when it says how to
// book it (reservationBookingForm), else a mandatory one when its trip has
// it. A reservation the trip merely carries is not a need.
function reservationNeed(scenario, kinds) {
  if (scenario.reservationBookingForm) return kinds.has('OPTIONAL') ? ['OPTIONAL'] : [];
  return kinds.has('MANDATORY') ? ['MANDATORY'] : [];
}

/**
 * What a scenario needs from the provider's data, worked out from the
 * scenario, the data file it lives in and the facts of the simulator that
 * answers it (simulatorFacts). Only the needs that apply are written.
 */
function dataNeedsOf(scenario, datafile, facts) {
  const trip = arr(datafile.tripRequirements).find((t) => isObj(t) && t.id === scenario.tripRequirementId) || {};
  const legs = arr(trip.legs).filter(isObj);
  const stops = [trip.trip?.origin, trip.trip?.destination, ...legs.flatMap((l) => [l.origin, l.destination])];
  const passengers = arr(arr(datafile.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId)?.passengers);
  const kinds = new Set(legs.map((l) => facts.reservations[l.productCategoryShortName]).filter(Boolean));
  const overrule = typeof scenario.overruleCode === 'string' && !NO_OVERRULE.has(scenario.overruleCode) ? scenario.overruleCode : null;
  const providerValues = [
    ...(overrule ? ['overruleCode'] : []),
    ...(scenario.expectedProduct ? ['expectedProduct'] : []),
    // #766: seat preferences are codes of the provider's own list.
    ...(placeSelectionFlowOf({ placePreferences: scenario.placePreferences }) ? ['placePreferences'] : []),
    // #766 PR 4: a reference place is a coach and place of the provider's train.
    // #776: "AUTO" takes it from a first booking, so the provider gives it.
    ...(typeof scenario.referencePlace === 'string' && !['', 'AUTO'].includes(scenario.referencePlace.trim().toUpperCase()) ? ['referencePlace'] : []),
  ];
  const needs = {
    trip: trip.tripType === 'SPECIFICATION' ? 'SPECIFICATION' : 'SEARCH',
    legs: legs.length > 1 ? legs.length : null,
    return: scenarioReturnModel(scenario),
    reservations: reservationNeed(scenario, kinds),
    legClasses: arr(scenario.legTravelClasses).length ? [...scenario.legTravelClasses] : null,
    tariff: tariffNeed(scenario, overrule),
    passengers: passengers.length,
    reductionCards: passengers.some((p) => arr(p?.reductionCards).length > 0),
    providerValues,
    requestedInformation: Boolean(scenario.requestedInformationProbe)
      || (facts.requestedInformationFrom !== null && stops.includes(facts.requestedInformationFrom)),
    expiry: EXPIRY_TESTS.filter(([flag]) => ARMED.has(scenario[flag])).map(([, name]) => name),
  };
  const out = {};
  for (const key of NEEDS_KEYS) {
    const v = needs[key];
    if (v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = v;
  }
  return out;
}

const TARIFF_TEXT = { REFUNDABLE: 'a refundable tariff', EXCHANGEABLE: 'an exchangeable tariff', NON_FLEXIBLE: 'a non-flexible tariff' };
const RETURN_TEXT = { COMBINED: 'one offer for both directions', SEPARATE: 'one offer per direction' };

// The phrase of each need, in the order of NEEDS_KEYS; null when it says nothing.
const NEED_PHRASES = {
  legs: (v) => `a journey of ${v} legs`,
  return: (v) => `a return (${RETURN_TEXT[v] || v})`,
  reservations: (v) => v.map((kind) => `a train with ${kind === 'MANDATORY' ? 'a mandatory' : 'an optional'} seat reservation`),
  legClasses: (v) => `travel classes per leg: ${v.join(', ')}`,
  tariff: (v) => TARIFF_TEXT[v] || `tariff ${v}`,
  passengers: (v) => `${v} passenger${v > 1 ? 's' : ''}`,
  reductionCards: () => 'a reduction card the provider accepts',
  providerValues: (v) => v.map((field) => `the provider's own ${field}`),
  requestedInformation: () => 'a trip where the provider asks for passenger details',
  expiry: (v) => (v.length ? `waits for the provider's deadline: ${v.join(', ').toLowerCase().replaceAll('_', ' ')}` : null),
};

/** The needs of an entry, as short phrases for the person copying it. */
function needsText(needs) {
  const n = isObj(needs) ? needs : {};
  return NEEDS_KEYS.filter((key) => NEED_PHRASES[key] && n[key]).flatMap((key) => NEED_PHRASES[key](n[key])).filter(Boolean);
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

/** #699: the maximum number of passengers a framework declares, or null. */
function maxPassengersOf(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const n = fw?.maxPassengers;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

/**
 * #705: the CHILD and ADULT age ranges a framework declares, { child, adult,
 * ranges, types }, or null when either type is not declared or its range is
 * not whole years with min <= max.
 */
function ageRangesOf(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const types = arr(fw?.passengerTypes);
  const ranges = isObj(fw?.passengerAgeRanges) ? fw.passengerAgeRanges : {};
  const valid = (r) => isObj(r) && Number.isInteger(r.min) && Number.isInteger(r.max) && r.min >= 0 && r.min <= r.max && r.max <= 120;
  if (!types.includes('CHILD') || !types.includes('ADULT') || !valid(ranges.CHILD) || !valid(ranges.ADULT)) return null;
  return { child: ranges.CHILD, adult: ranges.ADULT, ranges, types };
}

/** #704: the sales horizon a framework declares, in days, or null. */
function salesHorizonOf(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const n = fw?.salesHorizonDays;
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}

// #699: the needs of a limit entry say the framework's number, not the simulator's.
function limitNeedsText(needs, limit) {
  if (limit === 'AGE_RANGES') {
    return ['a child on the last day of the CHILD age range, a passenger the day it leaves it, and an adult on the first day of the ADULT range, as the Test Framework declares them', ...needsText({ ...needs, passengers: undefined })];
  }
  if (limit === 'REDUCTION_CARDS') {
    return ['the first reduction card the Test Framework declares, on the passenger holding a card', ...needsText({ ...needs, reductionCards: undefined })];
  }
  if (GROUP_LIMITS.has(limit)) {
    const values = arr(needs?.providerValues).filter((v) => v !== 'expectedProduct');
    const first = limit === 'OVER_GROUP_SIZE'
      ? 'one passenger more than the maximum of the first group product the Test Framework declares with one, by its code'
      : 'the first group product the Test Framework declares, by its code, for a group of its sizes';
    return [first, ...needsText({ ...needs, providerValues: values, tariff: undefined, passengers: undefined })];
  }
  if (limit === 'FREE_CHILD') {
    return ['a child one year under the age the Test Framework declares free in fares', ...needsText({ ...needs, passengers: undefined })];
  }
  if (limit === 'NAMED_PRODUCTS') {
    const values = arr(needs?.providerValues).filter((v) => v !== 'expectedProduct');
    return ['the first product the Test Framework declares, by its code, in its flexibility', ...needsText({ ...needs, providerValues: values, tariff: undefined })];
  }
  if (HORIZON_LIMITS.has(limit)) {
    const day = limit === 'OVER_SALES_HORIZON' ? 'the day after the last day' : 'the last day';
    return [`a departure on ${day} of the sales horizon the Test Framework declares`, ...needsText(needs)];
  }
  const text = needsText({ ...needs, passengers: undefined });
  const count = limit === 'OVER_MAX_PASSENGERS' ? 'one passenger more than the maximum' : 'the maximum number of passengers';
  return [`${count} the Test Framework declares`, ...text];
}

/**
 * The catalogue as a company sees it: each entry, what it needs, what is
 * missing. #748/#759: a one-way search without the train filter can also be
 * asked as a trip specification or by trip id. It comes once per form the
 * framework takes, in the order SEARCH, SPECIFICATION, TRIP_IDS: the first
 * under its own code (`tripAs` when that form is not the search), the others
 * as twins under `<code>_SPEC` / `<code>_TRIPID` (`variantOf`).
 */
function catalogueFor(catalogue, simulator, framework) {
  const fw = isObj(framework?.config) ? framework.config : (framework || {});
  const forms = Array.isArray(fw.offerRequestForms) ? fw.offerRequestForms : null;
  return baseEntries(catalogue, simulator, framework).flatMap((entry) => {
    if (entry.probe === 'OFFER_OPTIONS') return offerOptionProbes(entry, fw);
    if (entry.probe === 'OFFER_COMBINATIONS') return offerCombinationProbes(entry, fw);
    if (CURRENCY_PROBES.has(entry.probe)) return currencyProbes(entry, fw);
    if (entry.probe === 'OFFER_OPTION_NOT_DECLARED') return [optionNotDeclaredProbe(entry, fw)];
    if (!forms || !entry.requirements.offerRequest.convertible) return [entry];
    const variants = OFFER_REQUEST_FORMS.filter((form) => forms.includes(form))
      .map((form) => (form === 'SEARCH' ? entry : asForm(entry, form, framework)));
    if (!variants.length) return [entry];
    return variants.map((variant, i) => (i === 0 ? variant : {
      ...variant, code: `${entry.code}${VARIANTS[variant.tripAs].suffix}`, variantOf: entry.code,
      purpose: `${entry.purpose} ${VARIANTS[variant.tripAs].purpose}`,
    }));
  });
}

/**
 * #780: the values of each offer search option a framework declares that are
 * worth a probe: its offerSearchOptions lists (a key absent declares nothing
 * to probe, though every value is accepted) and its tariff flexibilities.
 */
function declaredOptionValues(fw) {
  const options = isObj(fw.offerSearchOptions) ? fw.offerSearchOptions : {};
  return OFFER_OPTION_PROBES.flatMap((probe) => {
    const declared = probe.key === 'flexibilities' ? fw.offerCriteria?.flexibilities : options[probe.key];
    return probe.values.filter((v) => arr(declared).includes(v)).map((value) => ({ ...probe, value }));
  });
}

/**
 * #780 PR C: the first option value worth a probe that an explicit list of
 * the framework leaves out (a key absent declares every value, so it leaves
 * nothing out). The offer mode is not asked: COLLECTIVE needs a group.
 */
function undeclaredOptionValue(fw) {
  const options = isObj(fw.offerSearchOptions) ? fw.offerSearchOptions : {};
  for (const probe of OFFER_OPTION_PROBES) {
    if (probe.key === 'offerModes') continue;
    const declared = probe.key === 'flexibilities' ? fw.offerCriteria?.flexibilities : options[probe.key];
    if (!Array.isArray(declared)) continue;
    const value = probe.values.find((v) => !declared.includes(v));
    if (value) return { ...probe, value };
  }
  return null;
}

// #780 PR C: the probe entry asking for that value (`optionOf`, `notDeclared`),
// or itself, not copiable, when the framework leaves nothing out.
function optionNotDeclaredProbe(entry, fw) {
  const o = undeclaredOptionValue(fw);
  if (!o) return { ...entry, missing: [...entry.missing, 'an offer search option whose list leaves a value out (Offer search options, Tariff Flexibility)'] };
  return {
    ...entry,
    optionOf: { key: o.key, field: o.field, value: o.value },
    notDeclared: true,
    purpose: `${entry.purpose} Value asked: offerSearchCriteria.${o.member} ${o.value}.`,
  };
}

// #780: the probe entry as one twin per declared value (`optionOf`), or as
// itself, not copiable, when the framework declares none.
function offerOptionProbes(entry, fw) {
  const values = declaredOptionValues(fw);
  if (!values.length) return [{ ...entry, missing: [...entry.missing, 'an offer search option value to probe (Offer search options, Tariff Flexibility)'] }];
  return values.map((o) => ({
    ...entry,
    code: `OTST_OFFER_${o.code}_${o.value}`,
    variantOf: entry.code,
    optionOf: { key: o.key, field: o.field, value: o.value },
    purpose: `Offer search probe: offers asked with offerSearchCriteria.${o.member} ${o.value} alone; no offer keeping to it, or the provider ignoring it, fails. The scenario ends after the offer.`,
  }));
}

/**
 * #780 part 3: the combination entry as `count` twins (`optionsOf`), each
 * asking for two or more declared option values together, drawn from the
 * framework's seed. Not copiable, listed once, without a count and seed, or
 * with fewer than two options having a declared value.
 */
function offerCombinationProbes(entry, fw) {
  const { combinationSettings, drawCombinations } = require('./offerCombinations');
  const settings = combinationSettings(fw);
  if (!settings) return [{ ...entry, missing: [...entry.missing, 'the number of random combinations and their seed (Offer search options)'] }];
  const values = declaredOptionValues(fw);
  const options = OFFER_OPTION_PROBES.filter((p) => p.combine !== false).map((p) => ({
    key: p.key, values: values.filter((v) => v.key === p.key).map((v) => v.value),
    ...(p.key === 'travelClasses' || p.key === 'serviceClassTypes' ? { group: 'class' } : {}),
  }));
  const combinations = drawCombinations(options, settings.count, settings.seed);
  if (!combinations.length) return [{ ...entry, missing: [...entry.missing, 'two offer search options with a value to combine (Offer search options, Tariff Flexibility)'] }];
  return combinations.map((combination, i) => {
    const optionsOf = combination.map(({ key, value }) => {
      const probe = OFFER_OPTION_PROBES.find((p) => p.key === key);
      return { key, field: probe.field, value, member: probe.member };
    });
    const text = optionsOf.map((o) => `${o.member} ${o.value}`).join(', ');
    return {
      ...entry,
      code: `OTST_OFFER_COMBO_${i + 1}`,
      variantOf: entry.code,
      optionsOf: optionsOf.map(({ key, field, value }) => ({ key, field, value })),
      purpose: `Offer search combination ${i + 1} of seed ${settings.seed}: offers asked with ${text} together; an option no offer keeps to, or that the provider ignores, fails. The scenario ends after the offer.`,
    };
  });
}

const CURRENCY_PROBES = new Set(['CURRENCIES', 'DEFAULT_CURRENCY', 'CURRENCY_NOT_SOLD']);
const NO_CURRENCY = 'the currencies sold (Currencies)';

/**
 * #781: a currency entry against the framework's currencies. CURRENCIES: one
 * twin per currency sold (`currencyOf`), coded `<code>_<currency>`.
 * DEFAULT_CURRENCY: the entry asking none and expecting the default
 * (`expectedCurrencyOf`). CURRENCY_NOT_SOLD: the entry asking for a common
 * currency not declared (`currencyOf`, `notSold`). Not copiable when the
 * framework declares nothing to use.
 */
function currencyProbes(entry, fw) {
  const { currenciesOf, currencyNotSold } = require('./currencies');
  const { sold, default: def } = currenciesOf(fw);
  const missing = (what) => [{ ...entry, missing: [...entry.missing, what] }];
  if (entry.probe === 'DEFAULT_CURRENCY') {
    if (!def) return missing('the default currency (Currencies)');
    return [{ ...entry, expectedCurrencyOf: def, purpose: `${entry.purpose} Default currency: ${def}.` }];
  }
  if (entry.probe === 'CURRENCY_NOT_SOLD') {
    const other = currencyNotSold(fw);
    if (!other) return missing(NO_CURRENCY);
    return [{ ...entry, currencyOf: other, notSold: true, purpose: `${entry.purpose} Currency asked: ${other}.` }];
  }
  if (!sold.length) return missing(NO_CURRENCY);
  return sold.map((currency) => ({
    ...entry, code: `${entry.code}_${currency}`, variantOf: entry.code, currencyOf: currency,
    purpose: `${entry.purpose} Currency: ${currency}.`,
  }));
}

// #748/#759: the forms a search can be sent in instead, with the code suffix
// and the purpose sentence of a twin.
const VARIANTS = {
  SPECIFICATION: { suffix: '_SPEC', purpose: 'Offers asked by trip specification.' },
  TRIP_IDS: { suffix: '_TRIPID', purpose: 'Offers asked by trip id, from POST /trips-collection.' },
};

// An entry whose search is sent in another form. A specification has a trip
// of its own; by trip id the search trip stays (it finds the trip id).
function asForm(entry, form, framework) {
  const requirements = { ...entry.requirements, offerRequest: { form, convertible: false } };
  return {
    ...entry, tripAs: form, requirements, missing: missingFor(requirements, framework),
    needs: form === 'SPECIFICATION' ? { ...entry.needs, trip: 'SPECIFICATION' } : entry.needs,
  };
}

// The entries of the catalogue file, against this framework.
function baseEntries(catalogue, simulator, framework) {
  const datafile = catalogueDatafile(catalogue, simulator);
  return catalogue.entries.map((entry) => {
    const scenario = datafile.scenarios.find((s) => s.code === entry.code);
    const requirements = requirementsOf(scenario, datafile);
    if (PASSENGER_LIMITS.has(entry.limit)) requirements.maxPassengers = true;
    if (HORIZON_LIMITS.has(entry.limit)) requirements.salesHorizon = true;
    if (entry.limit === 'AGE_RANGES') requirements.ageRanges = true;
    if (entry.limit === 'REDUCTION_CARDS') requirements.reductionCards = true;
    if (entry.limit === 'NAMED_PRODUCTS') requirements.namedProducts = true;
    if (GROUP_LIMITS.has(entry.limit)) requirements.groupProducts = true;
    if (entry.limit === 'OVER_GROUP_SIZE') requirements.groupProductMax = true;
    // #937: the entry's model and free age; a fare scenario keeps its form,
    // whose sections are its trip's stations.
    requirements.fares = fareRequirementsOf(scenario, scenarioOfferCriteria(scenario, datafile)?.requestedOfferParts, entry);
    if (requirements.distributionModes.includes('FARE')) requirements.offerRequest = { ...requirements.offerRequest, convertible: false };
    // #780: the offer search probes keep their search: they test the options, not the form.
    if (entry.probe) requirements.offerRequest = { ...requirements.offerRequest, convertible: false };
    return {
      code: entry.code,
      kind: kindOf(entry.code),
      area: String(scenario.scenarioType || 'SALE').toLowerCase(),
      purpose: entry.purpose,
      checks: entry.checks,
      requirements,
      missing: missingFor(requirements, framework),
      needs: entry.needs,
      needsText: entry.limit ? limitNeedsText(entry.needs, entry.limit) : needsText(entry.needs),
      ...(entry.limit ? { limit: entry.limit } : {}),
      ...(entry.probe ? { probe: entry.probe } : {}),
      ...(entry.combinationModel ? { combinationModel: entry.combinationModel } : {}),
    };
  });
}

module.exports = {
  catalogueProblems, catalogueDatafile, catalogueFor, requirementsOf, missingFor, salesFlowsOf,
  dataNeedsOf, needsText, simulatorFacts, maxPassengersOf, salesHorizonOf, ageRangesOf, freeUnderAgeOf, NEEDS_KEYS, LIMITS,
  OFFER_OPTION_PROBES, declaredOptionValues, undeclaredOptionValue,
};
