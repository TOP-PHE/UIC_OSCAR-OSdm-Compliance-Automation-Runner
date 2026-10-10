// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-leg-classes.test.js — #600: the travel class of each leg.
 *
 * Before, the travel class was asked once for the whole request and nothing
 * looked at the class of each leg. Now `legTravelClasses` names it per leg;
 * the request asks for every class named, the offer chosen gives each leg
 * its class (an admission of its own, or a supplement on the leg), and the
 * booking must give the same.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockResults = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: () => {},
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
}));
global.validationLogger = () => {};

const lc = require('../../../Bruno_Collection/library-bruno/legClasses.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

beforeEach(() => { envStore = {}; mockResults = []; });

const trips = [{ id: 'T1', legs: [{ id: 'L1' }, { id: 'L2' }] }];
const product = (id, travelClass, type = 'ADMISSION_POINT2POINT') => ({ id, travelClass, type });
const part = (id, productId, legIds) => ({ id, summaryProductId: productId, tripCoverage: { coveredTripId: 'T1', coveredLegIds: legIds }, products: [{ productId, legIds }] });
const offer = (offerId, parts, products) => ({ offerId, tripCoverage: { coveredTripId: 'T1' }, admissionOfferParts: parts, products });

// Second class for both legs and a supplement on the first (the ČD model).
const upgraded = offer('UP', [part('A', 'P2', ['L1', 'L2']), part('U', 'UPG', ['L1'])], [product('P2', 'SECOND'), product('UPG', 'FIRST', 'UPGRADE_POINT2POINT')]);
// An admission of its own per leg.
const perLeg = offer('PL', [part('A1', 'P1', ['L1']), part('A2', 'P2', ['L2'])], [product('P1', 'FIRST'), product('P2', 'SECOND')]);
const allSecond = offer('S', [part('A', 'P2', ['L1', 'L2'])], [product('P2', 'SECOND')]);
const allFirst = offer('F', [part('A', 'P1', ['L1', 'L2'])], [product('P1', 'FIRST')]);

describe('the scenario\'s classes and the request', () => {
  test('a list or a text, upper case, blanks dropped; nothing named is null', () => {
    expect(lc.normaliseLegClasses(['first', ' SECOND '])).toEqual(['FIRST', 'SECOND']);
    expect(lc.normaliseLegClasses('FIRST, second')).toEqual(['FIRST', 'SECOND']);
    expect(lc.normaliseLegClasses('')).toBeNull();
    expect(lc.normaliseLegClasses(null)).toBeNull();
    expect(lc.normaliseLegClasses([])).toBeNull();
    expect(lc.requestedClasses(['FIRST', 'SECOND', 'FIRST'])).toEqual(['FIRST', 'SECOND']);
  });
});

describe('the class of each leg', () => {
  test('a supplement on a leg raises it to first class and is reported as such', () => {
    expect(lc.classesByLeg(upgraded.admissionOfferParts, upgraded.products, ['L1', 'L2'])).toEqual([
      { legId: 'L1', travelClass: 'FIRST', form: 'upgrade', partIds: ['A', 'U'] },
      { legId: 'L2', travelClass: 'SECOND', form: 'admission', partIds: ['A'] },
    ]);
  });

  test('an admission per leg gives each its own class; a narrower first-class part without an upgrade type counts as a supplement', () => {
    expect(lc.classesByLeg(perLeg.admissionOfferParts, perLeg.products, ['L1', 'L2']).map((l) => [l.travelClass, l.form])).toEqual([['FIRST', 'admission'], ['SECOND', 'admission']]);
    const narrower = offer('N', [part('A', 'P2', ['L1', 'L2']), part('B', 'P1', ['L1'])], [product('P2', 'SECOND'), product('P1', 'FIRST')]);
    expect(lc.classesByLeg(narrower.admissionOfferParts, narrower.products, ['L1', 'L2'])[0].form).toBe('upgrade');
  });

  test('a part that names no product list falls back to its summary product and trip coverage; an uncovered leg has no class', () => {
    const bare = [{ id: 'A', summaryProductId: 'P1', tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } }];
    expect(lc.classesByLeg(bare, [product('P1', 'FIRST')], ['L1', 'L2'])).toEqual([
      { legId: 'L1', travelClass: 'FIRST', form: 'admission', partIds: ['A'] },
      { legId: 'L2', travelClass: null, form: null, partIds: [] },
    ]);
    expect(lc.classesByLeg(null, null, [])).toEqual([]);
  });

  test('the legs are those of the trip the offer covers, in order', () => {
    expect(lc.legIdsOf(upgraded, trips)).toEqual(['L1', 'L2']);
    expect(lc.legIdsOf({ admissions: [{ tripCoverage: { coveredTripId: 'T1' } }] }, trips)).toEqual(['L1', 'L2']);
    expect(lc.legIdsOf({}, trips)).toEqual([]);
  });
});

