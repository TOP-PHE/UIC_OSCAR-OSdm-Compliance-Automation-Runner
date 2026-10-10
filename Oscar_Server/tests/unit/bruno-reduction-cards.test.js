// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-reduction-cards.test.js — #597: a passenger's reduction cards.
 *
 * Before, the editor kept the card codes and nothing sent them. Now they go in
 * the offer and booking requests as OSDM CardReferences, with the issuer from
 * the provider's list, and two checks prove a card was applied: the offer
 * names it on the passenger, and the passenger pays less than in the same
 * request without cards (step 01c).
 */

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

const rc = require('../../../Bruno_Collection/library-bruno/reductionCards.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const failed = (r) => r.results.filter((x) => !x.ok).map((x) => x.name);

beforeEach(() => { envStore = {}; });

const card = (code, extra = {}) => ({ type: 'REDUCTION_CARD', code, ...extra });
const price = (amount) => ({ amount, currency: 'CZK', scale: 2 });
const applied = (ref, code) => ({ passengerRef: ref, type: 'ADULT', description: 'x', appliedReductionCardTypes: [{ code, issuer: 'urn:x:i', name: { id: 'n', text: 'n' } }] });
const offerOf = (parts, summary = { overallFlexibility: 'FULL_FLEXIBLE', overallTravelClass: 'SECOND' }) => ({
  offerId: 'O', offerSummary: summary, passengerRefs: [...new Set(parts.map((p) => p.passengerRefs[0]))], admissionOfferParts: parts,
});
const part = (ref, amount, extra = {}) => ({ passengerRefs: [ref], price: price(amount), ...extra });

describe('cardsOfPassenger: the data file\'s codes as CardReferences', () => {
  test('codes become REDUCTION_CARD references; blanks and repeats are left out', () => {
    expect(rc.cardsOfPassenger({ reductionCards: [' SIM_CARD_25 ', '', 'SIM_CARD_25', 'SIM_STUDENT', null] }))
      .toEqual([card('SIM_CARD_25'), card('SIM_STUDENT')]);
  });

  test('an object entry keeps its issuer and number; no cards, no list', () => {
    expect(rc.cardsOfPassenger({ reductionCards: [{ code: 'C1', issuer: 'urn:x', number: '42' }, { issuer: 'no code' }] }))
      .toEqual([card('C1', { issuer: 'urn:x', number: '42' })]);
    expect(rc.cardsOfPassenger({})).toEqual([]);
    expect(rc.cardsOfPassenger({ reductionCards: 'C1' })).toEqual([]);
  });

  test('at most five cards a passenger', () => {
    expect(rc.cardsOfPassenger({ reductionCards: ['A', 'B', 'C', 'D', 'E', 'F'] })).toHaveLength(5);
  });
});

describe('withIssuers: the issuer comes from the provider\'s list', () => {
  const specs = [{ externalRef: 'P1', cards: [card('C1'), card('C2'), card('C3', { issuer: 'mine' })] }, { externalRef: 'P2' }];

  test('a code in the list gets its issuer; one already set is kept; unknown codes are reported', () => {
    const { specs: out, unknown } = rc.withIssuers(specs, [{ code: 'C1', issuer: 'urn:a' }, { code: 'C3', issuer: 'urn:b' }]);
    expect(out[0].cards).toEqual([card('C1', { issuer: 'urn:a' }), card('C2'), card('C3', { issuer: 'mine' })]);
    expect(out[1]).toBe(specs[1]);
    expect(unknown).toEqual(['C2']);
    expect(specs[0].cards[0].issuer).toBeUndefined();
  });

  test('without a list nothing changes and nothing is called unknown', () => {
    expect(rc.withIssuers(specs, null)).toEqual({ specs, unknown: [] });
  });

  test('knownCardTypesFrom reads a ReductionCardCollectionResponse', () => {
    expect(rc.knownCardTypesFrom({ reductionCardTypes: [{ code: 'C1', issuer: 'urn:a', name: {} }, { name: {} }, { code: 'C2' }] }))
      .toEqual([{ code: 'C1', issuer: 'urn:a' }, { code: 'C2' }]);
    expect(rc.knownCardTypesFrom(null)).toBeNull();
    expect(rc.knownCardTypesFrom([])).toBeNull();
  });

  test('withoutCards takes the cards off and nothing else', () => {
    expect(rc.withoutCards(specs)).toEqual([{ externalRef: 'P1' }, { externalRef: 'P2' }]);
  });
});

describe('checkCardsApplied: the offer names the card on the passenger', () => {
  const specs = [{ externalRef: 'P1', cards: [card('C1')] }, { externalRef: 'P2' }];

  test('an admission of the passenger naming the card passes; the passenger without card is not checked', () => {
    const checks = rc.checkCardsApplied(offerOf([part('P1', 75, { appliedPassengerTypes: [applied('P1', 'C1')] }), part('P2', 100)]), specs);
    expect(checks).toEqual([{ name: 'Offer: the reduction card of passenger P1 is applied (C1)', ok: true, message: undefined }]);
  });

  test('appliedReductions counts as well as appliedReductionCardTypes', () => {
    const type = { passengerRef: 'P1', type: 'ADULT', description: 'x', appliedReductions: [card('C1')] };
    expect(rc.checkCardsApplied(offerOf([part('P1', 75, { appliedPassengerTypes: [type] })]), specs)[0].ok).toBe(true);
  });

  test('no applied type, another card, or another passenger\'s entry fails, saying what is named', () => {
    for (const types of [undefined, [applied('P1', 'OTHER')], [applied('P2', 'C1')]]) {
      const [check] = rc.checkCardsApplied(offerOf([part('P1', 75, { appliedPassengerTypes: types })]), specs);
      expect(check.ok).toBe(false);
      expect(check.message).toMatch(/no admission of passenger P1 names the card/);
    }
  });

  test('an offer with no admission for the passenger fails with that reason', () => {
    expect(rc.checkCardsApplied(offerOf([part('P2', 100)]), specs)[0].message).toMatch(/no admission of the chosen offer is for passenger P1/);
  });
});

describe('comparePrices: less with the card than without', () => {
  const specs = [{ externalRef: 'P1', cards: [card('C1')] }, { externalRef: 'P2' }];
  const plain = { offers: [offerOf([part('P1', 100), part('P2', 100)], { overallFlexibility: 'NON_FLEXIBLE', overallTravelClass: 'SECOND' }), offerOf([part('P1', 160), part('P2', 160)])] };

  test('the counterpart is the offer of the same flexibility and class; the holder pays less, the other the same', () => {
    const checks = rc.comparePrices(offerOf([part('P1', 120), part('P2', 160)]), plain, specs);
    expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual([
      ['Reduction cards: passenger P1 pays less with the card — 120 against 160 without', true, 'fail'],
      ['Reduction cards: passenger P2, who holds no card, pays the same — 160 and 160', true, 'warn'],
    ]);
  });

  test('no reduction fails; another price for the passenger without card is a warning', () => {
    const checks = rc.comparePrices(offerOf([part('P1', 160), part('P2', 150)]), plain, specs);
    expect(checks.map((c) => [c.ok, c.level])).toEqual([[false, 'fail'], [false, 'warn']]);
    expect(checks[0].message).toBe('160 with the card is not below 160 without it');
  });

  test('no counterpart, or no price to compare, is a warning only', () => {
    const first = offerOf([part('P1', 50)], { overallFlexibility: 'SEMI_FLEXIBLE', overallTravelClass: 'FIRST' });
    expect(rc.comparePrices(first, plain, specs)).toEqual([expect.objectContaining({ ok: false, level: 'warn' })]);
    const noPrice = offerOf([{ passengerRefs: ['P1'] }]);
    expect(rc.comparePrices(noPrice, plain, specs)[0]).toMatchObject({ ok: false, level: 'warn' });
  });
});

describe('the steps: checks recorded, 01c asked for once, routing shared', () => {
  const specs = [{ externalRef: 'P1', cards: [card('C1')] }];
  const chosen = offerOf([part('P1', 75, { appliedPassengerTypes: [applied('P1', 'C1')] })]);

  test('checkOfferCards: nothing to do without cards', () => {
    envStore.offerPassengerSpecifications = JSON.stringify([{ externalRef: 'P1' }]);
    let compare;
    const r = run(() => { compare = offers.checkOfferCards('Offer', { compare: true }); });
    expect(compare).toBe(false);
    expect(r.results).toEqual([]);
  });

  test('checkOfferCards: records the applied check, warns for a card the list lacks, asks for 01c once', () => {
    envStore.offerPassengerSpecifications = JSON.stringify(specs);
    envStore.offer = chosen;
    envStore.__reductionCardTypes = JSON.stringify([{ code: 'OTHER', issuer: 'urn:a' }]);
    let compare;
    const r = run(() => { compare = offers.checkOfferCards('Offer', { compare: true }); });
    expect(compare).toBe(true);
    expect(failed(r)).toEqual([]);
    expect(r.logs).toContain("[WARNING] Reduction cards: C1 not in the provider's list (GET /reduction-cards).");
    envStore.__cardPriceCompareDone = 'true';
    run(() => { compare = offers.checkOfferCards('Offer', { compare: true }); });
    expect(compare).toBe(false);
  });

  test('checkOfferCards: an unread list is one warning; the chosen offer can be text', () => {
    envStore.offerPassengerSpecifications = JSON.stringify(specs);
    envStore.offer = JSON.stringify(chosen);
    envStore.__reductionCardTypes = '';
    const r = run(() => offers.checkOfferCards('Inbound offer'));
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([['Inbound offer: the reduction card of passenger P1 is applied (C1)', true]]);
    expect(r.logs.filter((l) => l.startsWith('[WARNING] Reduction cards: the provider\'s list'))).toHaveLength(1);
  });

  test('compareOfferWithoutCards: a failed call is a warning, and the comparison is not asked again', () => {
    envStore.offerPassengerSpecifications = JSON.stringify(specs);
    envStore.offer = chosen;
    const r = run(() => offers.compareOfferWithoutCards(500, null));
    expect(r.results).toEqual([]);
    expect(r.logs[0]).toMatch(/answered 500; prices not compared/);
    expect(envStore.__cardPriceCompareDone).toBe('true');
    const ok = run(() => offers.compareOfferWithoutCards(200, { offers: [offerOf([part('P1', 100)])] }));
    expect(ok.results.map((x) => [x.name, x.ok])).toEqual([['Reduction cards: passenger P1 pays less with the card — 75 against 100 without', true]]);
  });

  test('routeAfterOfferStep: return → 01b with the trip, seat map → 08, otherwise → 02', () => {
    envStore.offer = { ...chosen, tripCoverage: { coveredTripId: 'T1' } };
    envStore.offerId = 'O';
    envStore.returnInboundDate = '2026-11-22T17:00:00';
    offers.routeAfterOfferStep();
    expect([envStore.__next, envStore.outboundOfferId, envStore.outboundTripId]).toEqual(['01b. POST Get Return Offer', 'O', 'T1']);
    envStore.__returnInboundDone = 'true';
    envStore.placeSelectionMode = 'SEATMAP_AT_OFFER';
    envStore.salesFlow_placeSelection = 'true';
    offers.routeAfterOfferStep();
    expect([envStore.__next, envStore['global:skipPlaceMaps']]).toEqual(['08. GET Place Maps', false]);
    envStore.salesFlow_placeSelection = 'false';
    offers.routeAfterOfferStep();
    expect([envStore.__next, envStore['global:skipPlaceMaps']]).toEqual(['02. POST Create Booking', true]);
  });
});

describe('the requests carry the cards', () => {
  test('the parser puts the cards on the offer and booking passengers, and the reset lists name the new variables', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
    const parser = fs.readFileSync(path.join(root, 'library-bruno', 'scenarioParser.js'), 'utf8');
    expect(parser).toMatch(/if \(cards\.length > 0\) offerSpec\.cards = cards;/);
    expect(parser).toMatch(/passengerSpecs\.at\(-1\)\.cards = cards;/);
    for (const file of [path.join(root, 'library-bruno', 'scenarioParser.js'), path.join(root, 'opencollection.yml')]) {
      expect(fs.readFileSync(file, 'utf8')).toMatch(/"__cardPriceCompareDone", "OfferCollectionRequestWithoutCards"/);
    }
  });
});
