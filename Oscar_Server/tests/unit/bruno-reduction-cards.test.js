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
  expectScale: () => {},
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

  // #644: what a card is worth on a tariff is the provider's choice.
  test('no reduction is a warning, not a failure; so is another price for the passenger without card', () => {
    const checks = rc.comparePrices(offerOf([part('P1', 160), part('P2', 150)]), plain, specs);
    expect(checks.map((c) => [c.ok, c.level])).toEqual([[false, 'warn'], [false, 'warn']]);
    expect(checks[0].message).toBe('160 with the card is not below 160 without it (a commercial choice, not an OSDM rule)');
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
    // #652: no reservation part to map, or a booking already there: the run
    // filter would skip 08, and a skipped step routes nowhere.
    offers.routeAfterOfferStep();
    expect(envStore.__next).toBe('02. POST Create Booking');
    envStore.reservationId = 'R1';
    envStore.bookingId = 'B0';
    offers.routeAfterOfferStep();
    expect(envStore.__next).toBe('02. POST Create Booking');
    delete envStore.bookingId;
    offers.routeAfterOfferStep();
    expect([envStore.__next, envStore['global:skipPlaceMaps']]).toEqual(['08. GET Place Maps', false]);
    envStore.salesFlow_placeSelection = 'false';
    offers.routeAfterOfferStep();
    expect([envStore.__next, envStore['global:skipPlaceMaps']]).toEqual(['02. POST Create Booking', true]);
  });
});