describe('matching and checking', () => {
  test('both forms match [FIRST, SECOND]; all first, all second or another leg count do not', () => {
    const want = ['FIRST', 'SECOND'];
    expect([upgraded, perLeg, allSecond, allFirst].map((o) => lc.offerMatches(o, trips, want))).toEqual([true, true, false, false]);
    expect(lc.offerMatches(upgraded, trips, ['FIRST'])).toBe(false);
    expect(lc.offeredCombinations([allSecond, allSecond, upgraded], trips)).toEqual(['[SECOND, SECOND] (2 offers)', '[FIRST, SECOND] (1 offer)']);
  });

  test('one check per leg naming how the class is given; a wrong class or leg count fails', () => {
    expect(lc.checkLegClasses('Offer', upgraded, trips, ['FIRST', 'SECOND'])).toEqual([
      { name: 'Offer: leg 1 (L1) in FIRST class — FIRST, with a supplement on this leg', ok: true, message: undefined },
      { name: 'Offer: leg 2 (L2) in SECOND class — SECOND, by its admission', ok: true, message: undefined },
    ]);
    expect(lc.checkLegClasses('Booking', allSecond, trips, ['FIRST', 'SECOND'])[0]).toMatchObject({ ok: false, message: 'got SECOND' });
    expect(lc.checkLegClasses('Booking', allSecond, trips, ['FIRST'])).toEqual([
      { name: 'Booking: one class per leg', ok: false, message: 'the trip has 2 leg(s), the scenario names 1 class(es): [FIRST]' },
    ]);
    // A booked offer carries `admissions` instead of `admissionOfferParts`.
    const booked = { admissions: upgraded.admissionOfferParts, products: upgraded.products };
    expect(lc.checkLegClasses('Booking', booked, trips, ['FIRST', 'SECOND']).every((c) => c.ok)).toBe(true);
  });
});

describe('the offer step', () => {
  const select = (list) => withBrunoExpect(() => offers.selectAndSetOffer({ offers: list, trips }));

  test('the offer giving each leg its class is chosen, and the chosen offer is checked leg by leg', () => {
    envStore.legTravelClasses = JSON.stringify(['FIRST', 'SECOND']);
    select([allSecond, allFirst, upgraded]);
    expect(envStore.offerId).toBe('UP');
    expect(mockResults.find((r) => r.name.startsWith('Offer: an offer gives each leg'))).toMatchObject({ ok: true, name: 'Offer: an offer gives each leg its class [FIRST, SECOND] — 1 offer(s)' });
    mockResults = [];
    withBrunoExpect(() => offers.checkOfferLegClasses({ trips }));
    expect(mockResults.map((r) => r.ok)).toEqual([true, true]);
  });

  test('no offer giving them fails, lists what was offered, and the step is told to stop', () => {
    envStore.legTravelClasses = JSON.stringify(['FIRST', 'SECOND']);
    select([allSecond, allFirst]);
    const check = mockResults.find((r) => r.name.startsWith('Offer: an offer gives each leg'));
    expect(check).toMatchObject({ ok: false, message: 'classes per leg offered: [SECOND, SECOND] (1 offer); [FIRST, FIRST] (1 offer)' });
    expect(envStore.__legClassesNotOffered).toBe('true');
  });

  test('no class per leg: nothing changes, no check', () => {
    select([allSecond, upgraded]);
    expect(mockResults.some((r) => r.name.includes('each leg'))).toBe(false);
    mockResults = [];
    offers.checkOfferLegClasses({ trips });
    expect(mockResults).toEqual([]);
  });
});

describe('the steps and the parser', () => {
  const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

  test('01 and 01b stop on __legClassesNotOffered; 01 checks the chosen offer; 07 checks the booking', () => {
    expect(read('02-Common Requests', '01. POST Get Offer.yml')).toMatch(/__legClassesNotOffered[\s\S]*loopbackOrStop\("POST Get Offer \(class per leg\)"\)[\s\S]*checkOfferLegClasses\(jsonData\)/);
    expect(read('02-Common Requests', '01b. POST Get Return Offer.yml')).toMatch(/__legClassesNotOffered[\s\S]*loopbackOrStop\("POST Get Return Offer \(class per leg\)"\)/);
    expect(read('02-Common Requests', '07. GET Booking after Fulfillments.yml')).toMatch(/checkLegClasses\("Booking"/);
  });

  test('the parser asks for every class named, and both reset lists name the variables', () => {
    const parser = read('library-bruno', 'scenarioParser.js');
    expect(parser).toMatch(/_perLeg \? require\('\.\/legClasses\.js'\)\.requestedClasses\(_perLeg\) : \(criteria\.travelClass \|\| null\)/);
    for (const text of [parser, read('opencollection.yml')]) expect(text).toMatch(/"legTravelClasses", "__legClassesNotOffered"/);
  });
});
