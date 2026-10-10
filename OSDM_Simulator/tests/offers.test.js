// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../src/config');
const { HttpError } = require('../src/http');
const { buildOfferCollection } = require('../src/osdm/offers');
const { PROVIDERS_DIR, offerRequest } = require('./helpers');

const providers = loadProviders(PROVIDERS_DIR);
const NOW = Date.parse('2026-11-02T09:00:00Z');
const build = (request, provider = 'alpha') => buildOfferCollection(request, providers.get(provider), NOW).response;

const refused = (request, pattern) => assert.throws(() => build(request), (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 400);
  assert.match(error.detail, pattern);
  return true;
});

test('the same request gives the same trip and the same prices', () => {
  const first = build(offerRequest());
  const second = build(offerRequest());
  assert.deepEqual(first.trips, second.trips);
  assert.deepEqual(first.offers.map((o) => o.offerSummary), second.offers.map((o) => o.offerSummary));
  assert.notEqual(first.offers[0].offerId, second.offers[0].offerId);
});

test('another origin or destination gives another trip', () => {
  const there = build(offerRequest()).trips[0];
  const request = offerRequest();
  request.tripSearchCriteria.destination.stopPlaceRef = 'urn:uic:stn:0000003';
  const elsewhere = build(request).trips[0];
  assert.notEqual(there.id, elsewhere.id);
  assert.equal(elsewhere.destinationName, 'Station 0000003');
});

test('one direct trip, three offers from flexible to saver, one admission per passenger', () => {
  const request = offerRequest({
    anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON', dateOfBirth: '2001-02-03' }],
  });
  const response = build(request);
  assert.equal(response.trips.length, 1);
  const [trip] = response.trips;
  assert.equal(trip.legs.length, 1);
  assert.equal(trip.transfers, 0);
  assert.equal(trip.direction, 'OUT_BOUND');
  assert.match(trip.duration, /^PT(\d+H)?(\d+M)?$/);
  assert.ok(Date.parse(trip.endTime) > Date.parse(trip.startTime));
  assert.deepEqual(response.anonymousPassengerSpecifications, [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON', dateOfBirth: '2001-02-03' }]);
  assert.deepEqual(response.offers.map((o) => o.offerSummary.overallFlexibility), ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE']);
  const amounts = response.offers.map((o) => o.offerSummary.minimalPrice.amount);
  assert.ok(amounts[0] > amounts[1] && amounts[1] > amounts[2]);
  for (const offer of response.offers) {
    assert.deepEqual(offer.passengerRefs, ['P1', 'P2']);
    assert.deepEqual(offer.admissionOfferParts.map((p) => p.passengerRefs), [['P1'], ['P2']]);
    assert.equal(offer.admissionOfferParts.reduce((sum, p) => sum + p.price.amount, 0), offer.offerSummary.minimalPrice.amount);
    assert.equal(offer.tripCoverage.coveredTripId, trip.id);
    assert.deepEqual(offer.tripCoverage.coveredLegIds, [trip.legs[0].id]);
    assert.equal(offer.products[0].flexibility, offer.offerSummary.overallFlexibility);
    assert.equal(offer.admissionOfferParts[0].products[0].productId, offer.products[0].id);
    assert.equal(Date.parse(offer.preBookableUntil) - Date.parse(offer.createdOn), 30 * 60 * 1000);
  }
});

test('a local time is read in the provider\'s offset; an offset given is kept', () => {
  assert.equal(build(offerRequest(), 'alpha').trips[0].startTime, '2026-11-20T08:00:00+01:00');
  assert.equal(build(offerRequest(), 'gamma').trips[0].startTime, '2026-11-20T08:00:00+02:00');
  const request = offerRequest();
  request.tripSearchCriteria.departureTime = '2026-11-20T08:00:00-05:00';
  const trip = build(request).trips[0];
  assert.equal(trip.startTime, '2026-11-20T08:00:00-05:00');
  assert.match(trip.endTime, /-05:00$/);
  request.tripSearchCriteria.departureTime = '2026-11-20T08:00:00Z';
  assert.equal(build(request).trips[0].startTime, '2026-11-20T08:00:00Z');
});

test('a search by arrival time ends the trip at that time', () => {
  const request = offerRequest();
  delete request.tripSearchCriteria.departureTime;
  request.tripSearchCriteria.arrivalTime = '2026-11-20T18:00:00+01:00';
  const trip = build(request).trips[0];
  assert.equal(trip.endTime, '2026-11-20T18:00:00+01:00');
  assert.ok(Date.parse(trip.startTime) < Date.parse(trip.endTime));
});

test('a train number asked for in the search is the one the trip carries', () => {
  const request = offerRequest();
  request.tripSearchCriteria.parameters = { dataFilter: { vehicleFilter: { vehicleNumbers: ['9241'], exclude: false } } };
  assert.deepEqual(build(request).trips[0].legs[0].timedLeg.service.vehicleNumbers, ['9241']);
  request.tripSearchCriteria.parameters.dataFilter.vehicleFilter.exclude = true;
  assert.notDeepEqual(build(request).trips[0].legs[0].timedLeg.service.vehicleNumbers, ['9241']);
});

test('the criteria narrow the offers; values the simulator does not know are ignored', () => {
  const flexible = build(offerRequest({ offerSearchCriteria: { flexibilities: ['NON_FLEXIBLE', 'UNKNOWN'] } }));
  assert.deepEqual(flexible.offers.map((o) => o.offerSummary.overallFlexibility), ['NON_FLEXIBLE']);
  const first = build(offerRequest({ offerSearchCriteria: { travelClass: ['FIRST'] } }));
  assert.deepEqual([...new Set(first.offers.map((o) => o.offerSummary.overallTravelClass))], ['FIRST']);
  const second = build(offerRequest({ offerSearchCriteria: { travelClass: ['ANY_CLASS'], flexibilities: [] } }));
  assert.equal(second.offers.length, 3);
  assert.ok(first.offers[0].offerSummary.minimalPrice.amount > second.offers[0].offerSummary.minimalPrice.amount);
});

test('the fulfilment options asked for are the ones offered; PDF e-ticket otherwise', () => {
  const asked = build(offerRequest({ requestedFulfillmentOptions: [{ type: 'ETICKET', media: 'PKPASS' }, { type: 5 }, null] }));
  assert.deepEqual(asked.offers[0].admissionOfferParts[0].availableFulfillmentOptions, [{ type: 'ETICKET', media: 'PKPASS' }]);
  assert.deepEqual(build(offerRequest()).offers[0].admissionOfferParts[0].availableFulfillmentOptions, [{ type: 'ETICKET', media: 'PDF_A4' }]);
});

test('a specified trip is answered leg for leg, served by the provider', () => {
  const leg = (from, to, start, end, number) => ({
    externalRef: `leg-${number}`,
    timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: from }, serviceDeparture: { timetabledTime: start } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: to }, serviceArrival: { timetabledTime: end } },
      service: { vehicleNumbers: [number], carriers: [{ ref: 'urn:uic:rics:9999' }] },
    },
  });
  const request = offerRequest({
    tripSpecifications: [{
      externalRef: 'trip-ref',
      legs: [
        leg('urn:uic:stn:0000001', 'urn:uic:stn:0000002', '2026-11-20T08:00:00+01:00', '2026-11-20T09:00:00+01:00', '101'),
        leg('urn:uic:stn:0000002', 'urn:uic:stn:0000003', '2026-11-20T09:20:00+01:00', '2026-11-20T10:35:00+01:00', '202'),
      ],
    }],
  });
  delete request.tripSearchCriteria;
  const response = build(request, 'beta');
  const [trip] = response.trips;
  assert.equal(trip.externalRef, 'trip-ref');
  assert.equal(trip.transfers, 1);
  assert.equal(trip.duration, 'PT2H35M');
  assert.deepEqual(trip.legs.map((l) => l.timedLeg.service.vehicleNumbers[0]), ['101', '202']);
  assert.deepEqual(trip.legs.map((l) => l.timedLeg.service.carriers[0].ref), new Array(2).fill('urn:x_osdm_simulator:carrier:beta'));
  assert.deepEqual(response.offers[0].tripCoverage.coveredLegIds, trip.legs.map((l) => l.id));
});