describe('#889: a declared reduction rate', () => {
  const specs = [{ externalRef: 'P1', type: 'PERSON', cards: [card('C1')] }, { externalRef: 'P2', type: 'PERSON' }];
  const plain = { offers: [offerOf([part('P1', 35900), part('P2', 35900)])] };

  test('the rates of a passenger list: the first card with a rate, above 0 and at most 100; codes alone have none', () => {
    expect(rc.ratesOfPassengers([
      { reference: '00001', reductionCards: [{ code: 'A' }, { code: 'B', percent: 25 }, { code: 'C', percent: 50 }] },
      { reference: '00002', reductionCards: ['C1'] },
      { reference: '00003', reductionCards: [{ code: 'X', percent: 0 }, { code: 'Y', percent: 101 }, { code: '', percent: 10 }] },
      { reference: '00004', reductionCards: [{ code: 'Z', percent: '12.5' }] },
      { reductionCards: [{ code: 'Q', percent: 10 }] },
      null,
    ])).toEqual({ '00001': 25, '00004': 12.5 });
    expect(rc.ratesOfPassengers(undefined)).toEqual({});
  });

  test('the rate is never sent: the CardReference holds type, code and issuer only', () => {
    expect(rc.cardsOfPassenger({ reductionCards: [{ code: 'C1', issuer: 'urn:x', percent: 25 }] }))
      .toEqual([{ type: 'REDUCTION_CARD', code: 'C1', issuer: 'urn:x' }]);
  });

  test('the price at the rate passes; within the tolerance too (one currency unit, or 1 %)', () => {
    // 359.00 CZK at 25 % off is 269.25: a provider rounding to 269 or 270 passes.
    for (const amount of [26925, 26900, 27000]) {
      const [check] = rc.comparePrices(offerOf([part('P1', amount), part('P2', 35900)]), plain, specs, { P1: 25 });
      expect([check.name, check.ok, check.level]).toEqual([`Reduction cards: passenger P1 pays 25 % less with the card — ${amount} against 35900 without`, true, 'fail']);
    }
  });

  test('another amount fails, saying what was expected; a rate for a passenger without card is ignored', () => {
    const [check, other] = rc.comparePrices(offerOf([part('P1', 25130), part('P2', 35900)]), plain, specs, { P1: 25, P2: 50 });
    expect([check.ok, check.level]).toEqual([false, 'fail']);
    expect(check.message).toBe('25130 with the card; 26925 expected (25 % off, within 359)');
    expect(other.name).toMatch(/P2, who holds no card, pays the same/);
  });

  test('no rate: the check stays "cheaper", as before', () => {
    const [check] = rc.comparePrices(offerOf([part('P1', 25130), part('P2', 35900)]), plain, specs, {});
    expect(check.name).toBe('Reduction cards: passenger P1 pays less with the card — 25130 against 35900 without');
    expect(check.ok).toBe(true);
  });

  test('a group tariff: the rate is told not checked, and the comparison is the old one', () => {
    const checks = rc.comparePrices(offerOf([part('P1', 30000), part('P2', 35900)]), plain, specs, { P1: 25 }, { group: true });
    expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual([
      ['Reduction cards: the declared rate is not checked on a group tariff', true, 'info'],
      ['Reduction cards: passenger P1 pays less with the card — 30000 against 35900 without', true, 'fail'],
      ['Reduction cards: passenger P2, who holds no card, pays the same — 35900 and 35900', true, 'warn'],
    ]);
  });

  test('a price for all (no single-passenger admission): the total against the rates, when the passengers are of one type', () => {
    const both = (amount) => offerOf([{ passengerRefs: ['P1', 'P2'], price: price(amount) }]);
    const together = { ...both(0), passengerRefs: ['P1', 'P2'] };
    const plainBoth = { offers: [{ ...both(71800), passengerRefs: ['P1', 'P2'] }] };
    // 2 × 359.00, one of them 25 % off: 628.25.
    const ok = rc.comparePrices({ ...together, admissionOfferParts: both(62825).admissionOfferParts }, plainBoth, specs, { P1: 25 });
    expect(ok.map((c) => [c.ok, c.level])).toEqual([[false, 'warn'], [true, 'fail']]);
    expect(ok[0].name).toMatch(/passenger P2 can be compared/);
    expect(ok[1].name).toBe('Reduction cards: the offer costs the declared rates less (P1 25 %) — 62825 against 71800 without');
    const wrong = rc.comparePrices({ ...together, admissionOfferParts: both(53850).admissionOfferParts }, plainBoth, specs, { P1: 25 });
    expect(wrong[1]).toMatchObject({ ok: false, level: 'fail' });
    const mixed = [specs[0], { externalRef: 'P2', type: 'CHILD' }];
    const told = rc.comparePrices({ ...together, admissionOfferParts: both(62825).admissionOfferParts }, plainBoth, mixed, { P1: 25 });
    expect(told[1]).toMatchObject({ ok: false, level: 'warn', message: expect.stringMatching(/not all of one type: the rate is not checked/) });
  });

  describe('#895: the answer without cards prices the passengers otherwise', () => {
    // The real provider's 20/10 answers, in its own shape: no overallTravelClass,
    // a service class; with the card each adult alone, without cards the
    // cheapest second-class offer a group tariff for both.
    const basic = { overallFlexibility: 'FULL_FLEXIBLE', overallServiceClass: { type: 'BASIC' } };
    const best = { overallFlexibility: 'FULL_FLEXIBLE', overallServiceClass: { type: 'BEST' } };
    const adults = [{ externalRef: '00001', type: 'ADULT', cards: [card('1')] }, { externalRef: '00002', type: 'ADULT' }];
    const chosen = offerOf([part('00002', 47500), part('00001', 35600)], basic);
    const group = { offerId: 'G', offerSummary: basic, passengerRefs: ['00001', '00002'], admissionOfferParts: [{ passengerRefs: ['00001', '00002'], price: price(94000) }] };
    const firstClass = offerOf([part('00001', 69800), part('00002', 69800)], best);

    test('the holder is compared with the adult without a card in the same offer: 356.00 against 475.00 is 25 % off', () => {
      const checks = rc.comparePrices(chosen, { offers: [group, firstClass] }, adults, { '00001': 25 });
      expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual([[
        'Reduction cards: passenger 00001 pays 25 % less than passenger 00002 (same type, no card) in the same offer — 35600 against 47500',
        true, 'fail',
      ]]);
    });

    test('a wrong price there fails; without a declared rate it must be cheaper', () => {
      const wrong = offerOf([part('00002', 47500), part('00001', 41000)], basic);
      expect(rc.comparePrices(wrong, { offers: [group] }, adults, { '00001': 25 })[0])
        .toMatchObject({ ok: false, level: 'fail', message: '41000 with the card; 35625 expected (25 % off, within 475)' });
      expect(rc.comparePrices(chosen, { offers: [group] }, adults, {})[0])
        .toMatchObject({ ok: true, level: 'fail', name: expect.stringMatching(/^Reduction cards: passenger 00001 pays less than passenger 00002/) });
    });

    test('an offer of another service class is never the counterpart, and one pricing alone is preferred', () => {
      const alone = offerOf([part('00001', 47500), part('00002', 47500)], basic);
      const checks = rc.comparePrices(chosen, { offers: [firstClass, group, alone] }, adults, { '00001': 25 });
      expect(checks.map((c) => [c.name, c.ok])).toEqual([
        ['Reduction cards: passenger 00002, who holds no card, pays the same — 47500 and 47500', true],
        ['Reduction cards: passenger 00001 pays 25 % less with the card — 35600 against 47500 without', true],
      ]);
    });

    test('every passenger holds a card: nothing to compare with, an INFO line, never a failure', () => {
      const both = adults.map((s) => ({ ...s, cards: [card('1')] }));
      expect(rc.comparePrices(chosen, { offers: [group] }, both, { '00001': 25, '00002': 25 })).toEqual([{
        name: 'Reduction cards: the answer without cards prices the passengers otherwise (another product); the card is not compared',
        ok: true, level: 'info',
      }]);
    });

    test('the totals message names each rate once ("P1 25 %", not "25 % %")', () => {
      const both = (amount) => ({ offerId: 'T', offerSummary: basic, passengerRefs: ['00001', '00002'], admissionOfferParts: [{ passengerRefs: ['00001', '00002'], price: price(amount) }] });
      const [, total] = rc.comparePrices(both(83100), { offers: [group] }, adults, { '00001': 25 });
      expect(total.message).toBe('83100 with the card; 82250 expected (00001 25 % off, within 470)');
    });
  });

  test('01c reads the rates the parser kept, and a COLLECTIVE request is a group tariff', () => {
    envStore.offerPassengerSpecifications = JSON.stringify(specs);
    envStore.offer = offerOf([part('P1', 25130), part('P2', 35900)]);
    envStore.__cardRates = JSON.stringify({ P1: 25 });
    let r = run(() => offers.compareOfferWithoutCards(200, plain));
    expect(failed(r)).toEqual(['Reduction cards: passenger P1 pays 25 % less with the card — 25130 against 35900 without']);
    envStore.OfferCollectionRequest = JSON.stringify({ offerSearchCriteria: { offerMode: 'COLLECTIVE' } });
    r = run(() => offers.compareOfferWithoutCards(200, plain));
    expect(failed(r)).toEqual([]);
    expect(r.logs).toContain('[INFO] Reduction cards: the declared rate is not checked on a group tariff');
  });

  test('the parser keeps the rates for 01c', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const parser = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno', 'scenarioParser.js'), 'utf8');
    expect(parser).toContain('bru.setEnvVar("__cardRates", JSON.stringify(ratesOfPassengers(passengersList.passengers)));');
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
      expect(fs.readFileSync(file, 'utf8')).toMatch(/"__cardPriceCompareDone", "__cardRates", "OfferCollectionRequestWithoutCards"/);
    }
  });
});
