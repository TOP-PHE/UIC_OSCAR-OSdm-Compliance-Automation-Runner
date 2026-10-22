// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// The ready-made OSCAR data file must stay loadable by OSCAR and answerable
// by the simulator: nobody opens it until the day it is needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProviders } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { buildTripCollection } = require('../src/osdm/trips');
const { PROVIDERS_DIR } = require('./helpers');

const collection = path.join(__dirname, '..', '..', 'Bruno_Collection');
const fullDatafile = require(path.join(collection, 'data_base', 'simulator_datafile.json'));
const { VERSIONS, NOT_POSSIBLE, reasonNotPossible, baseOf, copyOf } = require('../scripts/version-copies-lib');

// #914: every `_38` scenario has its copies for 3.6, 3.7 and 3.9, made by
// scripts/version-copies.js and checked by their own test below. The other
// tests read the file without them: what they pin of a gamma scenario holds
// for its copies, which differ from it in code, version and description only.
const sourceOf = new Map(fullDatafile.scenarios.filter((s) => s.osdmVersion === '3.8.0').map((s) => [baseOf(s.code), s]));
const isGeneratedCopy = (s) => {
  const source = sourceOf.get(baseOf(s.code));
  return s.osdmVersion !== '3.8.0' && !!source && JSON.stringify(copyOf(source, s.osdmVersion)) === JSON.stringify(s);
};
const datafile = { ...fullDatafile, scenarios: fullDatafile.scenarios.filter((s) => !isGeneratedCopy(s)) };

test('the ready-made data file is valid against the collection\'s data file schema', () => {
  // Checked with the copy of Ajv that the collection carries, so the simulator
  // keeps no dependency. That copy does not have the 2020-12 meta-schema the
  // file declares, so the declaration is left out; the keywords the schema
  // uses (type, enum, required, properties, items, minimum) read the same without it.
  const Ajv = require(path.join(collection, 'json_validator', 'ajv.js'));
  const { $schema: _declared, ...schema } = require(path.join(collection, 'json_validator', 'datafile.schema.json'));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(validate({ ...fullDatafile, scenarios: [{}] }), false, 'the schema must be able to refuse a file');
  assert.equal(validate(fullDatafile), true, JSON.stringify(validate.errors, null, 1));
});

test('every scenario points at entries that exist, and the run list at scenarios that exist', () => {
  const ids = (list) => new Set(fullDatafile[list].map((entry) => entry.id));
  const codes = fullDatafile.scenarios.map((s) => s.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const scenario of fullDatafile.scenarios) {
    assert.ok(ids('tripRequirements').has(scenario.tripRequirementId), scenario.code);
    assert.ok(ids('passengersList').has(scenario.passengersListId), scenario.code);
    assert.ok(ids('purchaserList').has(scenario.purchaserListId), scenario.code);
    assert.ok(ids('requestedFulfillmentOptionsList').has(scenario.requestedFulfillmentOptionsListId), scenario.code);
    assert.ok(ids('offerSearchCriteriaList').has(scenario.offerSearchCriteriaListId), scenario.code);
    // A sale, the refund of one (#595), or its exchange (#611).
    assert.ok(['SALE', 'REFUND', 'EXCHANGE'].includes(scenario.scenarioType), `${scenario.code}: ${scenario.scenarioType}`);
    // A refund is confirmed (PATCH), withdrawn (DELETE) or only asked for; an
    // exchange is confirmed (no action) or withdrawn (DELETE).
    const actions = { SALE: [null], REFUND: ['PATCH', 'DELETE', null], EXCHANGE: [null, 'DELETE'] }[scenario.scenarioType];
    assert.ok(actions.includes(scenario.scenarioAction), `${scenario.code}: ${scenario.scenarioAction}`);
    assert.equal(scenario.shared, true, 'a tester must see the scenario');
    assert.equal(scenario.created_by, undefined, 'the file belongs to no one in particular');
    // The collection checks a passenger against the updated values even when
    // the update step is off, so the update has to be on.
    assert.equal(scenario.salesFlowActions.patchPassengers, true);
  }
  for (const code of datafile.scenariosToRun) assert.ok(codes.includes(code), code);
});

test('each provider\'s OSDM version has every scenario of gamma its version can express, and the run list is gamma\'s (#914)', () => {
  // One file for the four providers (#614): a scenario asks for one version,
  // so each provider runs the scenarios of its own and the version check agrees.
  // Since #914 every `_38` scenario is copied for 3.6, 3.7 and 3.9, but those
  // reasonNotPossible() leaves out (the return in one offer does not exist in 3.6).
  const providers = [...loadProviders(PROVIDERS_DIR).values()];
  assert.deepEqual([...new Set(fullDatafile.scenarios.map((s) => s.osdmVersion))].sort(), providers.map((p) => p.osdmVersion).sort());
  const byCode = new Map(fullDatafile.scenarios.map((s) => [s.code, s]));
  const strip = ({ code: _c, osdmVersion: _v, description: _d, ...rest }) => JSON.stringify(rest);
  for (const scenario of fullDatafile.scenarios) {
    assert.equal(scenario.code, `${baseOf(scenario.code)}_${scenario.osdmVersion.slice(0, 3).replace('.', '')}`, 'the code names the version');
    if (scenario.osdmVersion === '3.8.0') continue;
    const source = sourceOf.get(baseOf(scenario.code));
    assert.ok(source, `${scenario.code}: no _38 scenario it is a copy of`);
    assert.equal(strip(scenario), strip(copyOf(source, scenario.osdmVersion)), `${scenario.code} differs from the copy of ${source.code} in more than its description: run scripts/version-copies.js`);
  }
  for (const [version, { suffix }] of Object.entries(VERSIONS)) {
    for (const [base, source] of sourceOf) {
      const code = `${base}_${suffix}`;
      const reason = reasonNotPossible(source, version);
      if (reason) assert.ok(!byCode.has(code), `${code} cannot exist: ${reason}`);
      else assert.ok(byCode.has(code), `${code} is missing: run scripts/version-copies.js`);
    }
    for (const base of Object.keys(NOT_POSSIBLE[version])) assert.ok(sourceOf.has(base), `${version}: ${base} is not a _38 scenario`);
  }
  const gamma = providers.find((p) => p.key === 'gamma');
  // The deliberately wrong scenarios (#611) and the injected faults (#833)
  // fail on purpose: not in the run list.
  assert.deepEqual(fullDatafile.scenariosToRun, fullDatafile.scenarios
    .filter((s) => s.osdmVersion === gamma.osdmVersion && !s.code.startsWith('SIM_WRONG_') && !s.code.startsWith('SIM_FAULT_')).map((s) => s.code));
});

