// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #903: fare offers for a requested section, and their wrong variants.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError } = require('../src/http');
const { buildOfferCollection } = require('../src/osdm/offers');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { loadAllProviders, checkConformance } = require('./helpers');

const providers = loadAllProviders();
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const ADULT = { externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' };
const CHILD = { externalRef: '00002', type: 'PERSON', dateOfBirth: '2023-03-01' };

// A fare request on a trip specification, as the collection sends it.
function fareRequest({ start = '0000001', parts = ['FARE_ADMISSION'], passengers = [ADULT], sections } = {}) {
  return {
    tripSpecifications: [{
      isPartOfInternationalTrip: true,
      legs: [{
        timedLeg: {
          start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
          end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
          service: { vehicleNumbers: ['1001'] },
        },
      }],
    }],
    requestedSections: sections ?? [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: parts ? { requestedOfferParts: parts } : undefined,
    anonymousPassengerSpecifications: passengers,
  };
}

const build = (request, provider = 'gamma') => buildOfferCollection(request, providers.get(provider), NOW).response;
const fareOffers = (response) => response.offers.filter((o) => Array.isArray(o.fares));

test('FARE_ADMISSION with a section: one fare offer per cluster, next to the product offers, in OSDM 3.8 shapes', () => {
  const response = build(fareRequest());
  const fares = fareOffers(response);
  assert.equal(fares.length, 3);
  assert.ok(response.offers.length > fares.length, 'the product offers stay');
  assert.deepEqual(fares.map((o) => o.fares[0].combinationConstraint[0].referenceCluster), ['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX']);
  for (const offer of fares) {
    assert.equal(offer.offerSummary, undefined, 'no offer summary for fares');
    assert.equal(offer.admissionOfferParts, undefined);
    const [fare] = offer.fares;
    assert.equal(fare.type, 'ADMISSION');
    assert.deepEqual(fare.passengerRefs, ['00001']);
    assert.deepEqual(fare.coveredSection.startPlace, station('0000001'));
    assert.deepEqual(fare.coveredSection.endPlace, station('0000002'));
    assert.ok(fare.regionalConstraint.regionalValidities[0].route.routeSummary);
    assert.equal(fare.regionalConstraint.entryConnectionPoint.stationSets[0].stations[0].stopPlaceRef, 'urn:uic:stn:0000001');
    assert.ok(fare.afterSalesCondition.conditions.length > 0);
    assert.equal(fare.travelValidityConstraint.validTravelDates.from.slice(0, 10), '2026-11-20');
    assert.deepEqual(fare.involvedTCOs, [providers.get('gamma').carrier.ref]);
  }
  const amounts = fares.map((o) => o.fares[0].prices[0].amount);
  assert.ok(amounts[0] > amounts[1] && amounts[1] > amounts[2], 'flexible fares cost more');
  assert.equal(response.problems, undefined, 'FARE_ADMISSION is not reported as ignored');
  checkConformance('POST', '/gamma/offers', 200, response);
});

test('allowed clusters are the reference cluster and the less flexible ones', () => {
  const allowed = fareOffers(build(fareRequest())).map((o) => o.fares[0].combinationConstraint[0].allowedClusters);
  assert.deepEqual(allowed, [['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX'], ['SEMI_FLEX', 'NON_FLEX'], ['NON_FLEX']]);
});

test('a child under the free age gets a fare priced 0; each passenger has a fare', () => {
  for (const offer of fareOffers(build(fareRequest({ passengers: [ADULT, CHILD] })))) {
    assert.deepEqual(offer.fares.map((f) => f.passengerRefs[0]), ['00001', '00002']);
    assert.ok(offer.fares[0].prices[0].amount > 0);
    assert.equal(offer.fares[1].prices[0].amount, 0);
  }
});

test('no fare without FARE_* asked, or without a section; ALL asks for them', () => {
  assert.equal(fareOffers(build(fareRequest({ parts: ['ADMISSION'] }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ parts: null }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ sections: [] }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ parts: ['ALL'] }))).length, 3);
  // Without fares, FARE_ADMISSION alone is still reported as ignored.
  const none = build(fareRequest({ sections: [] }));
  assert.ok(none.problems.some((p) => p.code === 'PARAMETER_NOT_SUPPORTED'));
});

test('a provider without fares in its profile offers none', () => {
  assert.equal(fareOffers(build(fareRequest(), 'plain')).length, 0);
});

test('every provider answers fares in the shapes of its own OSDM version', () => {
  for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
    const provider = providers.get(key);
    const response = shapeAnswer(build(fareRequest(), key), provider.osdmVersion);
    assert.equal(fareOffers(response).length, 3, key);
    checkConformance('POST', `/${key}/offers`, 200, response);
  }
});

