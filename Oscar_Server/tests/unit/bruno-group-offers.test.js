// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-group-offers.test.js — #599: group tariffs.
 *
 * A scenario asks for a group with the COLLECTIVE offer mode and names the
 * group product with expectedProduct. The chosen offer must hold one
 * COLLECTIVE admission for the whole group on each trip, naming each
 * passenger's type; step 01d asks the same offers in the INDIVIDUAL mode, and a
 * group dearer than the same passengers alone fails.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  setGlobalEnvVar: (k, v) => { envStore[`global:${k}`] = v; },
  runner: { setNextRequest: (name) => { envStore.__next = name; } },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const group = require('../../../Bruno_Collection/library-bruno/groupOffers.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}

beforeEach(() => { envStore = {}; });

const REFS = ['P1', 'P2', 'P3'];
const price = (amount) => ({ amount, currency: 'CZK', scale: 2 });
const types = (refs) => refs.map((ref, i) => ({ passengerRef: ref, type: i < 2 ? 'ADULT' : 'CHILD' }));
const part = (id, trip, refs, extra = {}) => ({ id, offerMode: 'COLLECTIVE', passengerRefs: refs, tripCoverage: { coveredTripId: trip }, price: price(100), ...extra });
const groupOffer = (parts, amount = 2000, flexibility = 'NON_FLEXIBLE') => ({
  offerId: 'G1',
  offerSummary: { minimalPrice: price(amount), overallTravelClass: 'SECOND', overallFlexibility: flexibility },
  admissionOfferParts: parts,
});
const alone = (offerId, amount, flexibility = 'NON_FLEXIBLE', travelClass = 'SECOND') => ({
  offerId, offerSummary: { minimalPrice: price(amount), overallTravelClass: travelClass, overallFlexibility: flexibility },
});

describe('the request', () => {
  test('COLLECTIVE is read from the offer search criteria; the INDIVIDUAL copy changes only the mode', () => {
    const request = { anonymousPassengerSpecifications: [{ externalRef: 'P1' }], offerSearchCriteria: { offerMode: 'COLLECTIVE', currency: 'CZK' } };
    expect(group.collectiveAsked(request)).toBe(true);
    expect(group.collectiveAsked({ offerSearchCriteria: { offerMode: 'INDIVIDUAL' } })).toBe(false);
    expect(group.collectiveAsked({})).toBe(false);
    expect(group.collectiveAsked(null)).toBe(false);
    const individual = group.individualRequest(request);
    expect(individual).toEqual({ ...request, offerSearchCriteria: { offerMode: 'INDIVIDUAL', currency: 'CZK' } });
    expect(request.offerSearchCriteria.offerMode).toBe('COLLECTIVE');
  });
});

describe('the chosen group offer', () => {
  test('one COLLECTIVE admission per trip for the whole group, every passenger typed: all pass', () => {
    const offer = groupOffer([part('A1', 'T1', REFS, { appliedPassengerTypes: types(REFS) }), part('A2', 'T2', ['P3', 'P2', 'P1'], { appliedPassengerTypes: types(REFS) })]);
    const checks = group.checkCollectiveOffer(offer, REFS);
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['Group offer: one COLLECTIVE admission for the whole group on trip T1', true],
      ['Group offer: one COLLECTIVE admission for the whole group on trip T2', true],
      ['Group offer: admission A1 names the passenger type of each passenger — P1: ADULT, P2: ADULT, P3: CHILD', true],
      ['Group offer: admission A2 names the passenger type of each passenger — P1: ADULT, P2: ADULT, P3: CHILD', true],
    ]);
  });

  test('individual admissions, a part missing a passenger, or two collective parts fail, saying what was found', () => {
    const individual = groupOffer(REFS.map((ref) => part(`I${ref}`, 'T1', [ref], { offerMode: 'INDIVIDUAL' })));
    expect(group.checkCollectiveOffer(individual, REFS)[0]).toMatchObject({
      ok: false, message: 'expected one COLLECTIVE admission for [P1, P2, P3]; found: INDIVIDUAL [P1]; INDIVIDUAL [P2]; INDIVIDUAL [P3]',
    });
    expect(group.checkCollectiveOffer(groupOffer([part('A1', 'T1', ['P1', 'P2'])]), REFS)[0].ok).toBe(false);
    expect(group.checkCollectiveOffer(groupOffer([part('A1', 'T1', REFS), part('A2', 'T1', REFS)]), REFS)[0].ok).toBe(false);
    expect(group.checkCollectiveOffer(groupOffer([]), REFS)).toEqual([{ name: 'Group offer: the chosen offer holds an admission', ok: false, message: 'no admissionOfferParts' }]);
    expect(group.checkCollectiveOffer(null, REFS)[0].ok).toBe(false);
  });

  test('no applied passenger types is a warning (optional in OSDM); a type missing for one passenger fails', () => {
    const untyped = group.checkCollectiveOffer(groupOffer([part('A1', 'T1', REFS)]), REFS);
    expect(untyped[1]).toEqual({ name: 'Group offer: the passenger types applied to the group are given', ok: false, level: 'warn', message: 'no COLLECTIVE admission gives appliedPassengerTypes' });
    const partly = group.checkCollectiveOffer(groupOffer([part('A1', 'T1', REFS, { appliedPassengerTypes: types(['P1', 'P2']) })]), REFS);
    expect(partly[1]).toMatchObject({ ok: false, message: 'no applied passenger type for [P3]' });
    expect(partly[1].level).toBeUndefined();
  });
});