test('the return scenarios name a model their version defines, and expect a ticket per direction', () => {
  // The weekend group return (#599) is the group test below; the documents
  // return (#603), the documents test.
  // A card or a product on a return, the card and product tests.
  const returns = datafile.scenarios.filter((s) => s.offerSearchCriteria.returnOffsetDays != null && s.scenarioType === 'SALE'
    && !['SIM_GROUP_', 'SIM_SALE_DOCUMENTS_', 'SIM_SALE_CARD_', 'SIM_SALE_PRODUCT_'].some((prefix) => s.code.startsWith(prefix)));
  assert.equal(returns.length, 7);
  for (const scenario of returns) {
    const model = scenario.offerSearchCriteria.returnModel;
    assert.ok(scenario.code.startsWith(`SIM_RETURN_${model}_`), scenario.code);
    if (model === 'COMBINED') assert.notEqual(scenario.osdmVersion, '3.6.0', 'outboundTripIds is OSDM 3.7 and later');
    assert.equal(scenario.offerSearchCriteria.returnFulfillments, 'PER_DIRECTION');
  }
});

// #697: a refund by passenger or by leg, on a trip of gamma sold with one
// ticket per passenger or per leg (the only bookings it refunds so).
const BY_SCOPE = new Map([
  ['SIM_REFUND_PAX_2ADT_38', { axis: 'partialRefundByPax', selection: 'partialRefundPaxSelection', stop: 'perPassengerFrom', passengers: 2 }],
  ['SIM_REFUND_LEG_1ADT_38', { axis: 'partialRefundByLeg', selection: 'partialRefundLegSelection', stop: 'perLegFrom', passengers: 1 }],
  // #699: the last third of gamma's maximum of 19 passengers.
  ['SIM_REFUND_PAX_THIRD_19PAX_38', { axis: 'partialRefundByPax', selection: 'partialRefundPaxSelection', value: 'third', stop: 'perPassengerFrom', passengers: 19 }],
]);

test('the refunds by passenger and by leg run on gamma\'s trips sold per passenger and per leg (#697)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  for (const [code, want] of BY_SCOPE) {
    const scenario = datafile.scenarios.find((s) => s.code === code);
    assert.ok(scenario, code);
    assert.equal(scenario.scenarioType, 'REFUND');
    assert.equal(scenario.scenarioAction, 'PATCH');
    assert.equal(scenario[want.axis], 'on', code);
    assert.equal(scenario[want.selection], want.value || 'last', code);
    assert.equal(scenario.partialRefundByFulfillment, 'off', code);
    assert.equal(scenario.offerSearchCriteria.returnOffsetDays, undefined, `${code} is one-way`);
    const trip = datafile.tripRequirements.find((t) => t.id === scenario.tripRequirementId);
    const origin = trip.trip?.origin ?? trip.legs[0].origin;
    assert.equal(origin, gamma.ticketing[want.stop], code);
    if (want.axis === 'partialRefundByLeg') assert.equal(trip.legs.length, 2);
    assert.equal(datafile.passengersList.find((l) => l.id === scenario.passengersListId).passengers.length, want.passengers);
    assert.ok(datafile.scenariosToRun.includes(code), code);
  }
});

test('the refund scenarios refund a return: in full, and the inbound ticket alone', () => {
  // #595: a return gives one ticket per direction on the simulator, so a full
  // refund confirms two refund offers and a partial one refunds one ticket.
  // The confirmed ones; the withdrawn and the unconfirmed one (#611) are below.
  const refunds = datafile.scenarios.filter((s) => s.scenarioType === 'REFUND' && s.scenarioAction === 'PATCH'
    // #907: SIM_FARE_REFUND_ ones refund a one-way fare sale, tested with the fares below.
    && !['SIM_NHF_', 'SIM_VARIANT_', 'SIM_WRONG_', 'SIM_FAULT_', 'SIM_FARE_'].some((prefix) => s.code.startsWith(prefix))
    && !BY_SCOPE.has(s.code));
  // Some providers sell a return only as one offer: the SIM_REFUND_COMBINED_ ones refund that.
  // #781: SIM_CURRENCY_EUR_REFUND_RETURN_1ADT_38 is the full refund of a return sold in EUR.
  assert.equal(refunds.length, 19);
  for (const scenario of refunds) {
    assert.notEqual(scenario.offerSearchCriteria.returnOffsetDays, null, `${scenario.code} is a return`);
    assert.equal(scenario.offerSearchCriteria.returnModel === 'COMBINED', scenario.code.startsWith('SIM_REFUND_COMBINED_'), scenario.code);
    const partial = scenario.partialRefundByFulfillment === 'on';
    assert.equal(partial, /^SIM_REFUND_(COMBINED_)?INBOUND_/.test(scenario.code), scenario.code);
    if (partial) assert.equal(scenario.partialRefundFulfillmentSelection, 'inbound');
    for (const axis of ['partialRefundByLeg', 'partialRefundByPax']) {
      assert.ok([undefined, 'off', false].includes(scenario[axis]), `${scenario.code}: the provider refuses a scope by leg or passenger`);
    }
  }
});

test('the refund offers not confirmed, and the exchanges: one-way, on gamma, the way each ends (#611)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  assert.equal(gamma.exchange, true);
  const ends = Object.fromEntries(datafile.scenarios
    .filter((s) => s.code.startsWith('SIM_EXCHANGE_') || (s.scenarioType === 'REFUND' && s.scenarioAction !== 'PATCH'))
    .map((s) => [s.code, `${s.scenarioType} ${s.scenarioAction}`]));
  assert.deepEqual(ends, {
    SIM_EXCHANGE_1ADT_38: 'EXCHANGE null',
    SIM_EXCHANGE_DELETE_1ADT_38: 'EXCHANGE DELETE',
    SIM_REFUND_DELETE_1ADT_38: 'REFUND DELETE',
    SIM_REFUND_ONLY_OFFER_1ADT_38: 'REFUND null',
  });
  for (const code of Object.keys(ends)) {
    const scenario = datafile.scenarios.find((s) => s.code === code);
    assert.equal(scenario.offerSearchCriteria.returnOffsetDays, undefined, `${code} is one-way`);
    assert.equal(scenario.osdmVersion, gamma.osdmVersion);
    assert.equal(scenario.desiredFlexibility, 'FULL_FLEXIBLE', code);
  }
});