test('a request the simulator cannot serve is a 400 that says which part', () => {
  const without = (path) => {
    const request = offerRequest();
    let target = request;
    for (const key of path.slice(0, -1)) target = target[key];
    delete target[path.at(-1)];
    return request;
  };
  refused({}, /tripSearchCriteria or tripSpecifications/);
  refused(offerRequest({ tripSearchCriteria: 'x' }), /tripSearchCriteria is not valid/);
  refused(without(['tripSearchCriteria', 'origin']), /origin/);
  refused(without(['tripSearchCriteria', 'departureTime']), /arrivalTime/);
  refused(offerRequest({ tripSearchCriteria: { ...offerRequest().tripSearchCriteria, departureTime: 'tomorrow' } }), /departureTime/);
  refused(offerRequest({ tripSearchCriteria: { ...offerRequest().tripSearchCriteria, departureTime: '2026-13-45T08:00:00' } }), /departureTime/);
  refused(offerRequest({ tripSearchCriteria: { ...offerRequest().tripSearchCriteria, destination: { stopPlaceRef: 'x'.repeat(121) } } }), /destination/);
  refused(without(['anonymousPassengerSpecifications']), /1 to 9 passengers/);
  refused(offerRequest({ anonymousPassengerSpecifications: [] }), /1 to 9 passengers/);
  refused(offerRequest({ anonymousPassengerSpecifications: new Array(10).fill({ externalRef: 'x' }) }), /1 to 9 passengers/);
  refused(offerRequest({ anonymousPassengerSpecifications: [{ type: 'PERSON' }] }), /externalRef/);
  refused(offerRequest({ anonymousPassengerSpecifications: [{ externalRef: 'a' }, { externalRef: 'a' }] }), /appears twice/);
  refused(offerRequest({ tripSpecifications: new Array(5).fill({ legs: [] }) }), /at most 4/);
  refused(offerRequest({ tripSpecifications: [{ legs: [] }] }), /legs is not valid/);
  refused(offerRequest({ tripSpecifications: [{ legs: [{}] }] }), /timedLeg is not valid/);
});