describe('01d: the group price against the same passengers alone', () => {
  const answer = (...list) => ({ offers: list });

  test('cheaper passes, naming both prices; the cheapest offer of the same class and flexibility is the one compared', () => {
    const [check] = group.compareGroupWithIndividual(groupOffer([], 2000), answer(alone('I1', 3000), alone('I2', 2500), alone('I3', 900, 'FULL_FLEXIBLE'), alone('I4', 800, 'NON_FLEXIBLE', 'FIRST')));
    expect(check).toEqual({ name: 'Group offer: the group pays less than the same passengers alone — group 2000 CZK, alone 2500 (offer I2)', ok: true });
  });

  test('dearer fails, the same price is a warning', () => {
    expect(group.compareGroupWithIndividual(groupOffer([], 2600), answer(alone('I2', 2500)))[0])
      .toMatchObject({ ok: false, message: 'the group offer costs more than the same passengers alone' });
    const same = group.compareGroupWithIndividual(groupOffer([], 2500), answer(alone('I2', 2500)))[0];
    expect(same).toMatchObject({ ok: false, level: 'warn' });
  });

  test('without the same flexibility, another of the same class is compared and the name says so', () => {
    const [check] = group.compareGroupWithIndividual(groupOffer([], 2000), answer(alone('I5', 2200, 'SEMI_FLEXIBLE')));
    expect(check.name).toBe('Group offer: the group pays less than the same passengers alone — group 2000 CZK, alone 2200 (offer I5, another flexibility)');
  });

  test('nothing to compare is a warning: no offer of the class or currency, no group price', () => {
    expect(group.compareGroupWithIndividual(groupOffer([], 2000), answer(alone('I4', 800, 'NON_FLEXIBLE', 'FIRST')))[0]).toMatchObject({ ok: false, level: 'warn' });
    expect(group.compareGroupWithIndividual(groupOffer([], 2000), { offers: [{ offerId: 'X', offerSummary: { minimalPrice: { amount: 1, currency: 'EUR' }, overallTravelClass: 'SECOND' } }] })[0].level).toBe('warn');
    expect(group.compareGroupWithIndividual(groupOffer([], 2000), null)[0].level).toBe('warn');
    expect(group.compareGroupWithIndividual({ offerSummary: { overallTravelClass: 'SECOND' } }, answer(alone('I1', 1)))[0])
      .toMatchObject({ level: 'warn', message: 'the group offer has no price; not compared' });
  });

  test('an offer without a minimal price is priced by the sum of its admissions', () => {
    const offer = { offerId: 'G', offerSummary: { overallTravelClass: 'SECOND', overallFlexibility: 'NON_FLEXIBLE' }, admissionOfferParts: [{ price: price(700) }, { price: price(800) }] };
    expect(group.compareGroupWithIndividual(offer, answer(alone('I1', 2000)))[0].name).toContain('group 1500 CZK, alone 2000');
  });
});

describe('the steps', () => {
  const request = (offerMode) => JSON.stringify({ anonymousPassengerSpecifications: REFS.map((externalRef) => ({ externalRef })), offerSearchCriteria: { offerMode } });

  test('checkGroupOffer records the checks for a COLLECTIVE request only; warnings are log lines', () => {
    envStore.OfferCollectionRequest = request('COLLECTIVE');
    envStore.offer = JSON.stringify(groupOffer([part('A1', 'T1', REFS)]));
    const r = run(() => offers.checkGroupOffer());
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([['Group offer: one COLLECTIVE admission for the whole group on trip T1', true]]);
    expect(r.logs).toContain('[WARNING] Group offer: the passenger types applied to the group are given — no COLLECTIVE admission gives appliedPassengerTypes');
    envStore.OfferCollectionRequest = request('INDIVIDUAL');
    expect(run(() => offers.checkGroupOffer()).results).toEqual([]);
  });

  test('routeAfterOfferStep goes to 01d once for a COLLECTIVE request, then on as before', () => {
    envStore.OfferCollectionRequest = request('COLLECTIVE');
    envStore.offer = JSON.stringify(groupOffer([], 2000));
    offers.routeAfterOfferStep();
    expect(envStore.__next).toBe('01d. POST Get Offer Individual');
    const r = run(() => offers.compareGroupOfferIndividual(200, { offers: [alone('I1', 2600)] }));
    expect(r.results.map((x) => x.ok)).toEqual([true]);
    expect(envStore.__groupPriceCompareDone).toBe('true');
    offers.routeAfterOfferStep();
    expect(envStore.__next).toBe('02. POST Create Booking');
    envStore = { OfferCollectionRequest: request('INDIVIDUAL') };
    offers.routeAfterOfferStep();
    expect(envStore.__next).toBe('02. POST Create Booking');
  });

  test('01d answering an error is a warning, compared no more', () => {
    envStore.offer = JSON.stringify(groupOffer([], 2000));
    const r = run(() => offers.compareGroupOfferIndividual(422, null));
    expect(r.results).toEqual([]);
    expect(r.logs).toEqual(['[WARNING] Group offer: the INDIVIDUAL offer request answered 422; prices not compared.']);
    expect(envStore.__groupPriceCompareDone).toBe('true');
  });

  test('the request files: 01 and 01b check the group offer; 01d sends the INDIVIDUAL copy and routes on', () => {
    const dir = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', '02-Common Requests');
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    expect(read('01. POST Get Offer.yml')).toMatch(/checkGroupOffer\(\);/);
    expect(read('01b. POST Get Return Offer.yml')).toMatch(/checkGroupOffer\(\);/);
    const d = read('01d. POST Get Offer Individual.yml');
    expect(d).toMatch(/name: 01d\. POST Get Offer Individual/);
    expect(d).toMatch(/data: "\{\{OfferCollectionRequestIndividual\}\}"/);
    expect(d).toMatch(/individualRequest\(_request\)/);
    expect(d).toMatch(/compareGroupOfferIndividual\(res\.getStatus\(\), _body\);\s+routeAfterOfferStep\(\);/);
  });
});
