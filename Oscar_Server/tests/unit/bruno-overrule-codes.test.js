// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-overrule-codes.test.js — #596: a technical cancellation (a refund
 * requested with an overrule code).
 *
 * With a code, the provider gives back what was paid and keeps no fee. When it
 * answers with one refund offer per fulfillment, the offers together must give
 * back the price. A code the provider does not support must be refused with a
 * Problem when the scenario says so (overruleCodeExpectRejection).
 */

const { withBrunoExpect } = require('../helpers/bruno-chai.js');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const failed = (r) => r.results.filter((x) => !x.ok).map((x) => x.name);

beforeEach(() => { envStore = {}; });

const price = (amount) => ({ amount, currency: 'CZK', scale: 2 });
const offer = (id, refundable, fee = 0) => ({ id, refundableAmount: price(refundable), refundFee: price(fee) });

describe('checkOverruleTotal: the refund offers together give back what was paid', () => {
  beforeEach(() => {
    envStore.overruleCode = 'TECHNICAL_FAILURE';
    envStore.confirmedPriceAmount = 1850;
  });

  test('two offers summing to the price pass', () => {
    const r = run(() => refunds.checkOverruleTotal([offer('O1', 1000), offer('O2', 850)]));
    expect(r.results.map((x) => x.name)).toEqual([
      'Refund WITH overrule (TECHNICAL_FAILURE): the 2 refund offers together give back what was paid — 1850 of 1850',
    ]);
    expect(failed(r)).toEqual([]);
  });

  test('two offers that keep part of the price fail, naming the code', () => {
    const r = run(() => refunds.checkOverruleTotal([offer('O1', 1000), offer('O2', 637, 213)]));
    expect(failed(r)).toHaveLength(1);
    expect(r.results[0].message).toMatch(/did NOT honour overrule\(TECHNICAL_FAILURE\): the refund offers give back 1637, the booking's confirmedPrice was 1850/);
  });

  test('an offer without an amount fails rather than being counted as zero', () => {
    const r = run(() => refunds.checkOverruleTotal([offer('O1', 1850), { id: 'O2', refundFee: price(0) }]));
    expect(r.results[0].message).toMatch(/has no refundableAmount.amount/);
  });

  test('the price kept as text in the environment is compared as a number', () => {
    envStore.confirmedPriceAmount = '1850';
    expect(failed(run(() => refunds.checkOverruleTotal([offer('O1', 1000), offer('O2', 850)])))).toEqual([]);
  });

  test('nothing to check: one offer, no code, the no-code placeholder, or a partial refund', () => {
    const two = [offer('O1', 1), offer('O2', 1)];
    expect(run(() => refunds.checkOverruleTotal([offer('O1', 1)])).results).toEqual([]);
    for (const code of [undefined, null, 'null', 'CODE_DOES_NOT_EXIST']) {
      envStore.overruleCode = code;
      expect(run(() => refunds.checkOverruleTotal(two)).results).toEqual([]);
    }
    envStore.overruleCode = 'TECHNICAL_FAILURE';
    envStore.partialRefundByFulfillment = 'true';
    expect(run(() => refunds.checkOverruleTotal(two)).results).toEqual([]);
    // A partial refund that degraded to a full one is checked again.
    envStore.__partialRefundDegradedToFull = 'true';
    expect(run(() => refunds.checkOverruleTotal(two)).results).toHaveLength(1);
  });
});

describe('the overrule code probe (overruleCodeExpectRejection)', () => {
  test('armed only when the flag is on and a code is sent; a flag without a code is ignored with a warning', () => {
    envStore.overruleCodeExpectRejection = 'true';
    envStore.overruleCode = 'STRIKE';
    expect(refunds.overruleRejectionArmed()).toBe(true);
    envStore.overruleCodeExpectRejection = 'false';
    expect(refunds.overruleRejectionArmed()).toBe(false);
    envStore.overruleCodeExpectRejection = 'true';
    envStore.overruleCode = null;
    let armed;
    const r = run(() => { armed = refunds.overruleRejectionArmed(); });
    expect(armed).toBe(false);
    expect(r.logs.some((l) => l.startsWith('[WARNING] Overrule code probe: the scenario expects a refusal but sends no overrule code'))).toBe(true);
  });

  test('a 400 Problem naming the code passes every check', () => {
    envStore.overruleCode = 'STRIKE';
    const r = run(() => refunds.checkOverruleRejected(400, {
      code: 'OVERRULE_CODE_NOT_SUPPORTED', title: 'Overrule code not supported', detail: 'overruleCode "STRIKE" is not accepted.',
    }));
    expect(r.results.map((x) => x.name)).toEqual([
      '🧪 Overrule code probe [STRIKE]: provider rejects with a client error (4xx)',
      '🧪 Overrule code probe [STRIKE]: error body is an RFC-9457 Problem (title/detail/code present)',
    ]);
    expect(failed(r)).toEqual([]);
    expect(r.logs).toContain('[INFO] 🧪 Overrule code probe: error identifies the offending field.');
  });

  test('a provider that accepts the code fails the probe, and is told its offers stay proposed', () => {
    envStore.overruleCode = 'STRIKE';
    const r = run(() => refunds.checkOverruleRejected(200, { refundOffers: [offer('O1', 1850)] }));
    expect(failed(r)).toEqual(['🧪 Overrule code probe [STRIKE]: provider rejects with a client error (4xx)']);
    expect(r.logs.some((l) => l.startsWith("[WARNING] Overrule code probe: the provider accepted 'STRIKE'"))).toBe(true);
  });

  test('a server error is not a refusal, and a bare error body fails the Problem check', () => {
    envStore.overruleCode = 'STRIKE';
    expect(failed(run(() => refunds.checkOverruleRejected(500, { code: 'X', title: 'Internal' }))))
      .toEqual(['🧪 Overrule code probe [STRIKE]: provider rejects with a client error (4xx)']);
    expect(failed(run(() => refunds.checkOverruleRejected(400, null))))
      .toEqual(['🧪 Overrule code probe [STRIKE]: error body is an RFC-9457 Problem (title/detail/code present)']);
  });

  test('a refusal that does not name the field is a warning, not a failure', () => {
    envStore.overruleCode = 'STRIKE';
    const r = run(() => refunds.checkOverruleRejected(400, { title: 'Bad request' }));
    expect(failed(r)).toEqual([]);
    expect(r.logs.some((l) => l.startsWith('[WARNING] 🧪 Overrule code probe: error does not clearly identify the offending field (overruleCode)'))).toBe(true);
  });
});

describe('the scenario parser carries the probe flag and resets it', () => {
  test('both reset lists name it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
    expect(fs.readFileSync(path.join(root, 'library-bruno', 'scenarioParser.js'), 'utf8')).toMatch(/"overruleCode", "overruleCodeExpectRejection"/);
    expect(fs.readFileSync(path.join(root, 'opencollection.yml'), 'utf8')).toMatch(/"overruleCode", "overruleCodeExpectRejection"/);
  });
});
