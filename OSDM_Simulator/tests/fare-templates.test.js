// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1047: the fare templates made from DB's real fares, and the online fares
// the simulator makes of them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fareTemplates, onlineFare, regionalConstraintOf } = require('../src/osdm/fareTemplates');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { REGIONS, REGION_NUMBERS } = require('../scripts/fare-templates-lib');
const { responseIssues, VERSIONS } = require('./osdm-conformance');

const file = fareTemplates();
const fareKey = (f) => [f.family, f.travelClass, f.passenger, f.card].join('|');

// Every string of the file but `about`, keys included.
function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); stringsOf(v, out); }
  return out;
}

test('26 templates, one per region read, in the script\'s order, 27 fares each', () => {
  assert.deepEqual(file.templates.map((t) => t.id), Array.from({ length: 26 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(file.templates.map((t) => t.madeFromRegion), REGION_NUMBERS);
  assert.deepEqual(file.templates.map((t) => t.shape), REGIONS.flatMap((r) => r.numbers.map(() => r.shape)));
  for (const t of file.templates) {
    assert.equal(t.fares.length, 27, t.id);
    assert.equal(new Set(t.fares.map(fareKey)).size, 27, `${t.id}: each fare once`);
  }
  assert.equal(file.about.currency, 'EUR');
  assert.match(file.about.source, /fare provider 1080, delivery 2024\.02/);
});

test('no place, company or card of DB\'s outside `about`: no code of four digits or more, none of its words', () => {
  const { about, ...rest } = file;
  assert.ok(about.leftOut);
  const strings = stringsOf(rest);
  assert.deepEqual(strings.filter((s) => /\d{4}/.test(s)), []);
  const words = /Flexpreis|Gruppe|Fahrrad|BahnCard|Hbf|FIP|Erwachsen|Kind|Hund|Klasse|Bf\b/;
  assert.deepEqual(strings.filter((s) => words.test(s)), []);
});

test('every key a fare names is in the file', () => {
  for (const t of file.templates) {
    for (const f of t.fares) {
      assert.ok(file.bundles[f.bundle], `${t.id} bundle ${f.bundle}`);
      assert.ok(file.passengerConstraints[f.passenger], `${t.id} passenger ${f.passenger}`);
      assert.ok(file.carrierConstraints[f.carriers], `${t.id} carriers ${f.carriers}`);
      if (f.card) assert.ok(file.cardSlots[f.card], `${t.id} card ${f.card}`);
      assert.ok(Number.isInteger(f.price) && f.price >= 0, `${t.id} price`);
    }
    for (const v of t.regionalValidities) if (v.carriers) assert.ok(file.carrierConstraints[v.carriers]);
  }
  for (const p of Object.values(file.passengerConstraints)) {
    for (const x of [...p.includedFree, ...p.combinedWith]) assert.ok(file.passengerConstraints[x.constraint]);
  }
  for (const b of Object.values(file.bundles)) assert.ok(file.passengerCombinations[b.passengers]);
});

test('DB\'s doubled card fare is the child\'s in every region', () => {
  assert.match(file.about.corrected, /\(26 fares\)/);
  for (const t of file.templates) {
    const quarter = t.fares.filter((f) => f.family === 'FLEXIBLE' && f.travelClass === 'SECOND' && f.card === 'R3');
    assert.deepEqual(quarter.map((f) => f.passenger).sort(), ['G1', 'G3'], t.id);
    const [adult, child] = ['G1', 'G3'].map((g) => quarter.find((f) => f.passenger === g));
    assert.ok(child.price < adult.price, t.id);
  }
});

test('first class is dearer than second, or the same where the class does not matter (DB\'s prices kept)', () => {
  for (const t of file.templates) {
    const second = new Map(t.fares.filter((f) => f.travelClass === 'SECOND').map((f) => [`${f.family}|${f.passenger}|${f.card && file.cardSlots[f.card].family}`, f.price]));
    for (const f of t.fares.filter((x) => x.travelClass === 'FIRST')) {
      const other = second.get(`${f.family}|${f.passenger}|${f.card && file.cardSlots[f.card].family}`);
      if (other === undefined) continue;
      assert.ok(f.price > other || f.price === other, `${t.id} ${fareKey(f)}`);
    }
  }
});

test('the routes of one pair of ends share their ends; the long pair has three routes each way', () => {
  const byPair = new Map();
  for (const t of file.templates) byPair.set(`${t.pair}/${t.direction}`, [...(byPair.get(`${t.pair}/${t.direction}`) || []), t]);
  for (const [pair, ts] of byPair) {
    for (const t of ts) {
      assert.deepEqual(t.entry, ts[0].entry, pair);
      assert.deepEqual(t.exit, ts[0].exit, pair);
    }
  }
  const long = file.templates.filter((t) => t.pair === 10);
  assert.deepEqual(long.map((t) => t.direction), [0, 1, 0, 1, 0, 1]);
  assert.deepEqual(long.filter((t) => t.direction === 0).map((t) => t.distance), [1010, 877, 1107]);
  const reverse = (side) => file.templates.find((t) => t.pair === side.pair && t.direction !== side.direction);
  for (const t of file.templates) assert.deepEqual(reverse(t).entry, t.exit, `${t.id} reversed`);
});

// Places numbered as they are asked for.
function placesInOrder() {
  const asked = [];
  const placeOf = (role, n) => {
    asked.push([role, n]);
    const code = String(9800000 + asked.length);
    return { stopPlaceRef: `urn:uic:stn:${code}`, name: `Station ${code}` };
  };
  return { asked, placeOf };
}
const companies = (n) => Array.from({ length: n }, (_, i) => `urn:x_osdm_simulator:company:${i}`);
const FULL_FLEX_CONDITIONS = { conditions: [{ condition: 'REFUND', afterSaleFee: { amount: 0, currency: 'EUR', scale: 2 } }], isProviderFee: true };
function laid(t, f, j, places = placesInOrder()) {
  return onlineFare(file, t, f, {
    id: `${t.id}-${j}`,
    passengerRefs: ['p1'],
    day: '2026-11-20',
    placeOf: places.placeOf,
    companies,
    cardFor: (slot) => ({ type: 'REDUCTION_CARD', code: `SIM-${slot}`, issuer: 'urn:x_osdm_simulator:carrier:gamma' }),
    afterSalesCondition: FULL_FLEX_CONDITIONS,
  });
}

test('every template fare, laid on places, is an online Fare of every OSDM version', () => {
  const fares = file.templates.flatMap((t) => t.fares.map((f, j) => laid(t, f, j)));
  assert.equal(fares.length, 702);
  for (const version of VERSIONS) {
    const body = shapeAnswer({
      anonymousPassengerSpecifications: [{ externalRef: 'p1', type: 'PERSON' }],
      offers: [{ offerId: 'o1', summary: 'fares', createdOn: '2026-11-02T09:00:00Z', preBookableUntil: '2026-11-02T09:30:00Z', passengerRefs: ['p1'], fares }],
    }, version);
    assert.deepEqual(responseIssues(version, 'POST', '/offers', 200, body), [], version);
  }
});

// The places a shape asks for, counted from the template.
function placesOfRoute(node) {
  if (node.place === 'station') return 1;
  if (node.place === 'stationSet') return node.stations;
  return (node.sequence || node.alternatives).reduce((n, x) => n + placesOfRoute(x), 0);
}

test('a region asks for its entry\'s places, then its route\'s in reading order, then its exit\'s', () => {
  for (const t of file.templates) {
    const places = placesInOrder();
    const rc = regionalConstraintOf(t, places.placeOf, { carrier: 'c', carrierConstraint: () => ({ includedCarriers: ['c'] }) });
    const sum = (sets) => sets.reduce((a, b) => a + b, 0);
    const counts = { entry: sum(t.entry.stationSets), route: t.regionalValidities.reduce((n, v) => n + placesOfRoute(v.route), 0), exit: sum(t.exit.stationSets) };
    const roles = places.asked.map(([role]) => role);
    assert.deepEqual(roles, [...Array(counts.entry).fill('entry'), ...Array(counts.route).fill('route'), ...Array(counts.exit).fill('exit')], t.id);
    assert.deepEqual(places.asked.filter(([r]) => r === 'route').map(([, n]) => n), Array.from({ length: counts.route }, (_, i) => i));
    assert.equal(rc.distance, t.distance);
    assert.deepEqual(rc.entryConnectionPoint.stationSets.map((s) => s.stations.length), t.entry.stationSets);
  }
});

test('the route is a flat list naming its parts by index, alternatives kept', () => {
  const t = file.templates.find((x) => x.id === 'T03');
  const { route } = regionalConstraintOf(t, placesInOrder().placeOf, { carrier: 'c', carrierConstraint: () => ({ includedCarriers: ['c'] }) }).regionalValidities[0];
  const list = route.routeItemList;
  const referenced = [...route.routeItem.routeItemIndices];
  for (const item of list) referenced.push(...(item.routeItemIndices || []), ...(item.alternativeRouteItemIndices || []));
  assert.deepEqual([...referenced].sort((a, b) => a - b), list.map((_, i) => i), 'each item named once');
  const alternatives = list.filter((i) => i.alternativeRouteItemIndices);
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].alternativeRouteItemIndices.length, 2);
  assert.match(route.routeSummary, /^Station \d+ - .* - \(.* \/ .*\) - Station \d+$/);
  assert.ok(list.some((i) => i.fareReferenceStation?.stations.length === 12), 'a station set keeps its size');
});

test('a fare\'s other members come from its template', () => {
  const t = file.templates[0];
  const card = t.fares.find((f) => f.card === 'R1');
  const fare = laid(t, card, 3);
  assert.deepEqual(fare.prices, [{ amount: card.price, currency: 'EUR', scale: 2 }]);
  assert.deepEqual(fare.requiredCards, [{ type: 'REDUCTION_CARD', code: 'SIM-R1', issuer: 'urn:x_osdm_simulator:carrier:gamma' }]);
  assert.equal(fare.involvedTCOs.length, card.involvedTCOs);
  assert.equal(fare.carrierConstraint.includedCarriers.length, file.carrierConstraints[card.carriers].carriers);
  assert.deepEqual(fare.combinationConstraint, file.bundles.S1.combinationConstraint);
  assert.deepEqual(fare.travelValidityConstraint, {
    validTravelDates: { from: '2026-11-20T00:00:00Z', until: '2026-11-22T00:00:00Z' },
    validityRange: { timeUnit: 'DAYS', value: 2, hoursAfterMidnight: 0 },
    validityType: 'SINGLE_TRIP',
  });
  assert.deepEqual(fare.fulfillmentConstraint, { acceptedControlSecurityTypes: ['SID', 'SIP', 'SIS'], isIndividualTicketingForbidden: false });
  assert.deepEqual(fare.passengerConstraints, [{ number: 1, lowerAgeLimit: 15, upperAgeLimit: 150 }]);
  assert.equal(laid(t, t.fares.find((f) => !f.card), 0).requiredCards, undefined);
  // A combination given by the caller replaces the template's.
  const own = [{ model: 'CLUSTERING', referenceCluster: 'SEMI_FLEX', allowedClusters: ['SEMI_FLEX', 'NON_FLEX'] }];
  assert.deepEqual(onlineFare(file, t, card, { ...laidContext(), combinationConstraint: own }).combinationConstraint, own);
});

function laidContext() {
  return { id: 'x', passengerRefs: ['p1'], day: '2026-11-20', placeOf: placesInOrder().placeOf, companies, cardFor: () => ({ type: 'REDUCTION_CARD' }), afterSalesCondition: FULL_FLEX_CONDITIONS };
}

test('a place not given, or a template naming what the file lacks, is refused', () => {
  const t = file.templates[0];
  assert.throws(() => onlineFare(file, t, t.fares[0], { ...laidContext(), placeOf: () => null }), /no place given for entry 0/);
  assert.throws(() => onlineFare(file, t, { ...t.fares[0], bundle: 'S9' }, laidContext()), /bundle S9 or passenger G\d+ is not in the file/);
  assert.throws(() => onlineFare(file, t, { ...t.fares[0], carriers: 'C9' }, laidContext()), /carrier constraint C9 is not in the file/);
  const odd = { ...t, regionalValidities: [{ route: { place: 'station' } }] };
  assert.throws(() => regionalConstraintOf(odd, laidContext().placeOf, { carrierConstraint: () => ({}) }), /a route that is not a sequence/);
  const empty = { ...t, regionalValidities: [{ route: { sequence: [{}] } }] };
  assert.throws(() => regionalConstraintOf(empty, laidContext().placeOf, { carrierConstraint: () => ({}) }), /no place, sequence or alternatives/);
});
