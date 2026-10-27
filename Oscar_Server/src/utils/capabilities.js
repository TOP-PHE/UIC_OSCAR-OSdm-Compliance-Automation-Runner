// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * capabilities.js — what a provider's OSDM interface can do, as the coverage
 * report counts it (#972). Pure.
 *
 * A capability is a line of an assessment: "Offers by trip search", "Full
 * refund", "Seat near a given place". Each scenario has one *main* capability,
 * what it is for: a catalogue entry names it (`capability`), any other
 * scenario gets it from its fields (`derivedCapability()`). A run also proves
 * the capabilities of the steps it went through on the way (decision 1 of
 * #972): `STEP_ROLES` says what each request of the collection does, and
 * `stepCapabilities()` resolves that for one scenario (the form of its offer
 * request, the kind of its refund…). The scenario's other traits (a return,
 * a reduction card, a seat preference…) are proven once the stage that
 * checks them went through (`featuresOf()`).
 *
 * How a run's results become a capability's result is capabilityCoverage.js.
 */

const {
  offerRequestFormOf, placeSelectionFlowOf, scenarioReturnModel, scenarioOfferCriteria,
} = require('./frameworkGating');
const { tripSearchParametersOf } = require('./tripSearchParameters');
const { distributionModesOf } = require('./distributionModes');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ARMED = new Set(['on', 'true', 'yes', '1', true, 1]);
const armed = (v) => ARMED.has(typeof v === 'string' ? v.toLowerCase() : v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const filled = (v) => v !== undefined && v !== null && v !== '';

const GROUPS = Object.freeze([
  'Reference data', 'Offers', 'Sale', 'Passengers', 'Seat reservations', 'Return journeys', 'Fulfilment',
  'Refund', 'Exchange', 'Fares', 'Time limits',
]);

// The stage that proves a trait: 'offer' = the offer request went through,
// 'sale' = the sale was confirmed. A capability with `goal` is proven by
// steps instead (STEP_ROLES): it is reached when one of its goal steps ran.
// `optional` (R7): the provider may leave it out; its failure is its own and
// never charged to the flow.
const SALE_GOAL = '06. POST Obtaining Fulfillments from Booking';
const OFFER_GOAL = '01. POST Get Offer';
const CAPABILITIES = Object.freeze([
  { id: 'masterData', group: 'Reference data', label: 'Reference data (system information reads)', optional: true, goal: 'masterData' },
  { id: 'offers.search', group: 'Offers', label: 'Offers by trip search', goal: [OFFER_GOAL] },
  { id: 'offers.specification', group: 'Offers', label: 'Offers by trip specification', goal: [OFFER_GOAL] },
  { id: 'offers.tripIds', group: 'Offers', label: 'Offers by trip id', goal: [OFFER_GOAL] },
  { id: 'offers.tripParameters', group: 'Offers', label: 'Trip search parameters (train filter, transfers, vias…)', stage: 'offer' },
  { id: 'offers.options', group: 'Offers', label: 'Offer search options (classes, flexibility, offer parts…)', stage: 'offer' },
  { id: 'offers.requestOptions', group: 'Offers', label: 'Optional parameters of the offer request', stage: 'offer' },
  { id: 'sale', group: 'Sale', label: 'Sale: pre-booking and confirmation', goal: [SALE_GOAL] },
  { id: 'sale.products', group: 'Sale', label: 'Named products and tariff choice', stage: 'sale' },
  { id: 'sale.groupTariff', group: 'Sale', label: 'Group tariff', stage: 'sale' },
  { id: 'sale.reductionCards', group: 'Sale', label: 'Reduction cards', stage: 'sale' },
  { id: 'sale.classPerLeg', group: 'Sale', label: 'Travel class per leg', stage: 'sale' },
  { id: 'sale.currencies', group: 'Sale', label: 'Currencies', stage: 'offer' },
  { id: 'sale.limits', group: 'Sale', label: 'Limits: passengers, sales horizon, departure date', stage: 'sale' },
  { id: 'sale.idempotency', group: 'Sale', label: 'Idempotency-Key', optional: true, stage: 'sale' },
  { id: 'passengers.ages', group: 'Passengers', label: 'Passenger type from the age', stage: 'offer' },
  { id: 'passengers.names', group: 'Passengers', label: 'Accented and long names', stage: 'sale' },
  { id: 'passengers.update', group: 'Passengers', label: 'Passenger details updated after the booking', goal: ['03. PATCH Multi Passenger'] },
  { id: 'passengers.requestedInformation', group: 'Passengers', label: 'Requested information', stage: 'sale' },
  { id: 'purchaser', group: 'Passengers', label: 'Purchaser given after the booking', goal: ['13. PATCH Booking Purchaser', '14. POST Booking Purchaser'] },
  { id: 'reservation.mandatory', group: 'Seat reservations', label: 'Mandatory reservation', stage: 'sale' },
  { id: 'reservation.optional', group: 'Seat reservations', label: 'Optional reservation with the booking (optionalReservationSelections)', stage: 'sale' },
  { id: 'reservation.placeSelection', group: 'Seat reservations', label: 'Optional reservation with the booking (placeSelections)', stage: 'sale' },
  { id: 'reservation.addLater', group: 'Seat reservations', label: 'Reservation added after the booking', goal: ['09. POST Add Reservation to Booking'] },
  { id: 'reservation.preferences', group: 'Seat reservations', label: 'Seat preferences', stage: 'sale' },
  { id: 'reservation.namedPlace', group: 'Seat reservations', label: 'Named seat or compartment', stage: 'sale' },
  { id: 'reservation.nearby', group: 'Seat reservations', label: 'Seat near a given place', stage: 'sale' },
  { id: 'reservation.placeMap', group: 'Seat reservations', label: 'Seat map', optional: true, goal: ['08. GET Place Maps', '08b. GET Place Map Post-Booking'] },
  { id: 'return.separate', group: 'Return journeys', label: 'Return as two offers', stage: 'sale' },
  { id: 'return.combined', group: 'Return journeys', label: 'Return as one offer', stage: 'sale' },
  { id: 'fulfilment.documents', group: 'Fulfilment', label: 'Fulfilment documents read one by one', optional: true, goal: ['06b. GET Fulfillment'] },
  { id: 'ancillaries', group: 'Sale', label: 'Ancillaries', goal: ['10. POST Add Ancillary to Booking'] },
  { id: 'refund.offer', group: 'Refund', label: 'Refund offer asked', goal: ['10. POST Refund Offers'] },
  { id: 'refund.full', group: 'Refund', label: 'Full refund', goal: ['13. PATCH Refund Offer'] },
  { id: 'refund.partial.fulfillment', group: 'Refund', label: 'Partial refund by fulfilment', goal: ['13. PATCH Refund Offer'] },
  { id: 'refund.partial.passenger', group: 'Refund', label: 'Partial refund by passenger', goal: ['13. PATCH Refund Offer'] },
  { id: 'refund.partial.leg', group: 'Refund', label: 'Partial refund by leg', goal: ['13. PATCH Refund Offer'] },
  { id: 'refund.technical', group: 'Refund', label: 'Technical cancellation (overrule code)', goal: ['13. PATCH Refund Offer'] },
  { id: 'refund.receipt', group: 'Refund', label: 'Refund receipt', optional: true, goal: ['14b. GET Booking Refund Receipt'] },
  { id: 'refund.withdraw', group: 'Refund', label: 'Refund offer withdrawn', optional: true, goal: ['15. DEL Refund Offer'] },
  { id: 'exchange.full', group: 'Exchange', label: 'Exchange', goal: ['14. POST Obtaining Fulfillments from Booking'] },
  { id: 'exchange.withdraw', group: 'Exchange', label: 'Exchange withdrawn', optional: true, goal: ['16. DEL Exchange Offer'] },
  { id: 'fares.offers', group: 'Fares', label: 'Fare offers', stage: 'offer' },
  { id: 'fares.sale', group: 'Fares', label: 'Fare sale', goal: [SALE_GOAL] },
  { id: 'fares.refund', group: 'Fares', label: 'Fare refund', goal: ['13. PATCH Refund Offer'] },
  { id: 'fares.reservation', group: 'Fares', label: 'Fare reservation (bicycle)', stage: 'sale' },
  { id: 'expiry', group: 'Time limits', label: 'Time limits of offers, bookings and after-sale offers', stage: 'offer' },
]);
const CAPABILITY = new Map(CAPABILITIES.map((c) => [c.id, c]));

// The system information reads, and the reads the collection treats as
// optional (#488: library-bruno/auth.js OPTIONAL_READ_PROBES, the report's
// CAPABILITY_PROBE_ENDPOINTS; a test keeps the three alike).
const SYSTEM_INFO_STEPS = Object.freeze([
  '00. GET System Version Check', '01. GET Coach', '02. GET Coach By Id', '04. GET Passenger Categories',
  '05. GET Promotion Codes', '06. GET Reduction Cards', '07. GET Zones', '08. GET Products',
  '09. GET Product By ProductId', '10. GET Product Tags',
]);
const OPTIONAL_READS = new Set([...SYSTEM_INFO_STEPS, '04. GET Passenger', '11. GET Refund Offer', '12. GET Exchange Offer', '06b. GET Fulfillment']);

/**
 * What each request of the collection does, by its name. A role is a
 * capability id, or one of four words resolved per scenario
 * (stepCapabilities): `offers` (the form of its offer request), `sale` (a
 * product or a fare sale), `refund` (the kind of its refund), `refundOffer`.
 * The access token requests are OSCAR's, not the provider's capabilities.
 */
const STEP_ROLES = Object.freeze({
  ...Object.fromEntries(SYSTEM_INFO_STEPS.map((name) => [name, 'masterData'])),
  '01. POST Get Offer': 'offers',
  '01b. POST Get Return Offer': 'offers',
  '01c. POST Get Offer without Cards': 'offers',
  '01d. POST Get Offer Individual': 'offers',
  'POST Offer-Req param chk': 'offers',
  '02. POST Create Booking': 'sale',
  '03. PATCH Multi Passenger': 'passengers.update',
  '04. GET Passenger': 'passengers.update',
  '05. GET Booking before Fulfillments': 'sale',
  [SALE_GOAL]: 'sale',
  '06b. GET Fulfillment': 'fulfilment.documents',
  '07. GET Booking after Fulfillments': 'sale',
  '08. GET Place Maps': 'reservation.placeMap',
  '08b. GET Place Map Post-Booking': 'reservation.placeMap',
  '09. POST Add Reservation to Booking': 'reservation.addLater',
  '10. POST Add Ancillary to Booking': 'ancillaries',
  '11. Add Ancillary - Get Additional Offers': 'ancillaries',
  '12. GET Booking Purchaser': 'purchaser',
  '13. PATCH Booking Purchaser': 'purchaser',
  '14. POST Booking Purchaser': 'purchaser',
  '10. POST Refund Offers': 'refundOffer',
  '11. GET Refund Offer': 'refundOffer',
  '12. GET Booking before Patch Refund': 'refundOffer',
  '13. PATCH Refund Offer': 'refund',
  '14. GET Booking after Patch Refund': 'refund',
  '14b. GET Booking Refund Receipt': 'refund.receipt',
  '15. DEL Refund Offer': 'refund.withdraw',
  '16. GET Booking after Delete Refund': 'refund.withdraw',
  '10. POST Exchange Offers': 'exchange.full',
  '11. POST Exchange Operations': 'exchange.full',
  '12. GET Exchange Offer': 'exchange.full',
  '13. GET Booking before Fulfillment': 'exchange.full',
  '14. POST Obtaining Fulfillments from Booking': 'exchange.full',
  '15. GET Booking after Fulfillment': 'exchange.full',
  '16. DEL Exchange Offer': 'exchange.withdraw',
  '17. GET Booking after Fulfillment': 'exchange.withdraw',
});
// The steps of each stage: what must have gone through for a trait to count.
const STAGE_ROLES = Object.freeze({ offer: new Set(['offers']), sale: new Set(['offers', 'sale']) });
const STAGE_GOAL = Object.freeze({ offer: OFFER_GOAL, sale: SALE_GOAL });

const OFFER_FORM_CAPABILITY = Object.freeze({ SEARCH: 'offers.search', SPECIFICATION: 'offers.specification', TRIP_IDS: 'offers.tripIds' });
const PLACE_FLOW_CAPABILITY = Object.freeze({
  AUTOMATIC_PLACE_SELECTION_PREFERENCES: 'reservation.preferences', AUTOMATIC_PLACE_SELECTION_NEARBY: 'reservation.nearby',
  MANUAL_PLACE_SELECTION_WITHOUT_FEE: 'reservation.namedPlace', MANUAL_PLACE_SELECTION_WITH_FEE: 'reservation.namedPlace',
});
const BOOKING_FORM_CAPABILITY = Object.freeze({
  RESERVATION_SELECTION: 'reservation.optional', PLACE_SELECTION: 'reservation.placeSelection', ADD_LATER: 'reservation.addLater',
});
// An overrule code that asks nothing (catalogueMatch's NO_OVERRULE).
const NO_OVERRULE = new Set(['', 'null', 'CODE_DOES_NOT_EXIST']);
const REFUSAL_FLAGS = Object.freeze([
  'passengerLimitExpectRejection', 'departureExpectRejection', 'emptyPassengersExpectRejection', 'overruleCodeExpectRejection',
  'tripIdsExpectRejection', 'currencyExpectRejection', 'offerOptionExpectRejection', 'expectedProductAbsent',
  'refundAgainProbe', 'exchangeRefundedProbe', 'confirmAgainProbe',
  'expiredOfferTest', 'expiredBookingTest', 'expiredRefundOfferTest', 'expiredExchangeOfferTest',
]);

// ── A scenario's traits ─────────────────────────────────────────────────────

const typeOf = (scenario) => String(scenario?.scenarioType || 'SALE').toUpperCase();
const actionOf = (scenario) => String(scenario?.scenarioAction || '').toUpperCase();
const passengersOf = (scenario, datafile) => arr(arr(datafile?.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId)?.passengers)
  .filter(isObj);
const hasCards = (passengers) => passengers.some((p) => arr(p.reductionCards).length > 0);
const hasAges = (passengers) => passengers.some((p) => filled(p.bornYearsBeforeTravel) || text(p.expectedPassengerType));
const partsOf = (scenario, datafile) => arr(scenarioOfferCriteria(scenario, datafile)?.requestedOfferParts).map(String);

/** True when the scenario asks fares (#903–#906): a fare part, a section, or a negative fare request. */
function isFareScenario(scenario, datafile) {
  return distributionModesOf(scenario, datafile).includes('FARE');
}

/** True when the scenario is an expected refusal (R4): an NHF code or a flag arming a refusal. */
function isRefusalTest(scenario) {
  if (!isObj(scenario)) return false;
  if (text(scenario.code).startsWith('NHF_')) return true;
  if (scenario.expectFares === false || text(scenario.requestedInformationProbe) || ['invalid', 'invalid_at_booking'].includes(text(scenario.bookingPurchaserMode))) return true;
  return REFUSAL_FLAGS.some((f) => armed(scenario[f]));
}

/** The kind of a refund scenario's refund (the role `refund`). */
function refundCapability(scenario, datafile) {
  if (isFareScenario(scenario, datafile)) return 'fares.refund';
  if (!NO_OVERRULE.has(text(scenario.overruleCode))) return 'refund.technical';
  if (armed(scenario.partialRefundByFulfillment)) return 'refund.partial.fulfillment';
  if (armed(scenario.partialRefundByPax)) return 'refund.partial.passenger';
  if (armed(scenario.partialRefundByLeg)) return 'refund.partial.leg';
  return 'refund.full';
}

// The seat reservation a scenario's booking asks, if any.
function reservationCapability(scenario) {
  const form = text(scenario.reservationBookingForm);
  if (form === 'ADD_LATER') return BOOKING_FORM_CAPABILITY.ADD_LATER;
  const flow = text(scenario.placeSelectionFlow);
  if (PLACE_FLOW_CAPABILITY[flow]) return PLACE_FLOW_CAPABILITY[flow];
  if (text(scenario.namedPlaceKind)) return 'reservation.namedPlace';
  if (arr(scenario.placePreferences).length > 0 || text(scenario.placePreferences)) return 'reservation.preferences';
  return BOOKING_FORM_CAPABILITY[form] || null;
}

// The capability a sale scenario is for, from its fields, most specific first.
const SALE_RULES = [
  [(s) => armed(s.idempotencyCheck), 'sale.idempotency'],
  [(s) => armed(s.confirmAgainProbe) || armed(s.emptyPassengersExpectRejection), 'sale'],
  [(s) => reservationCapability(s) !== null, (s) => reservationCapability(s)],
  [(s, df) => text(s.expectedProduct) && scenarioOfferCriteria(s, df)?.offerMode === 'COLLECTIVE', 'sale.groupTariff'],
  [(s) => armed(s.expectedProductAbsent), 'sale.groupTariff'],
  [(s) => text(s.expectedProduct), 'sale.products'],
  [(s) => arr(s.legTravelClasses).length > 0, 'sale.classPerLeg'],
  [(s) => armed(s.passengerLimitExpectRejection) || armed(s.departureExpectRejection) || filled(s.departureDaysFromToday), 'sale.limits'],
  [(s) => text(s.requestedInformationProbe) === 'omit', 'passengers.requestedInformation'],
  [(s) => text(s.requestedInformationProbe), 'passengers.update'],
  [(s) => text(s.bookingPurchaserMode), 'purchaser'],
  [(s, df) => armed(s.currencyExpectRejection) || text(s.expectedCurrency) || text(scenarioOfferCriteria(s, df)?.currency), 'sale.currencies'],
  [(s) => armed(s.offersByTripIds) || armed(s.tripIdsExpectRejection), 'offers.tripIds'],
  [(s, df) => hasCards(passengersOf(s, df)), 'sale.reductionCards'],
  [(s, df) => hasAges(passengersOf(s, df)), 'passengers.ages'],
  [(s) => scenarioReturnModel(s) === 'COMBINED', 'return.combined'],
  [(s) => scenarioReturnModel(s) === 'SEPARATE', 'return.separate'],
  [(s, df) => tripSearchParametersOf(s, df).length > 0, 'offers.tripParameters'],
];

function saleCapability(scenario, datafile) {
  for (const [test, capability] of SALE_RULES) {
    if (test(scenario, datafile)) return typeof capability === 'function' ? capability(scenario) : capability;
  }
  return 'sale';
}

function fareCapability(scenario, datafile) {
  if (typeOf(scenario) === 'REFUND') return 'fares.refund';
  if (scenario.expectFares === false) return 'fares.offers';
  if (partsOf(scenario, datafile).includes('FARE_RESERVATION')) return 'fares.reservation';
  return 'fares.sale';
}

function refundScenarioCapability(scenario, datafile) {
  if (armed(scenario.exchangeRefundedProbe)) return 'exchange.full';
  if (armed(scenario.expiredRefundOfferTest)) return 'expiry';
  const action = actionOf(scenario);
  if (action === 'DELETE') return 'refund.withdraw';
  if (action !== 'PATCH') return 'refund.offer';
  if (filled(scenario.refundReceiptMaxWaitMinutes)) return 'refund.receipt';
  return refundCapability(scenario, datafile);
}

/**
 * The capability a scenario is for when no catalogue entry names it: from
 * its probes, its kind (refund, exchange, fares) and its sale fields.
 */
function derivedCapability(scenario, datafile) {
  if (!isObj(scenario)) return 'sale';
  if (armed(scenario.offerOptionDiscovery)) return 'offers.requestOptions';
  if (armed(scenario.offerSearchProbe) || armed(scenario.offerOptionExpectRejection)) {
    return tripSearchParametersOf(scenario, datafile).length > 0 ? 'offers.tripParameters' : 'offers.options';
  }
  if (['expiredOfferTest', 'expiredBookingTest', 'expiredExchangeOfferTest'].some((f) => armed(scenario[f]))) return 'expiry';
  if (isFareScenario(scenario, datafile)) return fareCapability(scenario, datafile);
  const type = typeOf(scenario);
  if (type === 'REFUND') return refundScenarioCapability(scenario, datafile);
  if (type === 'EXCHANGE') return actionOf(scenario) === 'DELETE' ? 'exchange.withdraw' : 'exchange.full';
  return saleCapability(scenario, datafile);
}

/**
 * The traits of a scenario the report needs: its offer request form, whether
 * it is a fare sale, its refund kind, and the capabilities its other fields
 * exercise (each with the stage that proves it).
 */
// The traits a scenario's fields exercise besides its main capability: each
// rule gives the capabilities it proves (none, one or several).
const FEATURE_RULES = [
  (s) => ({ COMBINED: ['return.combined'], SEPARATE: ['return.separate'] }[scenarioReturnModel(s)] || []),
  (s) => { const r = reservationCapability(s); return r && r !== 'reservation.addLater' ? [r] : []; },
  (s) => (PLACE_FLOW_CAPABILITY[placeSelectionFlowOf(s)] ? [PLACE_FLOW_CAPABILITY[placeSelectionFlowOf(s)]] : []),
  (s, df) => (hasCards(passengersOf(s, df)) ? ['sale.reductionCards'] : []),
  (s, df) => (hasAges(passengersOf(s, df)) ? ['passengers.ages'] : []),
  (s, df) => {
    if (!text(s.expectedProduct) || armed(s.expectedProductAbsent)) return [];
    return [scenarioOfferCriteria(s, df)?.offerMode === 'COLLECTIVE' ? 'sale.groupTariff' : 'sale.products'];
  },
  (s) => (arr(s.legTravelClasses).length > 0 ? ['sale.classPerLeg'] : []),
  (s, df) => (tripSearchParametersOf(s, df).length > 0 ? ['offers.tripParameters'] : []),
  (s, df) => (text(s.expectedCurrency) || text(scenarioOfferCriteria(s, df)?.currency) ? ['sale.currencies'] : []),
  (s, df) => (isFareScenario(s, df) ? ['fares.offers'] : []),
];

function traitsOf(scenario, datafile) {
  const fare = isFareScenario(scenario, datafile) && text(scenario.bookMode).toUpperCase() !== 'PRODUCT';
  const features = new Set(FEATURE_RULES.flatMap((rule) => rule(scenario, datafile)));
  if (fare && partsOf(scenario, datafile).includes('FARE_RESERVATION')) features.add('fares.reservation');
  return {
    form: offerRequestFormOf(scenario, datafile),
    fare,
    refund: typeOf(scenario) === 'REFUND' ? refundCapability(scenario, datafile) : null,
    features: [...features],
  };
}

/** The capabilities a step proves for a scenario of these traits. */
function stepCapabilities(stepName, traits) {
  const role = STEP_ROLES[stepName];
  if (!role) return [];
  if (role === 'offers') return [OFFER_FORM_CAPABILITY[traits?.form] || 'offers.search'];
  if (role === 'sale') return [traits?.fare ? 'fares.sale' : 'sale'];
  if (role === 'refundOffer') return ['refund.offer'];
  if (role === 'refund') return [traits?.refund || 'refund.full'];
  return [role];
}

/** The role of a step (`offers`, `sale`, a capability id…), or null for a request the table does not know. */
const roleOf = (stepName) => STEP_ROLES[stepName] || null;
const isOptionalRead = (stepName) => OPTIONAL_READS.has(stepName);

// The capabilities every provider must have: a point under them can never be
// answered "not supported" (#994, maintainer, 2026-10-27).
const ALWAYS_REQUIRED = Object.freeze(['sale', 'offers.search']);

module.exports = {
  CAPABILITIES, CAPABILITY, GROUPS, STEP_ROLES, STAGE_ROLES, STAGE_GOAL, SYSTEM_INFO_STEPS, OPTIONAL_READS, SALE_GOAL, OFFER_GOAL, ALWAYS_REQUIRED, armed,
  derivedCapability, traitsOf, stepCapabilities, isRefusalTest, isFareScenario, roleOf, isOptionalRead, refundCapability,
};