test('a specified leg that ends before it starts is refused', () => {
  const request = offerRequest({
    tripSpecifications: [{
      legs: [{
        timedLeg: {
          start: { stopPlaceRef: { stopPlaceRef: 'urn:uic:stn:0000001' }, serviceDeparture: { timetabledTime: '2026-11-20T10:00:00+01:00' } },
          end: { stopPlaceRef: { stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T09:00:00+01:00' } },
        },
      }],
    }],
  });
  refused(request, /end after it starts/);
});

// ── reduction cards (#597) ────────────────────────────────────────────────

const card = (code) => ({ type: 'REDUCTION_CARD', code });
const withCards = (...cardLists) => offerRequest({
  anonymousPassengerSpecifications: cardLists.map((cards, i) => ({ externalRef: `P${i + 1}`, type: 'PERSON', ...(cards ? { cards } : {}) })),
});
const partOf = (offer, ref) => offer.admissionOfferParts.find((p) => p.passengerRefs[0] === ref);

test('a known card takes its reduction off the passenger\'s price and is named on the admission', () => {
  const plain = build(withCards(null, null), 'gamma');
  const carded = build(withCards([card('SIM_CARD_25')], null), 'gamma');
  plain.offers.forEach((offer, i) => {
    const full = partOf(offer, 'P1').price.amount;
    const reduced = partOf(carded.offers[i], 'P1');
    assert.equal(reduced.price.amount, Math.round(full * 0.75));
    assert.equal(partOf(carded.offers[i], 'P2').price.amount, partOf(offer, 'P2').price.amount, 'the other passenger pays the full fare');
    assert.equal(carded.offers[i].offerSummary.minimalPrice.amount, reduced.price.amount + partOf(offer, 'P2').price.amount);
    assert.deepEqual(reduced.appliedPassengerTypes, [{
      passengerRef: 'P1', type: 'ADULT', description: 'Adult with Simulator card 25',
      appliedReductionCardTypes: [{ code: 'SIM_CARD_25', issuer: 'urn:x_osdm_simulator:carrier:gamma', name: { id: 'SIM_CARD_25-NAME', text: 'Simulator card 25' } }],
      appliedReductions: [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_25', issuer: 'urn:x_osdm_simulator:carrier:gamma' }],
    }]);
    assert.equal(partOf(carded.offers[i], 'P2').appliedPassengerTypes, undefined);
  });
  assert.equal(carded.problems, undefined);
  assert.deepEqual(carded.anonymousPassengerSpecifications[0].cards, [card('SIM_CARD_25')]);
});

test('of several known cards the largest reduction applies; a card of another type is not a reduction', () => {
  const plain = partOf(build(withCards(null), 'gamma').offers[0], 'P1').price.amount;
  const best = partOf(build(withCards([card('SIM_CARD_25'), card('SIM_CARD_50')]), 'gamma').offers[0], 'P1');
  assert.equal(best.price.amount, Math.round(plain * 0.5));
  assert.equal(best.appliedPassengerTypes[0].appliedReductionCardTypes[0].code, 'SIM_CARD_50');
  const loyalty = build(withCards([{ type: 'LOYALTY_CARD', code: 'SIM_CARD_50', number: '123' }]), 'gamma');
  assert.equal(partOf(loyalty.offers[0], 'P1').price.amount, plain);
  assert.equal(loyalty.problems, undefined, 'only reduction cards are reported');
});

test('an unknown card is ignored with a Problem naming it; a provider with no card knows none', () => {
  const plain = partOf(build(withCards(null), 'gamma').offers[0], 'P1').price.amount;
  const unknown = build(withCards([card('NO_SUCH_CARD')]), 'gamma');
  assert.equal(partOf(unknown.offers[0], 'P1').price.amount, plain);
  assert.equal(partOf(unknown.offers[0], 'P1').appliedPassengerTypes, undefined);
  assert.deepEqual(unknown.problems.map((p) => p.code), ['REDUCTION_CARD_NOT_APPLIED']);
  assert.match(unknown.problems[0].detail, /Passenger P1: reduction card "NO_SUCH_CARD" is not known/);
  const alpha = build(withCards([card('SIM_CARD_25')]));
  assert.equal(alpha.problems.length, 1);
  assert.equal(partOf(alpha.offers[0], 'P1').appliedPassengerTypes, undefined);
});

test('cards that are not a list of typed cards are refused', () => {
  for (const cards of ['SIM_CARD_25', [{}], [{ type: 'REDUCTION_CARD', code: 7 }], Array.from({ length: 6 }, () => card('SIM_CARD_25'))]) {
    assert.throws(() => build(withCards(cards), 'gamma'), (error) => error instanceof HttpError && error.status === 400 && /cards/.test(error.detail), JSON.stringify(cards));
  }
});