test('a section or flag that is not valid is refused', () => {
  const refused = (request, pattern) => assert.throws(() => build(request), (e) => e instanceof HttpError && e.status === 400 && pattern.test(e.detail));
  refused(fareRequest({ sections: [{ startPlace: station('0000001') }] }), /requestedSections\[0\]\.endPlace/);
  refused(fareRequest({ sections: [{ startPlace: station('0000002'), endPlace: station('0000002') }] }), /starts where it ends/);
  const flag = fareRequest();
  flag.tripSpecifications[0].isPartOfInternationalTrip = 'yes';
  refused(flag, /isPartOfInternationalTrip/);
});

test('the wrong variants, chosen by the section start station, each break one rule', () => {
  const variant = (start, options = {}) => fareOffers(build(fareRequest({ start, ...options })));
  const two = { passengers: [ADULT, { ...ADULT, externalRef: '00002' }] };
  // A passenger without a fare.
  for (const offer of variant('0000080', two)) assert.deepEqual(offer.fares.map((f) => f.passengerRefs[0]), ['00001']);
  // A cluster outside the list.
  for (const offer of variant('0000081')) assert.equal(offer.fares[0].combinationConstraint[0].referenceCluster, 'GOLD');
  // Allowed clusters wider than the reference one.
  const wider = variant('0000082');
  assert.ok(wider.at(-1).fares[0].combinationConstraint[0].allowedClusters.includes('BUSINESS'));
  // A gap: the fare stops before the end of the section.
  for (const offer of variant('0000083')) assert.equal(offer.fares[0].coveredSection.endPlace.stopPlaceRef, 'urn:uic:stn:0000079');
  // An overlap: two fares for the passenger over the start of the section.
  for (const offer of variant('0000084')) assert.equal(offer.fares.length, 2);
  // Fares that were not asked.
  assert.equal(variant('0000085', { parts: ['ADMISSION'] }).length, 3);
  // Each variant answer is still OSDM-shaped.
  for (const start of ['0000080', '0000081', '0000082', '0000083', '0000084']) checkConformance('POST', '/gamma/offers', 200, build(fareRequest({ start })));
});

// #905: a request naming no section gets no fare, except on a trip from the
// `faresWithoutSection` station, where gamma prices the whole trip all the same.
test('without a section, fares only on a trip from the faresWithoutSection station, for the whole trip', () => {
  const fromVariant = ({ sections, parts } = {}) => {
    const req = fareRequest({ sections, parts });
    req.tripSpecifications[0].legs[0].timedLeg.start.stopPlaceRef = station('0000086');
    if (sections === undefined) delete req.requestedSections;
    return req;
  };
  for (const req of [fromVariant(), fromVariant({ sections: [] })]) {
    const offers = fareOffers(build(req));
    assert.equal(offers.length, 3);
    for (const offer of offers) {
      assert.deepEqual(offer.fares.map((f) => [f.coveredSection.startPlace.stopPlaceRef, f.coveredSection.endPlace.stopPlaceRef]),
        [['urn:uic:stn:0000086', 'urn:uic:stn:0000002']]);
    }
    checkConformance('POST', '/gamma/offers', 200, build(req));
  }
  // Not asked, no fare; and from any other station, no section gives none.
  assert.equal(fareOffers(build(fromVariant({ parts: ['ADMISSION'] }))).length, 0);
  const elsewhere = fareRequest();
  delete elsewhere.requestedSections;
  assert.equal(fareOffers(build(elsewhere)).length, 0);
  // A section from that station is priced as asked, as any other.
  assert.equal(fareOffers(build(fromVariant({ sections: [{ startPlace: station('0000086'), endPlace: station('0000002') }] }))).length, 3);
});

// #904: the fares follow the section whichever way the trip is given.
test('fares by search criteria and by trip id, over HTTP', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call, offerRequest } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const section = { startPlace: station('0000001'), endPlace: station('0000002') };
  const asked = { requestedSections: [section], offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] } };
  const bySearch = await call(sim.base, token, 'POST', '/gamma/offers', offerRequest(asked));
  assert.equal(bySearch.status, 200);
  assert.equal(fareOffers(bySearch.body).length, 3);
  for (const offer of fareOffers(bySearch.body)) assert.deepEqual(offer.fares[0].coveredSection, section);

  const { trips } = (await call(sim.base, token, 'POST', '/gamma/trips-collection', offerRequest().tripSearchCriteria)).body;
  const byId = offerRequest({ ...asked, tripIds: [trips[1].id] });
  delete byId.tripSearchCriteria;
  const res = await call(sim.base, token, 'POST', '/gamma/offers', byId);
  assert.equal(res.status, 200);
  assert.equal(fareOffers(res.body).length, 3);
  assert.equal(fareOffers(res.body)[0].fares[0].travelValidityConstraint.validTravelDates.from.slice(0, 10), trips[1].startTime.slice(0, 10));
});