test('the expiry probes: one per deadline (and one chain, #652), on the short-deadline trip, with a wait that covers it (#611)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const station = gamma.shortDeadlines.stopPlaceRef;
  const shortTrips = datafile.tripRequirements.filter((t) => t.trip?.origin === station).map((t) => t.id);
  assert.equal(shortTrips.length, 1);
  const probes = datafile.scenarios.filter((s) => s.code.startsWith('SIM_NHF_EXPIRED_'));
  const flags = Object.fromEntries(probes.map((s) => [s.code, Object.keys(s).filter((k) => /^expired.*Test$/.test(k) && s[k] === 'on')]));
  assert.deepEqual(flags, {
    SIM_NHF_EXPIRED_OFFER_38: ['expiredOfferTest'],
    SIM_NHF_EXPIRED_BOOKING_38: ['expiredBookingTest'],
    SIM_NHF_EXPIRED_REFUND_OFFER_38: ['expiredRefundOfferTest'],
    SIM_NHF_EXPIRED_CHAIN_SEATMAP_38: ['expiredBookingTest', 'expiredRefundOfferTest'],
    SIM_NHF_EXPIRED_EXCHANGE_OFFER_38: ['expiredExchangeOfferTest'],
  });
  for (const scenario of probes) {
    assert.equal(scenario.tripRequirementId, shortTrips[0], scenario.code);
    for (const flag of flags[scenario.code]) {
      // The deadline plus the collection's 15 s margin and 45 s of headroom.
      assert.ok(scenario[flag.replace(/Test$/, 'MaxWaitMinutes')] * 60 >= gamma.shortDeadlines.seconds + 60, scenario.code);
    }
  }
  // No other scenario uses the short-deadline trip: its runs would expire under it.
  for (const scenario of datafile.scenarios) {
    if (!scenario.code.startsWith('SIM_NHF_EXPIRED_')) assert.notEqual(scenario.tripRequirementId, shortTrips[0], scenario.code);
  }
});

test('the variants and the deliberately wrong answers: each named by a passenger of its own list (#611)', () => {
  const variantOf = (scenario) => {
    const list = datafile.passengersList.find((l) => l.id === scenario.passengersListId);
    const named = list.passengers.map((p) => p.lastName).filter((n) => n.startsWith('Simvariant-'));
    return named.map((n) => n.slice('Simvariant-'.length).toLowerCase());
  };
  const expected = {
    SIM_VARIANT_PER_PASSENGER_2ADT_38: ['per-passenger'],
    SIM_VARIANT_PER_PASSENGER_REFUND_PAX_2ADT_38: ['per-passenger'],
    SIM_VARIANT_REORDERED_2ADT_38: ['reordered'],
    SIM_VARIANT_MINIMAL_2ADT_38: ['minimal'],
    SIM_VARIANT_MAIN_PASSENGER_2ADT_38: ['main-passenger-only', 'main-names-only'],
    SIM_VARIANT_IGNORES_PREFERENCES_1ADT_38: ['ignores-place-preferences'],
    SIM_VARIANT_IGNORES_REFERENCE_1ADT_38: ['ignores-reference-place'],
    SIM_VARIANT_REFUSES_BARE_PLACE_SELECTION_1ADT_38: ['refuses-bare-place-selection'],
    SIM_VARIANT_ONE_FULFILLMENT_PER_REFUND_1ADT_38: ['one-fulfillment-per-refund-request'],
    SIM_WRONG_OFFER_PRICE_38: [],
    SIM_WRONG_CARD_RATE_38: [],
    SIM_WRONG_BOOKING_PRICE_38: ['wrong-booking-price'],
    SIM_WRONG_FULFILLMENT_STATUS_38: ['wrong-fulfillment-status'],
    SIM_WRONG_REFUND_AMOUNT_38: ['wrong-refund-amount'],
    SIM_WRONG_EXCHANGE_AMOUNT_38: ['wrong-exchange-amount'],
    SIM_WRONG_NAMED_PLACE_38: ['gives-other-place'],
    SIM_WRONG_OFFER_PROBE_IGNORED_38: [],
    SIM_WRONG_OFFER_PROBE_RESERVATION_ONLY_38: [],
    SIM_WRONG_OFFER_PROBE_PRODUCT_TAG_PASS_38: [],
    SIM_WRONG_TRIP_PROBE_VIA_TRANSFER_LIMIT_38: [],
    SIM_WRONG_OFFER_PROBE_NOT_DECLARED_SOLD_38: [],
    SIM_WRONG_CURRENCY_DEFAULT_38: [],
    // #903: the fare variants are chosen by the section's start station.
    SIM_WRONG_FARE_PASSENGER_WITHOUT_FARE_38: [],
    SIM_WRONG_FARE_UNKNOWN_CLUSTER_38: [],
    SIM_WRONG_FARE_WIDER_CLUSTERS_38: [],
    SIM_WRONG_FARE_SECTION_GAP_38: [],
    SIM_WRONG_FARE_OVERLAP_38: [],
    SIM_WRONG_FARE_UNREQUESTED_38: [],
    // #905: chosen by its trip's origin, the request naming no section.
    SIM_WRONG_FARE_WITHOUT_SECTION_38: [],
    // #906: the fare fulfilment's variants, named by a passenger as the others.
    SIM_WRONG_FARE_FULFILLMENT_DOCUMENT_38: ['fare-fulfillment-document'],
    SIM_WRONG_FARE_NOT_IN_FULFILLMENT_38: ['fare-not-in-fulfillment'],
    // #907: the fare refund's variants.
    SIM_WRONG_FARE_COMBINING_FEE_38: ['fare-wrong-combining-fee'],
    SIM_WRONG_FARE_IGNORES_REFUND_FEE_38: ['fare-ignores-refund-fee'],
  };
  const found = Object.fromEntries(datafile.scenarios
    .filter((s) => s.code.startsWith('SIM_VARIANT_') || s.code.startsWith('SIM_WRONG_')).map((s) => [s.code, variantOf(s)]));
  assert.deepEqual(found, expected);
  // No other scenario carries a variant by accident.
  for (const scenario of datafile.scenarios) {
    if (!(scenario.code in expected)) assert.deepEqual(variantOf(scenario), [], scenario.code);
  }
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const wrongTrip = datafile.tripRequirements.find((t) => t.trip?.origin === gamma.variants.wrongOffersFrom);
  assert.deepEqual(datafile.scenarios.filter((s) => s.tripRequirementId === wrongTrip.id).map((s) => s.code), ['SIM_WRONG_OFFER_PRICE_38']);
  // #780: the station where gamma ignores the offer search criteria, for one probe only.
  const ignoringTrip = datafile.tripRequirements.find((t) => t.trip?.origin === gamma.variants.ignoresOfferOptionsFrom);
  assert.deepEqual(datafile.scenarios.filter((s) => s.tripRequirementId === ignoringTrip.id).map((s) => s.code), ['SIM_WRONG_OFFER_PROBE_IGNORED_38']);
  // As with some providers, only the main passenger may be changed: the scenario updates it alone.
  const scoped = datafile.scenarios.filter((s) => s.passengerUpdateScope != null).map((s) => [s.code, s.passengerUpdateScope]);
  assert.deepEqual(scoped, [['SIM_VARIANT_MAIN_PASSENGER_2ADT_38', 'MAIN']]);
  const byPax = datafile.scenarios.find((s) => s.code === 'SIM_VARIANT_PER_PASSENGER_REFUND_PAX_2ADT_38');
  assert.equal(byPax.partialRefundByPax, 'on');
});

