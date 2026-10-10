// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-products.test.js — #598: the product (tariff) a scenario expects.
 *
 * Before, an offer was chosen on its flexibility only, and nothing looked at
 * its product. Now `expectedProduct` names a product by code, or by words of
 * its name; the offer step keeps the offers that hold it and stops the
 * scenario when none does, and the fulfilled booking must hold it.
 */

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

const products = require('../../../Bruno_Collection/library-bruno/products.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

beforeEach(() => { envStore = {}; mockResults = []; });

const product = (code, summary, extra = {}) => ({ id: `PRD-${code}`, code, summary, owner: 'urn:x', flexibility: 'FULL_FLEXIBLE', ...extra });
const offer = (id, prd, flexibility = 'FULL_FLEXIBLE') => ({
  offerId: id,
  offerSummary: { overallFlexibility: flexibility, overallTravelClass: 'SECOND' },
  products: [prd],
  admissionOfferParts: [{ id: `${id}-A`, summaryProductId: prd.id, passengerRefs: ['P1'] }],
});
const basic = product('FLEXI_BASIC', 'Flexi basic');
const allDay = product('ALL_DAY', 'All-day ticket');
const saver = product('FLEXI_SAVER', 'Flexi saver', { flexibility: 'SEMI_FLEXIBLE' });
const answer = [offer('O1', basic), offer('O2', allDay), offer('O3', saver, 'SEMI_FLEXIBLE')];

describe('matching a product by code, else by name', () => {
  test('an exact code wins; otherwise words of the summary or description, without case', () => {
    expect(products.matchingProducts([basic, allDay], 'ALL_DAY')).toEqual([allDay]);
    expect(products.matchingProducts([basic, allDay], ' all-day ')).toEqual([allDay]);
    expect(products.matchingProducts([basic, saver], 'flexi')).toEqual([basic, saver]);
    expect(products.matchingProducts([product('X', 'x', { description: 'Valid all day long' })], 'ALL DAY')).toHaveLength(1);
    expect(products.matchingProducts([basic], '')).toEqual([]);
    expect(products.matchingProducts(null, 'x')).toEqual([]);
  });

  test('a code match anywhere in the answer keeps a name from pulling in other offers', () => {
    const named = product('SAVER_2', 'Not the FLEXI_SAVER');
    expect(products.offersWithProduct([...answer, offer('O4', named)], 'FLEXI_SAVER').map((o) => o.offerId)).toEqual(['O3']);
    expect(products.offersWithProduct(answer, 'flexi').map((o) => o.offerId)).toEqual(['O1', 'O3']);
    expect(products.offersWithProduct(answer, 'GROUP')).toEqual([]);
  });

  test('offeredProducts lists each product once, code and name', () => {
    expect(products.offeredProducts([...answer, offer('O5', basic)])).toEqual(['FLEXI_BASIC (Flexi basic)', 'ALL_DAY (All-day ticket)', 'FLEXI_SAVER (Flexi saver)']);
  });
});

describe('the offer step chooses the offer holding the product', () => {
  const select = () => withBrunoExpect(() => offers.selectAndSetOffer({ offers: answer, trips: [] }));

  test('the product narrows the choice before the flexibility', () => {
    envStore.expectedProduct = 'ALL_DAY';
    envStore.desiredFlexibility = 'FULL_FLEXIBLE';
    select();
    expect(envStore.offerId).toBe('O2');
    expect(mockResults.find((r) => r.name.startsWith('Offer: an offer holds the expected product'))).toMatchObject({ ok: true, name: 'Offer: an offer holds the expected product "ALL_DAY" — 1 offer(s)' });
    expect(envStore.__productNotOffered).toBeUndefined();
  });

  test('without the product the check fails, lists what was offered, and the step is told to stop', () => {
    envStore.expectedProduct = 'GROUP';
    select();
    const check = mockResults.find((r) => r.name.startsWith('Offer: an offer holds the expected product'));
    expect(check.ok).toBe(false);
    expect(check.message).toBe('no offer holds it; offered: [FLEXI_BASIC (Flexi basic), ALL_DAY (All-day ticket), FLEXI_SAVER (Flexi saver)]');
    expect(envStore.__productNotOffered).toBe('true');
  });

  test('#599 expected absent: none holding it passes, one holding it fails naming it; the step stops either way', () => {
    envStore.expectedProduct = 'GROUP';
    envStore.expectedProductAbsent = 'true';
    select();
    const absent = mockResults.find((r) => r.name.startsWith('Offer: no offer holds the product'));
    expect(absent).toMatchObject({ ok: true, name: 'Offer: no offer holds the product "GROUP", as the scenario expects — 0 offer(s)' });
    expect(envStore.__productNotOffered).toBe('true');
    envStore = { expectedProduct: 'ALL_DAY', expectedProductAbsent: 'true' };
    mockResults = [];
    select();
    expect(mockResults.find((r) => r.name.startsWith('Offer: no offer holds the product'))).toMatchObject({ ok: false, message: 'offered by: [O2]' });
    expect(mockResults.some((r) => r.name.startsWith('Offer: an offer holds'))).toBe(false);
    expect(envStore.__productNotOffered).toBe('true');
  });

  test('no expected product: chosen on the flexibility as before, no product check', () => {
    envStore.desiredFlexibility = 'SEMI_FLEXIBLE';
    select();
    expect(envStore.offerId).toBe('O3');
    expect(mockResults.some((r) => r.name.startsWith('Offer: an offer holds'))).toBe(false);
  });
});

describe('the fulfilled booking holds the product', () => {
  const booking = (prd, partProduct = prd.id) => ({
    bookedOffers: [{ products: [prd], admissions: [{ id: 'A1', summaryProductId: partProduct }, { id: 'A2', products: [{ productId: partProduct }] }] }],
    fulfillments: [{ id: 'F1', bookingParts: [{ id: 'A1' }] }, { id: 'F2', bookingParts: [{ id: 'A2' }] }],
  });

  test('a booked offer with the product and fulfillments covering its parts pass', () => {
    const checks = products.checkBookingProduct(booking(allDay), 'ALL_DAY');
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['Booking: a booked offer holds the expected product "ALL_DAY"', true],
      ['Fulfillment F1: covers a part of the expected product "ALL_DAY"', true],
      ['Fulfillment F2: covers a part of the expected product "ALL_DAY"', true],
    ]);
  });

  test('another product booked fails once, naming what was booked', () => {
    const checks = products.checkBookingProduct(booking(basic), 'ALL_DAY');
    expect(checks).toEqual([{ name: 'Booking: a booked offer holds the expected product "ALL_DAY"', ok: false, message: 'booked products: [FLEXI_BASIC (Flexi basic)]' }]);
  });

  test('a fulfillment whose parts name another product fails', () => {
    const checks = products.checkBookingProduct(booking(allDay, 'PRD-OTHER'), 'ALL_DAY');
    expect(checks.slice(1).map((c) => [c.ok, c.message])).toEqual([
      [false, 'its booking parts name products [PRD-OTHER]'],
      [false, 'its booking parts name products [PRD-OTHER]'],
    ]);
  });
});

describe('the steps and the parser', () => {
  test('01 and 01b stop on __productNotOffered; 07 checks the booking; both reset lists name the variables', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
    const step = (name) => fs.readFileSync(path.join(root, '02-Common Requests', name), 'utf8');
    expect(step('01. POST Get Offer.yml')).toMatch(/__productNotOffered[\s\S]*loopbackOrStop\("POST Get Offer \(expected product check\)"\)/);
    expect(step('01b. POST Get Return Offer.yml')).toMatch(/__productNotOffered[\s\S]*loopbackOrStop\("POST Get Return Offer \(expected product check\)"\)/);
    expect(step('07. GET Booking after Fulfillments.yml')).toMatch(/checkBookingProduct\(/);
    for (const file of [path.join(root, 'library-bruno', 'scenarioParser.js'), path.join(root, 'opencollection.yml')]) {
      expect(fs.readFileSync(file, 'utf8')).toMatch(/"expectedProduct", "__productNotOffered", "expectedProductAbsent", "__groupPriceCompareDone", "OfferCollectionRequestIndividual"/);
    }
  });
});
