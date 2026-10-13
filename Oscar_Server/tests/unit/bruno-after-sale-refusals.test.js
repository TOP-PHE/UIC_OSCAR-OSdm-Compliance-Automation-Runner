// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-after-sale-refusals.test.js — #700: a refunded ticket refunded or
 * exchanged again, and a booking confirmed twice.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');
const probes = require(path.join(LIB, 'afterSaleRefusals.js'));

// Runs a probe with bru faked: `answer(url, body)` gives { status, data }.
async function run(vars, answer, fn) {
  const tests = [];
  const logs = [];
  const sent = [];
  global.bru = {
    getEnvVar: (k) => vars[k],
    setEnvVar: (k, v) => { vars[k] = v; },
    sendRequest: (req, cb) => {
      sent.push({ url: req.url, body: JSON.parse(req.data), headers: req.headers });
      const r = answer(req.url, JSON.parse(req.data));
      cb(null, { status: r.status, data: r.data });
    },
  };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { await fn(); return { tests, logs, sent }; } finally {
    delete global.bru; delete global.test;
  }
}

const base = { api_base: 'https://p.example/api', bookingId: 'B1', osdmVersion: '3.8.0', access_token: 't' };
const refundedBooking = { fulfillments: [{ id: 'F1', status: 'REFUNDED' }, { id: 'F2', status: 'FULFILLED' }] };
const problem = { status: 409, data: { title: 'Conflict', detail: 'already refunded' } };
const failed = (r) => r.tests.filter(t => t[1] === 'fail');

describe('a refunded ticket refunded or exchanged again', () => {
  test('off: nothing is sent', async () => {
    const r = await run({ ...base }, () => problem, () => probes.probeRefundedFulfillments(refundedBooking));
    expect(r.sent).toEqual([]);
  });

  test('refund again: the refunded fulfillments only; a 4xx Problem passes, a 200 fails', async () => {
    const ok = await run({ ...base, refundAgainProbe: 'true' }, () => problem, () => probes.probeRefundedFulfillments(refundedBooking));
    expect(ok.sent.map(s => [s.url, s.body])).toEqual([['https://p.example/api/bookings/B1/refund-offers', { fulfillmentIds: ['F1'] }]]);
    expect(failed(ok)).toEqual([]);
    const bad = await run({ ...base, refundAgainProbe: 'true' }, () => ({ status: 200, data: { refundOffers: [{}] } }),
      () => probes.probeRefundedFulfillments(refundedBooking));
    expect(failed(bad)[0][0]).toMatch(/Refund again.*client error/);
    const server = await run({ ...base, refundAgainProbe: 'true' }, () => ({ status: 500, data: {} }),
      () => probes.probeRefundedFulfillments(refundedBooking));
    expect(failed(server).length).toBeGreaterThan(0);
  });

  test('exchange a refunded ticket: the exchange request names the refunded fulfillments', async () => {
    const vars = {
      ...base, exchangeRefundedProbe: 'true',
      offerPassengerSpecifications: JSON.stringify([{ externalRef: '00001', dateOfBirth: '1990-01-01', type: 'PERSON' }]),
      offerTripSearchCriteria: JSON.stringify({ origin: 'A' }), offerSearchCriteria: '{}', fulfillmentIds: JSON.stringify(['F1', 'F2']),
    };
    const ok = await run(vars, () => problem, () => probes.probeRefundedFulfillments(refundedBooking));
    expect(ok.sent).toHaveLength(1);
    expect(ok.sent[0].url).toBe('https://p.example/api/bookings/B1/exchange-offers');
    expect(ok.sent[0].body.fulfillmentIds).toEqual(['F1']);
    expect(ok.sent[0].body.tripSearchCriteria).toEqual({ origin: 'A' });
    expect(failed(ok)).toEqual([]);
    const bad = await run({ ...vars }, () => ({ status: 200, data: { exchangeOffers: [{}] } }), () => probes.probeRefundedFulfillments(refundedBooking));
    expect(failed(bad)[0][0]).toMatch(/Exchange a refunded ticket.*client error/);
  });

  test('nothing refunded: a warning, nothing sent', async () => {
    const r = await run({ ...base, refundAgainProbe: 'true' }, () => problem,
      () => probes.probeRefundedFulfillments({ fulfillments: [{ id: 'F1', status: 'FULFILLED' }] }));
    expect(r.sent).toEqual([]);
    expect(r.logs.some(l => /nothing to refund or exchange again/.test(l))).toBe(true);
  });
});

describe('a booking confirmed twice', () => {
  const first = { fulfillments: [{ id: 'F1' }, { id: 'F2' }] };

  test('the outcome, from the two answers', () => {
    expect(probes.confirmAgainOutcome(['F1', 'F2'], 200, first)).toBe('same');
    expect(probes.confirmAgainOutcome(['F1', 'F2'], 200, { booking: { fulfillments: [{ id: 'F2' }] } })).toBe('same');
    expect(probes.confirmAgainOutcome(['F1', 'F2'], 200, { fulfillments: [{ id: 'F3' }] })).toBe('new');
    expect(probes.confirmAgainOutcome(['F1'], 409, {})).toBe('refused');
    expect(probes.confirmAgainOutcome(['F1'], 500, {})).toBe('error');
    expect(probes.confirmAgainOutcome(['F1'], 0, null)).toBe('error');
  });

  test('the same tickets pass; a refusal passes as a graded Problem; new tickets fail', async () => {
    const same = await run({ ...base, confirmAgainProbe: 'true' }, () => ({ status: 200, data: first }), () => probes.probeConfirmAgain(first));
    expect(same.sent.map(s => [s.url, s.body, s.headers['Idempotency-Key']])).toEqual([['https://p.example/api/bookings/B1/fulfillments', {}, undefined]]);
    expect(failed(same)).toEqual([]);
    const refused = await run({ ...base, confirmAgainProbe: 'true' }, () => problem, () => probes.probeConfirmAgain(first));
    expect(failed(refused)).toEqual([]);
    expect(refused.tests.some(t => /Confirm again \[refused\]: provider rejects/.test(t[0]))).toBe(true);
    const fresh = await run({ ...base, confirmAgainProbe: 'true' }, () => ({ status: 200, data: { fulfillments: [{ id: 'F9' }] } }), () => probes.probeConfirmAgain(first));
    expect(failed(fresh)[0][2]).toMatch(/issued new fulfillments: first \[F1, F2\], then \[F9\]/);
  });

  test('off: nothing is sent', async () => {
    const r = await run({ ...base }, () => ({ status: 200, data: first }), () => probes.probeConfirmAgain(first));
    expect(r.sent).toEqual([]);
  });
});