test('the requested information and purchaser scenarios: the probe each one runs, and its trip (#611)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const riTrip = datafile.tripRequirements.find((t) => t.trip?.origin === gamma.personChecks.requestedInformationFrom);
  // The error faults (#833) borrow the purchaser probe to be refused: below.
  const runs = Object.fromEntries(datafile.scenarios
    .filter((s) => !s.code.startsWith('SIM_FAULT_'))
    .filter((s) => s.requestedInformationProbe || s.bookingPurchaserMode || s.tripRequirementId === riTrip.id)
    .map((s) => [s.code, [s.requestedInformationProbe || null, s.bookingPurchaserMode || null, s.tripRequirementId === riTrip.id]]));
  assert.deepEqual(runs, {
    SIM_RI_AUTOFEED_1ADT_38: [null, null, true],
    SIM_NHF_RI_OMIT_1ADT_38: ['omit', null, true],
    SIM_NHF_RI_INVALID_1ADT_38: ['invalid', null, true],
    SIM_PURCHASER_DEFERRED_1ADT_38: [null, 'deferred', false],
    SIM_NHF_PURCHASER_INVALID_1ADT_38: [null, 'invalid', false],
    SIM_NHF_PURCHASER_INVALID_AT_BOOKING_1ADT_38: [null, 'invalid_at_booking', false],
  });
});

test('the overrule scenarios: each code gamma accepts, and one it refuses (#596)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const overruled = datafile.scenarios.filter((s) => s.code.startsWith('SIM_REFUND_OVERRULE_'));
  const accepted = overruled.filter((s) => s.overruleCodeExpectRejection !== 'on');
  const refused = overruled.filter((s) => s.overruleCodeExpectRejection === 'on');
  assert.deepEqual(accepted.map((s) => s.overruleCode), gamma.overruleCodes);
  for (const scenario of accepted) assert.equal(scenario.code, `SIM_REFUND_OVERRULE_${scenario.overruleCode}_38`);
  assert.deepEqual(refused.map((s) => s.code), ['SIM_REFUND_OVERRULE_REFUSED_38']);
  assert.equal(gamma.overruleCodes.includes(refused[0].overruleCode), false, 'the probe sends a code gamma does not accept');
  for (const scenario of overruled) {
    assert.equal(scenario.osdmVersion, gamma.osdmVersion);
    // A fee without the code, so that waiving it shows.
    assert.equal(scenario.desiredFlexibility, 'SEMI_FLEXIBLE', scenario.code);
    assert.equal(scenario.partialRefundByFulfillment, 'off', scenario.code);
  }
  // The same technical cancellation on a return sold as one offer.
  const combined = datafile.scenarios.filter((s) => s.code.startsWith('SIM_REFUND_COMBINED_OVERRULE_'));
  assert.deepEqual(combined.map((s) => [s.code, s.overruleCode]), [['SIM_REFUND_COMBINED_OVERRULE_TECHNICAL_FAILURE_38', 'TECHNICAL_FAILURE']]);
  for (const scenario of datafile.scenarios.filter((s) => !overruled.includes(s) && !combined.includes(s))) assert.equal(scenario.overruleCode, null, scenario.code);
});

test('the reduction card scenarios: each card gamma lists, on a passenger of its own (#597)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const carded = datafile.scenarios.filter((s) => s.code.startsWith('SIM_SALE_CARD_'));
  assert.deepEqual(carded.map((s) => s.code), ['SIM_SALE_CARD_25_1ADT_38', 'SIM_SALE_CARD_50_2ADT_38', 'SIM_SALE_CARD_STUDENT_1YTH_38', 'SIM_SALE_CARD_STUDENT_RETURN_1YTH_38']);
  // The student card on a return sold as one offer.
  assert.equal(carded[3].offerSearchCriteria.returnModel, 'COMBINED');
  const used = [];
  for (const scenario of carded) {
    assert.equal(scenario.osdmVersion, gamma.osdmVersion);
    assert.equal(scenario.scenarioType, 'SALE');
    const list = datafile.passengersList.find((l) => l.id === scenario.passengersListId);
    const cards = list.passengers.flatMap((p) => p.reductionCards || []);
    assert.equal(cards.length, 1, `${scenario.code}: one passenger holds one card`);
    // #889: a card given as an object declares gamma's own rate.
    const card = cards[0];
    if (typeof card === 'object') assert.equal(card.percent, gamma.reductionCards.find((c) => c.code === card.code).percent, scenario.code);
    used.push(typeof card === 'object' ? card.code : card);
  }
  assert.deepEqual([...new Set(used)].sort(), gamma.reductionCards.map((c) => c.code).sort());
  // #889: the deliberately wrong rate, on gamma's 25 % card.
  const wrong = datafile.scenarios.find((s) => s.code === 'SIM_WRONG_CARD_RATE_38');
  const wrongCards = datafile.passengersList.find((l) => l.id === wrong.passengersListId).passengers.flatMap((p) => p.reductionCards || []);
  assert.deepEqual(wrongCards, [{ code: 'SIM_CARD_25', percent: 30 }]);
  carded.push(wrong);
  for (const scenario of datafile.scenarios.filter((s) => !carded.includes(s))) {
    const list = datafile.passengersList.find((l) => l.id === scenario.passengersListId);
    assert.ok(list.passengers.every((p) => !p.reductionCards), `${scenario.code} holds no card`);
  }
});

test('the product scenarios: each names a product gamma sells, by code or by name (#598)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const named = datafile.scenarios.filter((s) => s.code.startsWith('SIM_SALE_PRODUCT_'));
  assert.equal(named.length, 4);
  // The all-day ticket on a return sold as one offer.
  assert.deepEqual(named.filter((s) => s.offerSearchCriteria.returnModel === 'COMBINED').map((s) => s.code), ['SIM_SALE_PRODUCT_ALL_DAY_RETURN_1ADT_38']);
  for (const scenario of named) {
    const wanted = scenario.expectedProduct.toLowerCase();
    const product = gamma.products.find((p) => p.code.toLowerCase() === wanted || p.name.toLowerCase().includes(wanted));
    assert.ok(product, `${scenario.code}: ${scenario.expectedProduct}`);
    assert.equal(scenario.desiredFlexibility, product.flexibility, `${scenario.code}: the flexibility agrees with the product`);
  }
  assert.ok(named.some((s) => !gamma.products.some((p) => p.code === s.expectedProduct)), 'one names the product by its name');
  const others = datafile.scenarios.filter((s) => !named.includes(s) && !s.code.startsWith('SIM_GROUP_'));
  for (const scenario of others) assert.equal(scenario.expectedProduct, undefined, scenario.code);
});

