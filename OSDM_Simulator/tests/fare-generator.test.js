// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1048: the fare generator builds its fares from DB's templates (#1047),
// laid on the simulator's own stations.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfferCollection } = require('../src/osdm/offers');
const { clusterPrices, placesFor, CLUSTERS } = require('../src/osdm/fares');
const { fareTemplates } = require('../src/osdm/fareTemplates');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { loadAllProviders, checkConformance } = require('./helpers');

const providers = loadAllProviders();
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const adult = (n) => ({ externalRef: `a${n}`, type: 'PERSON', dateOfBirth: '1990-01-15' });
const CHILD = { externalRef: 'c1', type: 'PERSON', dateOfBirth: '2018-03-01' };
const YOUNG = { externalRef: 'y1', type: 'PERSON', dateOfBirth: '2023-03-01' };
const BICYCLE = { externalRef: 'b1', type: 'BICYCLE' };
const withCard = (p, code) => ({ ...p, cards: [{ type: 'REDUCTION_CARD', code }] });

// A fare request on a trip specification from `from` to `to`, by `via` when given.
function request({ from = '0000004', to = '0000002', via = null, passengers = [adult(1)], parts = ['FARE_ADMISSION'], classes = null, section = null } = {}) {
  const leg = (a, b, start, end) => ({
    timedLeg: {
      start: { stopPlaceRef: station(a), serviceDeparture: { timetabledTime: `2026-11-20T${start}:00+01:00` } },
      end: { stopPlaceRef: station(b), serviceArrival: { timetabledTime: `2026-11-20T${end}:00+01:00` } },
      service: { vehicleNumbers: ['1001'] },
    },
  });
  const legs = via ? [leg(from, via, '08:00', '09:00'), leg(via, to, '09:10', '11:00')] : [leg(from, to, '08:00', '11:00')];
  return {
    tripSpecifications: [{ isPartOfInternationalTrip: true, legs }],
    requestedSections: [section || { startPlace: station(from), endPlace: station(to) }],
    offerSearchCriteria: { requestedOfferParts: parts, ...(classes ? { travelClasses: classes } : {}) },
    anonymousPassengerSpecifications: passengers,
  };
}
const offersOf = (req, provider = 'gamma') => buildOfferCollection(req, providers.get(provider), NOW).response.offers.filter((o) => o.fares);
const amounts = (offer) => offer.fares.map((f) => f.prices[0].amount);
const file = fareTemplates();

test('cluster prices: NON_FLEX < SEMI_FLEX < FULL_FLEX < BUSINESS, PROMO lowest, a free fare free everywhere (F9)', () => {
  assert.deepEqual(clusterPrices(0), { BUSINESS: 0, FULL_FLEX: 0, SEMI_FLEX: 0, NON_FLEX: 0, PROMO: 0 });
  assert.deepEqual(clusterPrices(1000), { BUSINESS: 1250, FULL_FLEX: 1000, SEMI_FLEX: 800, NON_FLEX: 600, PROMO: 500 });
  let seed = 7;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const full = 4 + (seed % 3000000);
    const p = clusterPrices(full);
    const order = CLUSTERS.map((c) => p[c]);
    for (let j = 1; j < order.length; j++) assert.ok(order[j] < order[j - 1], `${full}: ${order}`);
    assert.ok(p.PROMO >= 0 && Number.isInteger(p.SEMI_FLEX) && Number.isInteger(p.NON_FLEX));
  }
});

test('every template fare keeps the order in the provider\'s currency, and first class stays dearer than second', () => {
  for (const key of ['alpha', 'gamma', 'zeta']) {
    const factor = providers.get(key).priceFactor;
    for (const t of file.templates) {
      for (const f of t.fares) {
        const p = clusterPrices(Math.round(f.price * factor));
        if (f.price > 0) assert.ok(p.NON_FLEX < p.SEMI_FLEX && p.SEMI_FLEX < p.FULL_FLEX, `${key} ${t.id}`);
        else assert.deepEqual([p.NON_FLEX, p.SEMI_FLEX, p.FULL_FLEX], [0, 0, 0]);
      }
    }
  }
  const second = offersOf(request());
  const first = offersOf(request({ classes: ['FIRST'] }));
  second.forEach((offer, i) => assert.ok(amounts(first[i])[0] > amounts(offer)[0], 'the same cluster costs more in first class'));
});