test('the group scenarios: gamma offers the group product to the groups that meet its rules, and only to them (#599)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const groups = datafile.scenarios.filter((s) => s.code.startsWith('SIM_GROUP_'));
  assert.deepEqual(groups.map((s) => [s.code, s.expectedProductAbsent === 'on']), [
    ['SIM_GROUP_WEEKEND_2ADT_2CHD_38', false], ['SIM_GROUP_WEEKEND_RETURN_1ADT_2CHD_38', false], ['SIM_GROUP_6ADT_38', false],
    ['SIM_GROUP_WEEKEND_6PAX_ABSENT_38', true], ['SIM_GROUP_WEEKEND_3ADT_ABSENT_38', true],
  ]);
  for (const scenario of groups) {
    assert.equal(scenario.offerSearchCriteria.offerMode, 'COLLECTIVE', scenario.code);
    const product = gamma.products.find((p) => p.code === scenario.expectedProduct);
    assert.ok(product?.group, `${scenario.code}: a group product`);
    assert.equal(scenario.desiredFlexibility, product.flexibility, scenario.code);
    const requirement = datafile.tripRequirements.find((t) => t.id === scenario.tripRequirementId);
    // The collection moves the date to the day the trip asks for; 2026-11-21 is a Saturday.
    const day = requirement.departureDay === 'SATURDAY' ? '2026-11-21' : '2026-11-18';
    const passengers = datafile.passengersList.find((l) => l.id === scenario.passengersListId).passengers;
    const { response } = buildOfferCollection({
      tripSearchCriteria: {
        departureTime: requirement.trip.startDatetime.replace('%TRIP_DATE%', day).slice(0, 19),
        origin: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.origin },
        destination: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.destination },
      },
      anonymousPassengerSpecifications: passengers.map((p) => ({ externalRef: p.reference, type: p.type, dateOfBirth: p.dateOfBirth })),
      offerSearchCriteria: { offerMode: 'COLLECTIVE' },
    }, gamma, Date.parse('2026-11-02T09:00:00Z'));
    const offered = response.offers.some((o) => o.products[0].code === product.code);
    assert.equal(offered, scenario.expectedProductAbsent !== 'on', scenario.code);
  }
  const ret = groups.find((s) => s.code.includes('_RETURN_'));
  assert.deepEqual([ret.offerSearchCriteria.returnModel, ret.offerSearchCriteria.returnFulfillments, ret.offerSearchCriteria.returnOffsetDays], ['COMBINED', 'ONE', 1]);
});

test('the data file holds no real person, station or template', () => {
  const text = JSON.stringify(datafile);
  assert.equal(text.includes('{{'), false, 'OSCAR refuses a data file that holds a template');
  for (const email of text.match(/[\w.+-]+@[\w.-]+/g)) assert.match(email, /@example\.org$/);
  for (const station of text.match(/urn:uic:stn:\d+/g)) assert.match(station, /urn:uic:stn:00000\d\d$/);
});

// What the collection sends for a trip of the data file: a search with the
// local time, without offset, or the specified legs with their categories.
function tripRequest(requirement, day = '2026-11-20') {
  const at = (text) => text.replace('%TRIP_DATE%', day);
  if (requirement.tripType === 'SPECIFICATION') {
    return { tripSpecifications: [{ legs: requirement.legs.map((leg) => ({ timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: leg.origin }, serviceDeparture: { timetabledTime: at(leg.startDatetime) } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: leg.destination }, serviceArrival: { timetabledTime: at(leg.endDatetime) } },
      service: { vehicleNumbers: [leg.vehicleNumber], productCategory: { productCategoryRef: leg.productCategoryRef, name: leg.productCategoryName, shortName: leg.productCategoryShortName } },
    } })) }] };
  }
  return { tripSearchCriteria: {
    departureTime: at(requirement.trip.startDatetime).slice(0, 19),
    origin: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.origin },
    destination: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.destination },
  } };
}

test('every trip of the data file is one the simulator answers, on every provider', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  for (const requirement of datafile.tripRequirements) {
    assert.ok(['SEARCH', 'SPECIFICATION'].includes(requirement.tripType));
    for (const provider of providers.values()) {
      const { response } = buildOfferCollection({
        ...tripRequest(requirement),
        anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }],
      }, provider, Date.parse('2026-11-02T09:00:00Z'));
      const wanted = new Set(datafile.scenarios.filter((s) => s.tripRequirementId === requirement.id).map((s) => s.desiredFlexibility));
      const offered = new Set(response.offers.map((o) => o.offerSummary.overallFlexibility));
      for (const flexibility of wanted) assert.ok(offered.has(flexibility), `${provider.key}: ${flexibility}`);
    }
  }
});

test('the class-per-leg scenario: gamma gives first class on the InterCity leg only, with a supplement (#600)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const perLeg = datafile.scenarios.filter((s) => s.legTravelClasses != null);
  assert.deepEqual(perLeg.map((s) => [s.code, s.legTravelClasses]), [
    ['SIM_SALE_CLASS_PER_LEG_1ADT_38', ['FIRST', 'SECOND']],
    // #762: first class asked on the regional leg, which has none: no offer gives it.
    ['SIM_SALE_CLASS_PER_LEG_NOT_OFFERED_1ADT_38', ['SECOND', 'FIRST']],
  ]);
  assert.equal(perLeg[1].tripRequirementId, perLeg[0].tripRequirementId);
  const requirement = datafile.tripRequirements.find((t) => t.id === perLeg[0].tripRequirementId);
  assert.deepEqual(requirement.legs.map((l) => gamma.secondClassOnlyCategories.includes(l.productCategoryShortName)), [false, true]);
  const { response } = buildOfferCollection({
    ...tripRequest(requirement),
    anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }],
    offerSearchCriteria: { travelClasses: ['FIRST', 'SECOND'] },
  }, gamma, Date.parse('2026-11-02T09:00:00Z'));
  const [trip] = response.trips;
  const upgraded = response.offers.filter((o) => o.products.some((p) => p.type === 'UPGRADE_POINT2POINT')
    && o.offerSummary.overallFlexibility === perLeg[0].desiredFlexibility);
  assert.ok(upgraded.length > 0);
  const upgradePart = upgraded[0].admissionOfferParts.find((p) => p.summaryProductId.includes('-UPG-'));
  assert.deepEqual(upgradePart.tripCoverage.coveredLegIds, [trip.legs[0].id]);
});

test('the reservation scenarios: one per form, on a SuperCity (mandatory) then a EuroCity (optional) (#601)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const booked = datafile.scenarios.filter((s) => s.code.startsWith('SIM_SALE_RESERVATION_'));
  assert.deepEqual(booked.map((s) => s.reservationBookingForm ?? null), [null, 'RESERVATION_SELECTION', 'PLACE_SELECTION', 'ADD_LATER']);
  for (const scenario of booked) {
    const requirement = datafile.tripRequirements.find((t) => t.id === scenario.tripRequirementId);
    assert.deepEqual(requirement.legs.map((l) => gamma.reservations[l.productCategoryShortName]), ['MANDATORY', 'OPTIONAL'], scenario.code);
  }
  const { response } = buildOfferCollection({
    ...tripRequest(datafile.tripRequirements.find((t) => t.id === booked[0].tripRequirementId)),
    anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }, { externalRef: '00002', type: 'PERSON' }],
  }, gamma, Date.parse('2026-11-02T09:00:00Z'));
  assert.ok(response.offers.every((o) => o.reservationOfferParts.length === 2));
  // #766 PR 5: the place choices made after the booking add the reservation later too.
  const afterBooking = ['SIM_SALE_NAMED_PLACE_ADD_LATER_2ADT_38', 'SIM_SALE_NEARBY_PLACE_ADD_LATER_2ADT_38', 'SIM_SALE_SEAT_PREFERENCES_ADD_LATER_2ADT_38',
    'SIM_SALE_NEARBY_PLACE_AUTO_ADD_LATER_2ADT_38'];
  for (const scenario of datafile.scenarios.filter((s) => !booked.includes(s))) {
    assert.equal(scenario.reservationBookingForm, afterBooking.includes(scenario.code) ? 'ADD_LATER' : undefined, scenario.code);
  }
});

test('the trip id scenarios: the train named is a later departure of POST /trips-collection than the time asked (#602)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const byId = datafile.scenarios.filter((s) => s.code.startsWith('SIM_SALE_BY_TRIP_ID_'));
  assert.deepEqual(byId.map((s) => [s.offersByTripIds ?? null, s.tripIdsExpectRejection ?? null]), [['on', null], ['on', null], [null, 'on']]);
  const named = datafile.tripRequirements.find((t) => t.id === byId[1].tripRequirementId);
  const { trips } = buildTripCollection(tripRequest(named).tripSearchCriteria, gamma);
  const numbers = trips.map((t) => t.legs[0].timedLeg.service.vehicleNumbers[0]);
  // Third in the answer: neither the first trip nor the one at the time asked.
  assert.equal(numbers.indexOf(named.trip.vehicleNumber), 2);
  for (const scenario of byId) {
    assert.equal(datafile.tripRequirements.find((t) => t.id === scenario.tripRequirementId).tripType, 'SEARCH', scenario.code);
  }
});