test('a section is priced on a template with a border where the provider has a border point, the same one each time', () => {
  const templateOf = (req) => offersOf(req)[0].fares[0].regionalConstraint;
  const border = templateOf(request());
  assert.equal(border.entryConnectionPoint.id, 'urn:x_osdm_simulator:border:804');
  assert.equal(border.exitConnectionPoint.id, 'urn:x_osdm_simulator:fcp:0000002');
  const plain = templateOf(request({ from: '0000001' }));
  assert.match(plain.entryConnectionPoint.id, /fcp:0000001$/);
  const transit = templateOf(request({ to: '0000070' }));
  assert.equal(transit.exitConnectionPoint.id, 'urn:x_osdm_simulator:border:870');
  assert.deepEqual(templateOf(request()), templateOf(request()), 'the same section, the same region');
  const distances = new Set(file.templates.filter((t) => t.entry.border && !t.exit.border).map((t) => t.distance));
  assert.ok(distances.has(border.distance));
});

test('the region is laid on the section: its ends on the connection points and the route, the trip\'s stops between', () => {
  const [fare] = offersOf(request({ from: '0000001', via: '0000003' }))[0].fares;
  const { entryConnectionPoint, exitConnectionPoint, regionalValidities } = fare.regionalConstraint;
  assert.equal(entryConnectionPoint.stationSets[0].stations[0].stopPlaceRef, 'urn:uic:stn:0000001');
  assert.equal(exitConnectionPoint.stationSets[0].stations[0].stopPlaceRef, 'urn:uic:stn:0000002');
  const { route } = regionalValidities[0];
  const first = route.routeItemList[route.routeItem.routeItemIndices[0]];
  const last = route.routeItemList[route.routeItem.routeItemIndices.at(-1)];
  const refOf = (item) => item.station?.id || item.fareReferenceStation.stations[0].stopPlaceRef;
  assert.equal(refOf(first), 'urn:uic:stn:0000001');
  assert.equal(refOf(last), 'urn:uic:stn:0000002');
  const own = JSON.stringify(fare.regionalConstraint).match(/urn:uic:stn:(\d{7})/g).filter((r) => !/:00000\d\d$/.test(r));
  assert.ok(own.every((r) => /:99\d{5}$/.test(r)), 'every other place is a station of the simulator\'s own');
  assert.deepEqual(fare.coveredSection, { startPlace: station('0000001'), endPlace: station('0000002') });
});

test('the trip\'s stops between the section\'s ends open the next items of the route', () => {
  const t3 = file.templates.find((t) => t.id === 'T03');
  const leg = (a, b) => ({ timedLeg: { start: { stopPlaceRef: station(a) }, end: { stopPlaceRef: station(b) } } });
  const trip = { legs: [leg('0000001', '0000003'), leg('0000003', '0000005'), leg('0000005', '0000002')] };
  const section = { startPlace: station('0000001'), endPlace: station('0000002') };
  const placeOf = placesFor(t3, section, trip);
  // T03's route: a station, a set of 2, a set of 9, alternatives (1 + 12, or 8), a station: 34 places.
  assert.equal(placeOf('route', 0).stopPlaceRef, 'urn:uic:stn:0000001');
  assert.equal(placeOf('route', 1).stopPlaceRef, 'urn:uic:stn:0000003', 'the first stop opens the second item');
  assert.equal(placeOf('route', 2).stopPlaceRef, 'urn:uic:stn:9903202', 'the rest of that set is the simulator\'s own');
  assert.equal(placeOf('route', 3).stopPlaceRef, 'urn:uic:stn:0000005', 'the next stop opens the third item');
  assert.equal(placeOf('route', 33).stopPlaceRef, 'urn:uic:stn:0000002', 'the end opens the last');
  assert.equal(placeOf('entry', 0).stopPlaceRef, 'urn:uic:stn:0000001');
  assert.equal(placeOf('exit', 0).stopPlaceRef, 'urn:uic:stn:0000002');
  assert.equal(placeOf('exit', 1).stopPlaceRef, 'urn:uic:stn:9903301');
  // Without a trip, every middle place is the simulator's own.
  assert.equal(placesFor(t3, section, null)('route', 1).stopPlaceRef, 'urn:uic:stn:9903201');
});