test('the scenario catalogue names every scenario of the data file, and no other', () => {
  const fs = require('node:fs');
  const catalogue = fs.readFileSync(path.join(__dirname, '..', '..', 'Documentation', 'Server_Operations', 'OSCAR - OSDM Simulator scenarios.md'), 'utf8');
  // A row of the catalogue starts with the scenario's code.
  const rows = [...catalogue.matchAll(/^\| `(SIM_[A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  const codes = datafile.scenarios.map((s) => s.code);
  assert.deepEqual([...rows].sort(), [...codes].sort());
  assert.equal(new Set(rows).size, rows.length, 'a scenario has two rows');
});

test('the document scenarios: a return asking both media, and its refund awaiting the receipt (#603)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const documented = datafile.scenarios.filter((s) => s.requestedFulfillmentOptionsListId === 2);
  assert.deepEqual(documented.map((s) => s.code), ['SIM_SALE_DOCUMENTS_RETURN_1ADT_38', 'SIM_REFUND_RECEIPT_RETURN_1ADT_38', 'SIM_REFUND_COMBINED_RECEIPT_1ADT_38']);
  const media = datafile.requestedFulfillmentOptionsList.find((l) => l.id === 2).requestedFulfillmentOptions.map((o) => o.fulfillmentMedia);
  assert.deepEqual(media, gamma.documents);
  for (const scenario of documented) assert.notEqual(scenario.offerSearchCriteria.returnOffsetDays, null, `${scenario.code}: two tickets, so a merged PDF`);
  const awaiting = datafile.scenarios.filter((s) => s.refundReceiptMaxWaitMinutes != null);
  assert.deepEqual(awaiting.map((s) => s.code), ['SIM_REFUND_RECEIPT_RETURN_1ADT_38', 'SIM_REFUND_COMBINED_RECEIPT_1ADT_38']);
  // The receipt comes well within the wait.
  for (const scenario of awaiting) assert.ok(gamma.refundReceiptDelaySeconds < scenario.refundReceiptMaxWaitMinutes * 60, scenario.code);
});

test('the sales-horizon scenarios: the only ones on gamma\'s horizon stop place, at its last day, the day after and yesterday (#704)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const from = gamma.salesHorizon.from;
  const origins = (t) => (t.trip ? [t.trip.origin] : (t.legs || []).map((l) => l.origin));
  const trips = datafile.tripRequirements.filter((t) => origins(t).includes(from)).map((t) => t.id);
  assert.deepEqual(trips, [12]);
  const dated = datafile.scenarios.filter((s) => s.departureDaysFromToday !== undefined);
  assert.deepEqual(dated.map((s) => [s.code, s.tripRequirementId, s.departureDaysFromToday, s.departureExpectRejection]), [
    ['SIM_SALE_AT_SALES_HORIZON_38', 12, gamma.salesHorizon.days, undefined],
    ['SIM_NHF_BEYOND_SALES_HORIZON_38', 12, gamma.salesHorizon.days + 1, 'on'],
    ['SIM_NHF_DEPARTURE_IN_PAST_38', 12, -1, 'on'],
  ]);
  assert.deepEqual(datafile.scenarios.filter((s) => s.tripRequirementId === 12).map((s) => s.code), dated.map((s) => s.code));
});

test('the age scenario: the only one on gamma\'s age-tariff stop place, three passengers on the edges of its bands (#705)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const { from, bands } = gamma.ageTariffs;
  const origins = (t) => (t.trip ? [t.trip.origin] : (t.legs || []).map((l) => l.origin));
  assert.deepEqual(datafile.tripRequirements.filter((t) => origins(t).includes(from)).map((t) => t.id), [13]);
  assert.deepEqual(datafile.scenarios.filter((s) => s.tripRequirementId === 13).map((s) => [s.code, s.passengersListId]), [['SIM_SALE_AGE_LIMITS_38', 22]]);
  const aged = datafile.passengersList.filter((l) => l.passengers.some((p) => p.bornYearsBeforeTravel !== undefined)).map((l) => l.id);
  // #903: the free child of the fare scenario is aged too (3 on the day of travel).
  assert.deepEqual(aged, [22, 29]);
  const child = bands.find((b) => b.type === 'CHILD');
  const youth = bands.find((b) => b.type === 'YOUTH');
  const list = datafile.passengersList.find((l) => l.id === 22).passengers;
  assert.deepEqual(list.map((p) => [p.bornYearsBeforeTravel, p.bornDaysAfter, p.expectedPassengerType]), [
    [child.maxAge + 1, 1, 'CHILD'],
    [child.maxAge + 1, undefined, 'YOUTH'],
    [youth.maxAge + 1, undefined, 'ADULT'],
  ]);
  // Not updated: the date of birth worked out at the run stays the one booked.
  for (const p of list) assert.equal(p.updateDateOfBirth, undefined);
});

test('the seat preference scenarios: the only ones on gamma\'s preference stop place, on a train with a mandatory reservation, or an optional one added later (#766)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const trips = datafile.tripRequirements.filter((t) => (t.legs || [t.trip]).some((leg) => leg?.origin === gamma.placePreferences.from));
  assert.deepEqual(trips.map((t) => t.id), [15, 18]);
  assert.deepEqual(trips.map((t) => gamma.reservations[t.legs[0].productCategoryShortName]), ['MANDATORY', 'OPTIONAL']);
  const on = datafile.scenarios.filter((s) => s.tripRequirementId === 15);
  assert.deepEqual(on.map((s) => [s.code, s.placePreferences, s.placeSelectionFlow ?? null]), [
    ['SIM_SALE_SEAT_PREFERENCE_1ADT_38', ['WINDOW'], null],
    ['SIM_SALE_SEAT_PREFERENCES_FLOW_2ADT_38', ['WINDOW', 'TABLE', 'UPPER_DECK'], 'AUTOMATIC_PLACE_SELECTION_PREFERENCES'],
    ['SIM_VARIANT_IGNORES_PREFERENCES_1ADT_38', ['WINDOW'], null],
  ]);
  // What each shows: WINDOW offered and left, TABLE offered and sold out, UPPER_DECK not offered.
  const offered = gamma.placePreferences.groups.flatMap((g) => g.preferences);
  assert.ok(offered.includes('WINDOW') && !gamma.placePreferences.soldOut.includes('WINDOW'));
  assert.ok(offered.includes('TABLE') && gamma.placePreferences.soldOut.includes('TABLE'));
  assert.ok(!offered.includes('UPPER_DECK'));
  // #766 PR 5: the optional reservation added after the booking, with a preference.
  const later = datafile.scenarios.filter((s) => s.tripRequirementId === 18);
  assert.deepEqual(later.map((s) => [s.code, s.reservationBookingForm, s.placePreferences, s.placeSelectionFlow]), [
    ['SIM_SALE_SEAT_PREFERENCES_ADD_LATER_2ADT_38', 'ADD_LATER', ['WINDOW'], 'AUTOMATIC_PLACE_SELECTION_PREFERENCES'],
  ]);
  assert.deepEqual(datafile.scenarios.filter((s) => s.placePreferences != null).map((s) => s.code), [...on, ...later].map((s) => s.code));
});

test('the named place scenarios: the only ones on gamma\'s place map stop place, on a train with a mandatory reservation, or an optional one added later (#766)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const trips = datafile.tripRequirements.filter((t) => (t.legs || [t.trip]).some((leg) => leg?.origin === gamma.placeMap.from));
  assert.deepEqual(trips.map((t) => t.id), [16, 17]);
  assert.deepEqual(trips.map((t) => gamma.reservations[t.legs[0].productCategoryShortName]), ['MANDATORY', 'OPTIONAL']);
  assert.deepEqual(datafile.scenarios.filter((s) => s.tripRequirementId === 17).map((s) => [s.code, s.reservationBookingForm, s.placeSelectionFlow]), [
    ['SIM_SALE_NAMED_PLACE_ADD_LATER_2ADT_38', 'ADD_LATER', 'MANUAL_PLACE_SELECTION_WITHOUT_FEE'],
    ['SIM_SALE_NEARBY_PLACE_ADD_LATER_2ADT_38', 'ADD_LATER', 'AUTOMATIC_PLACE_SELECTION_NEARBY'],
    ['SIM_SALE_NEARBY_PLACE_AUTO_ADD_LATER_2ADT_38', 'ADD_LATER', 'AUTOMATIC_PLACE_SELECTION_NEARBY'],
  ]);
  const on = datafile.scenarios.filter((s) => s.tripRequirementId === 16);
  assert.deepEqual(on.map((s) => [s.code, s.placeSelectionFlow, s.namedPlaceKind ?? null]), [
    ['SIM_SALE_NAMED_PLACE_2ADT_38', 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', null],
    ['SIM_SALE_NAMED_PLACE_FEE_1ADT_38', 'MANUAL_PLACE_SELECTION_WITH_FEE', null],
    ['SIM_SALE_NAMED_COMPARTMENT_2ADT_38', 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'COMPARTMENT'],
    ['SIM_WRONG_NAMED_PLACE_38', 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', null],
    ['SIM_SALE_NEARBY_PLACE_2ADT_38', 'AUTOMATIC_PLACE_SELECTION_NEARBY', null],
    ['SIM_VARIANT_IGNORES_REFERENCE_1ADT_38', 'AUTOMATIC_PLACE_SELECTION_NEARBY', null],
    ['SIM_SALE_NEARBY_PLACE_AUTO_2ADT_38', 'AUTOMATIC_PLACE_SELECTION_NEARBY', null],
    ['SIM_SALE_NEARBY_PLACE_AUTO_1ADT_38', 'AUTOMATIC_PLACE_SELECTION_NEARBY', null],
  ]);
  // #776: the reference place of the AUTO scenarios comes from a first booking.
  assert.deepEqual(datafile.scenarios.filter((s) => s.referencePlace === 'AUTO').map((s) => s.code),
    ['SIM_SALE_NEARBY_PLACE_AUTO_2ADT_38', 'SIM_SALE_NEARBY_PLACE_AUTO_1ADT_38', 'SIM_SALE_NEARBY_PLACE_AUTO_ADD_LATER_2ADT_38']);
});

test('the fault scenarios: one per fault of the catalogue, out of the run list (#833)', () => {
  const { catalogue } = require('../src/osdm/faults');
  const faulty = datafile.scenarios.filter((s) => s.simulatorFaults != null);
  assert.ok(faulty.every((s) => s.code.startsWith('SIM_FAULT_') && s.osdmVersion === '3.8.0'));
  assert.deepEqual(faulty.map((s) => s.simulatorFaults).sort(), catalogue().map((f) => [f.code]).sort());
  for (const scenario of faulty) {
    const code = `SIM_FAULT_${scenario.simulatorFaults[0].replace('.', '_').replaceAll('-', '_').toUpperCase()}_38`;
    assert.equal(scenario.code, code);
    assert.ok(!datafile.scenariosToRun.includes(scenario.code), scenario.code);
  }
});

test('the fare scenarios: a section inside the trip; each wrong one starts its section, or its trip, at the station of its variant (#903, #904, #905)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const v = gamma.fares.variants;
  const fareScenarios = datafile.scenarios.filter((s) => s.code.includes('_FARE_'));
  const startOf = (s) => s.requestedSections?.[0]?.startPlace;
  const tripOf = (s) => datafile.tripRequirements.find((t) => t.id === s.tripRequirementId);
  // Per scenario: the section's start, the trip's type, isPartOfInternationalTrip,
  // whether FARE_ADMISSION is asked, and expectFares. By search criteria and by
  // trip id (#904) the trip is a SEARCH, which carries no international flag.
  // The negative requests (#905) expect no fare: N1 asks for ADMISSION only, N2
  // names no section (by search, going on to a product sale, #207; on a
  // specification sent as domestic), N4 sends an empty list.
  const expected = {
    SIM_FARE_SPEC_1ADT_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    SIM_FARE_SPEC_FREE_CHILD_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    SIM_FARE_SRCH_1ADT_38: ['urn:uic:stn:0000001', 'SEARCH', undefined, true, undefined],
    SIM_FARE_TRIPIDS_1ADT_38: ['urn:uic:stn:0000001', 'SEARCH', undefined, true, undefined],
    SIM_WRONG_FARE_PASSENGER_WITHOUT_FARE_38: [v.passengerWithoutFare, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_UNKNOWN_CLUSTER_38: [v.unknownCluster, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_WIDER_CLUSTERS_38: [v.widerClusters, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_SECTION_GAP_38: [v.sectionGap, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_OVERLAP_38: [v.overlappingFares, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_UNREQUESTED_38: [v.unrequestedFares, 'SPECIFICATION', true, false, undefined],
    SIM_NHF_FARE_UNASKED_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, false, false],
    SIM_NHF_FARE_NO_SECTION_SRCH_38: [undefined, 'SEARCH', undefined, true, false],
    SIM_NHF_FARE_NO_SECTION_SPEC_38: [undefined, 'SPECIFICATION', false, true, false],
    SIM_NHF_FARE_EMPTY_SECTIONS_38: [undefined, 'SPECIFICATION', true, true, false],
    SIM_WRONG_FARE_WITHOUT_SECTION_38: [undefined, 'SPECIFICATION', false, true, false],
    // #906: the fare sale of SIM_FARE_SPEC_1ADT_38, its fulfilment wrong.
    SIM_WRONG_FARE_FULFILLMENT_DOCUMENT_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_NOT_IN_FULFILLMENT_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    // #907: refunds of fare sales; COMBINING fares from their own station.
    SIM_FARE_REFUND_1ADT_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    SIM_FARE_REFUND_FEE_1ADT_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
    SIM_FARE_REFUND_COMBINING_1ADT_38: [v.combiningFares, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_COMBINING_FEE_38: [v.combiningFares, 'SPECIFICATION', true, true, undefined],
    SIM_WRONG_FARE_IGNORES_REFUND_FEE_38: ['urn:uic:stn:0000004', 'SPECIFICATION', true, true, undefined],
  };
  const found = Object.fromEntries(fareScenarios.map((s) => [s.code, [
    startOf(s), tripOf(s).tripType, s.isPartOfInternationalTrip, s.offerSearchCriteria.requestedOfferParts.includes('FARE_ADMISSION'), s.expectFares,
  ]]));
  assert.deepEqual(found, expected);
  for (const s of fareScenarios) {
    assert.equal(s.offersByTripIds === 'on', s.code === 'SIM_FARE_TRIPIDS_1ADT_38', s.code);
    if (!startOf(s)) continue;
    // The section lies inside the trip: its start and end are stations of it.
    const trip = tripOf(s);
    const stations = trip.tripType === 'SEARCH' ? [trip.trip.origin, trip.trip.destination] : trip.legs.flatMap((l) => [l.origin, l.destination]);
    assert.ok(stations.includes(startOf(s)) && stations.includes(s.requestedSections[0].endPlace), s.code);
  }
  // #905: the empty list is N4's only, a product booked N2's by search only,
  // and no scenario but a fare one says what fares it expects.
  const emptyLists = datafile.scenarios.filter((s) => Array.isArray(s.requestedSections) && s.requestedSections.length === 0);
  assert.deepEqual(emptyLists.map((s) => s.code), ['SIM_NHF_FARE_EMPTY_SECTIONS_38']);
  assert.deepEqual(datafile.scenarios.filter((s) => s.bookMode === 'PRODUCT').map((s) => s.code), ['SIM_NHF_FARE_NO_SECTION_SRCH_38']);
  for (const s of datafile.scenarios.filter((x) => !x.code.includes('_FARE_'))) assert.equal(s.expectFares, undefined, s.code);
  // No other scenario starts a section at a variant station; the COMBINING
  // one (#907) is not wrong, and its two scenarios alone start there.
  const variantStations = new Set(Object.values(v));
  for (const s of datafile.scenarios.filter((x) => !x.code.startsWith('SIM_WRONG_FARE_') && startOf(x) !== v.combiningFares)) {
    assert.ok(!variantStations.has(startOf(s)), s.code);
  }
  assert.deepEqual(datafile.scenarios.filter((s) => startOf(s) === v.combiningFares).map((s) => s.code), ['SIM_FARE_REFUND_COMBINING_1ADT_38', 'SIM_WRONG_FARE_COMBINING_FEE_38']);
  // #907: the fee stated is a fare refund's, and in a REFUND scenario.
  assert.deepEqual(datafile.scenarios.filter((s) => s.fareRefundFee != null).map((s) => [s.code, s.scenarioType, s.fareRefundFee]),
    [['SIM_FARE_REFUND_FEE_1ADT_38', 'REFUND', 250], ['SIM_WRONG_FARE_IGNORES_REFUND_FEE_38', 'REFUND', 250]]);
  // #905: the trip from the "fares without section" station is the wrong scenario's only.
  const originOf = (t) => (t.trip ? t.trip.origin : t.legs?.[0]?.origin);
  const fromVariant = datafile.tripRequirements.filter((t) => originOf(t) === v.faresWithoutSection).map((t) => t.id);
  assert.deepEqual(datafile.scenarios.filter((s) => fromVariant.includes(s.tripRequirementId)).map((s) => s.code), ['SIM_WRONG_FARE_WITHOUT_SECTION_38']);
});