test('one fare per passenger: adult, child, a young child free with its own ages', () => {
  for (const offer of offersOf(request({ passengers: [adult(1), CHILD, YOUNG] }))) {
    const [a, c, y] = offer.fares;
    assert.deepEqual(offer.fares.map((f) => f.passengerRefs[0]), ['a1', 'c1', 'y1']);
    assert.ok(a.prices[0].amount > c.prices[0].amount && c.prices[0].amount > 0);
    assert.equal(y.prices[0].amount, 0);
    assert.deepEqual(a.passengerConstraints, [{ number: 1, lowerAgeLimit: 15, upperAgeLimit: 150 }]);
    assert.deepEqual(c.passengerConstraints, [{ number: 1, lowerAgeLimit: 6, upperAgeLimit: 14 }]);
    assert.deepEqual(y.passengerConstraints, [{ number: 1, lowerAgeLimit: 0, upperAgeLimit: 5 }]);
    assert.match(y.description.text, /free child/);
  }
});

test('a card of the provider takes the template\'s card fare and is required; a card no slot fits is not (F8)', () => {
  const plain = offersOf(request());
  const half = offersOf(request({ passengers: [withCard(adult(1), 'SIM_CARD_50')] }));
  const quarter = offersOf(request({ passengers: [withCard(adult(1), 'SIM_CARD_25')] }));
  const student = offersOf(request({ passengers: [withCard(adult(1), 'SIM_STUDENT')] }));
  plain.forEach((offer, i) => {
    const full = amounts(offer)[0];
    assert.ok(Math.abs(amounts(half[i])[0] - full / 2) <= 1, 'the 50 card fare is half');
    assert.ok(Math.abs(amounts(quarter[i])[0] - full * 0.75) <= full * 0.01, 'the 25 card fare is three quarters');
    assert.deepEqual(half[i].fares[0].requiredCards, [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_50', issuer: providers.get('gamma').carrier.ref }]);
    assert.equal(student[i].fares[0].requiredCards, undefined);
    assert.equal(amounts(student[i])[0], full);
  });
});

test('six people travel on a group fare, five on flexible fares', () => {
  const five = offersOf(request({ passengers: [1, 2, 3, 4, 5].map(adult) }));
  const six = offersOf(request({ passengers: [1, 2, 3, 4, 5, 6].map(adult) }));
  assert.match(five[0].fares[0].name.text, /^Flexible fare/);
  assert.match(six[0].fares[0].name.text, /^Group saver fare/);
  assert.equal(six[0].fares.length, 6);
  assert.ok(amounts(six[0])[0] < amounts(five[0])[0], 'cheaper per person');
  // A young child travelling free does not count towards the group.
  const fiveAndBaby = offersOf(request({ passengers: [1, 2, 3, 4, 5].map(adult).concat([YOUNG]) }));
  assert.match(fiveAndBaby[0].fares[0].name.text, /^Flexible fare/);
});

test('fares in the classes asked; a bicycle on its own fare in second class (F6)', () => {
  assert.deepEqual(offersOf(request({ classes: ['FIRST', 'SECOND'] })).map((o) => o.fares[0].travelClass), ['FIRST', 'FIRST', 'FIRST', 'SECOND', 'SECOND', 'SECOND']);
  for (const offer of offersOf(request({ passengers: [adult(1), BICYCLE], classes: ['FIRST'] }))) {
    const [a, b] = offer.fares;
    assert.equal(a.travelClass, 'FIRST');
    assert.equal(b.travelClass, 'SECOND');
    assert.match(b.name.text, /^Bicycle fare/);
  }
});

test('the alternativeRoutes variant gives every route of the pair, one offer per route and cluster', () => {
  const offers = offersOf(request({ from: '0000089' }));
  assert.equal(offers.length, 9);
  const distances = new Set(offers.map((o) => o.fares[0].regionalConstraint.distance));
  assert.equal(distances.size, 3);
  assert.ok(offers.every((o) => /route \d \(\d+ km\)$/.test(o.summary)));
});

test('every new case is an OSDM answer in every provider\'s version', () => {
  const cases = [
    request({ passengers: [adult(1), CHILD, YOUNG] }),
    request({ passengers: [withCard(adult(1), 'SIM_CARD_25')], classes: ['FIRST'] }),
    request({ passengers: [1, 2, 3, 4, 5, 6].map(adult) }),
    request({ passengers: [adult(1), BICYCLE] }),
    request({ to: '0000070', from: '0000004' }),
    request({ from: '0000089' }),
    request({ from: '0000001', via: '0000003' }),
  ];
  for (const key of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    const provider = providers.get(key);
    for (const req of cases) {
      const response = shapeAnswer(buildOfferCollection(req, provider, NOW).response, provider.osdmVersion);
      checkConformance('POST', `/${key}/offers`, 200, response);
    }
  }
});

// #1045: the variants of what a fare says, each changing one thing.
test('the detail variants: the real answer\'s form, a card not held, ages outside, another class, dates, an unknown leg', () => {
  const gamma = providers.get('gamma');
  const plain = offersOf(request());
  assert.ok(plain.every((o) => !o.tripCoverage && o.fares.every((f) => f.coveredSection && f.regionalConstraint.entryConnectionPoint)));

  const real = offersOf(request({ from: '0000060' }));
  assert.ok(real.length > 0);
  for (const offer of real) {
    assert.ok(offer.fares.every((f) => !f.coveredSection && !f.regionalConstraint.entryConnectionPoint && !f.regionalConstraint.exitConnectionPoint));
    const [section] = offer.tripCoverage.coveredSections;
    assert.deepEqual([section.startPlace.stopPlaceRef, section.endPlace.stopPlaceRef], ['urn:uic:stn:0000060', 'urn:uic:stn:0000002']);
    assert.equal(section.endLegId, offer.tripCoverage.coveredLegIds.at(-1));
  }

  const cards = offersOf(request({ from: '0000061' }));
  assert.ok(cards.every((o) => o.fares.every((f) => f.requiredCards[0].code === gamma.reductionCards[0].code && f.requiredCards[0].issuer === gamma.carrier.ref)));

  const ages = offersOf(request({ from: '0000062', passengers: [adult(1), adult(2)] }));
  for (const offer of ages) {
    assert.deepEqual(offer.fares[0].passengerConstraints, [{ number: 1, lowerAgeLimit: 6, upperAgeLimit: 14 }]);
    assert.notDeepEqual(offer.fares[1].passengerConstraints, offer.fares[0].passengerConstraints);
  }

  const classes = offersOf(request({ from: '0000063', classes: ['FIRST'] }));
  assert.ok(classes.length > 0 && classes.every((o) => o.fares.every((f) => f.travelClass === 'SECOND')));

  const dates = offersOf(request({ from: '0000064' }));
  assert.ok(dates.every((o) => o.fares.every((f) => f.travelValidityConstraint.validTravelDates.utcOffset === 0
    && f.travelValidityConstraint.validTravelDates.from.endsWith('+01:00'))));

  const legs = offersOf(request({ from: '0000065' }));
  assert.ok(legs.every((o) => o.tripCoverage.coveredSections[0].endLegId === 'no-such-leg' && o.fares.every((f) => f.coveredSection)));
});

test('every detail variant is an OSDM answer in every provider\'s version', () => {
  for (const key of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    const provider = providers.get(key);
    for (const from of ['0000060', '0000061', '0000062', '0000063', '0000064', '0000065']) {
      const response = shapeAnswer(buildOfferCollection(request({ from, classes: from === '0000063' ? ['FIRST'] : null }), provider, NOW).response, provider.osdmVersion);
      checkConformance('POST', `/${key}/offers`, 200, response);
    }
  }
});
