// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #883: a provider refusing a refund offer request that names several
 * fulfillments; step 10 then asks one refund offer per fulfillment.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const displays = require(path.join(LIB, 'displays.js'));
const {
  problemsOf, refusesSeveralFulfillments, bodiesPerFulfillment, combineAnswers, askOnePerFulfillment,
} = require(path.join(LIB, 'refundPerFulfillment.js'));

// The refusal a real provider gave.
const REFUSAL = {
  code: 'urn:uic:problem:VALUE_NOT_SUPPORTED',
  title: "Only one value (single-element array) is expected for the 'fulfillmentIds' parameter of type array.",
  status: 501,
};

describe('which refusal is the one-fulfillment-per-request kind', () => {
  test('the Problems of an answer', () => {
    expect(problemsOf(REFUSAL)).toEqual([REFUSAL]);
    expect(problemsOf({ problems: [REFUSAL] })).toEqual([REFUSAL]);
    expect(problemsOf(null)).toEqual([]);
  });

  test('several asked, refused (4xx or 501) by a Problem naming fulfillmentIds', () => {
    expect(refusesSeveralFulfillments(501, REFUSAL, ['a', 'b'])).toBe(true);
    expect(refusesSeveralFulfillments(400, { detail: 'too many', pointers: [{ pointer: '/fulfillmentIds' }] }, ['a', 'b'])).toBe(true);
    expect(refusesSeveralFulfillments(400, { problems: [{ title: 'fulfillmentIds: one only' }] }, ['a', 'b'])).toBe(true);
  });

  test('one asked, another reason, another status, or a success: not that refusal', () => {
    expect(refusesSeveralFulfillments(501, REFUSAL, ['a'])).toBe(false);
    expect(refusesSeveralFulfillments(400, { title: 'overrule code not supported' }, ['a', 'b'])).toBe(false);
    expect(refusesSeveralFulfillments(500, REFUSAL, ['a', 'b'])).toBe(false);
    expect(refusesSeveralFulfillments(200, { refundOffers: [] }, ['a', 'b'])).toBe(false);
    expect(refusesSeveralFulfillments(501, 'not json', ['a', 'b'])).toBe(false);
  });
});

describe('the requests one per fulfillment', () => {
  test('one id each, the rest of the body kept', () => {
    expect(bodiesPerFulfillment({ fulfillmentIds: ['a', 'b'], overruleCode: 'TECHNICAL_FAILURE' })).toEqual([
      { fulfillmentIds: ['a'], overruleCode: 'TECHNICAL_FAILURE' },
      { fulfillmentIds: ['b'], overruleCode: 'TECHNICAL_FAILURE' },
    ]);
  });

  test('each takes the refund specifications of its own fulfillment, none when it has none', () => {
    const specs = [{ fulfillmentId: 'a', passengerIds: ['p1'] }];
    expect(bodiesPerFulfillment({ fulfillmentIds: ['a', 'b'], refundSpecifications: specs })).toEqual([
      { fulfillmentIds: ['a'], refundSpecifications: specs },
      { fulfillmentIds: ['b'] },
    ]);
  });

  test('the answers read as one: every refund offer, every problem', () => {
    const one = { refundOffers: [{ id: 'r1' }], problems: [{ code: 'W' }] };
    const two = { refundOffers: { id: 'r2' } };
    expect(combineAnswers([one, two])).toEqual({ refundOffers: [{ id: 'r1' }, { id: 'r2' }], problems: [{ code: 'W' }] });
    expect(combineAnswers([null])).toEqual({ refundOffers: [] });
  });

  test('#893: an offer given again in a later answer is kept once, its latest copy, in the order first seen', () => {
    // The real provider's answers: the second holds the first offer again.
    const first = { refundOffers: [{ id: 'A', fulfillments: [{ id: 'f1' }], status: 'PROPOSED' }] };
    const second = { refundOffers: [{ id: 'A', fulfillments: [{ id: 'f1' }], status: 'PROPOSED', v: 2 }, { id: 'B', fulfillments: [{ id: 'f2' }] }] };
    expect(combineAnswers([first, second])).toEqual({
      refundOffers: [{ id: 'A', fulfillments: [{ id: 'f1' }], status: 'PROPOSED', v: 2 }, { id: 'B', fulfillments: [{ id: 'f2' }] }],
      repeated: 1,
    });
  });

  test('#893: two different offers stay two, even naming one fulfillment; offers without an id are all kept', () => {
    const one = { refundOffers: [{ id: 'A', fulfillments: [{ id: 'f1' }] }, {}] };
    const two = { refundOffers: [{ id: 'B', fulfillments: [{ id: 'f1' }] }, {}] };
    expect(combineAnswers([one, two])).toEqual({ refundOffers: [{ id: 'A', fulfillments: [{ id: 'f1' }] }, {}, { id: 'B', fulfillments: [{ id: 'f1' }] }, {}] });
  });
});

describe('step 10 asks again, one fulfillment at a time', () => {
  let logs;
  let results;
  let sent;

  const setUp = (env, answer) => {
    logs = [];
    results = [];
    sent = [];
    jest.spyOn(displays, 'validationLogger').mockImplementation((line) => { logs.push(line); });
    global.test = (name, fn) => { try { fn(); results.push([name, 'pass']); } catch (e) { results.push([name, 'fail', e.message]); } };
    global.bru = {
      getEnvVar: (k) => env[k],
      sendRequest: (req, cb) => {
        sent.push({ url: req.url, method: req.method, body: JSON.parse(req.data) });
        cb(null, answer(JSON.parse(req.data)));
      },
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.bru;
    delete global.test;
  });

  const env = {
    api_base: 'https://provider.example/osdm',
    bookingId: 'B1',
    osdmVersion: '3.8.0',
    access_token: 'tok',
    requestRefundOffersBodyData: JSON.stringify({ fulfillmentIds: ['f1', 'f2'], overruleCode: 'TECHNICAL_FAILURE' }),
  };

  test('refused: one WARNING, one request per fulfillment, the offers together', async () => {
    setUp(env, (body) => ({ status: 200, data: { refundOffers: [{ id: `ro-${body.fulfillmentIds[0]}` }] } }));
    const out = await askOnePerFulfillment(501, REFUSAL);
    expect(sent).toEqual([
      { url: 'https://provider.example/osdm/bookings/B1/refund-offers', method: 'POST', body: { fulfillmentIds: ['f1'], overruleCode: 'TECHNICAL_FAILURE' } },
      { url: 'https://provider.example/osdm/bookings/B1/refund-offers', method: 'POST', body: { fulfillmentIds: ['f2'], overruleCode: 'TECHNICAL_FAILURE' } },
    ]);
    expect(out).toEqual({ status: 200, body: { refundOffers: [{ id: 'ro-f1' }, { id: 'ro-f2' }] } });
    expect(results).toEqual([
      ['Refund offer request for fulfillment f1 alone — HTTP 200', 'pass'],
      ['Refund offer request for fulfillment f2 alone — HTTP 200', 'pass'],
    ]);
    expect(logs.filter((l) => l.startsWith('[WARNING]'))).toHaveLength(1);
    expect(logs[0]).toMatch(/refuses a request naming 2 fulfillments \(HTTP 501: "Only one value/);
  });

  test('#893: each answer holding the offers before it: each offer counted once, one INFO line', async () => {
    const given = [];
    setUp(env, (body) => {
      given.push({ id: `ro-${body.fulfillmentIds[0]}` });
      return { status: 200, data: { refundOffers: given.map((o) => ({ ...o })) } };
    });
    const out = await askOnePerFulfillment(501, REFUSAL);
    expect(out).toEqual({ status: 200, body: { refundOffers: [{ id: 'ro-f1' }, { id: 'ro-f2' }] } });
    expect(logs).toContain('[INFO] Refund offers: 1 refund offer(s) came again in the answer for a later fulfillment; each is counted once.');
    expect(logs).toContain('[INFO] Refund offers asked one fulfillment at a time: 2 refund offer(s) for 2 fulfillments.');
  });

  test('a request of one fulfillment refused: its answer is graded, the rest not asked', async () => {
    setUp(env, () => ({ status: 409, data: { code: 'CONFLICT', title: 'already refunded' } }));
    const out = await askOnePerFulfillment(501, REFUSAL);
    expect(sent).toHaveLength(1);
    expect(out).toEqual({ status: 409, body: { code: 'CONFLICT', title: 'already refunded' } });
    expect(results).toEqual([['Refund offer request for fulfillment f1 alone — HTTP 200', 'fail', 'HTTP 409 received, expected 200']]);
  });

  test('any other answer: nothing sent, nothing logged', async () => {
    setUp(env, () => { throw new Error('not sent'); });
    expect(await askOnePerFulfillment(200, { refundOffers: [{ id: 'x' }] })).toBeNull();
    expect(await askOnePerFulfillment(400, { title: 'overrule code not supported' })).toBeNull();
    expect(sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('step 10 grades the status and the body it returns', () => {
    const step = fs.readFileSync(path.join(LIB, '..', '03-Refund', '10. POST Refund Offers.yml'), 'utf8');
    const ask = step.indexOf('refundPerFulfillment.js").askOnePerFulfillment(_status, _answer)');
    expect(ask).toBeGreaterThan(step.indexOf('overruleRejectionArmed()'));
    expect(ask).toBeLessThan(step.indexOf('// Validate HTTP response status'));
    expect(step).toContain('jsonData = _perFulfillment ? _perFulfillment.body : res.getBody();');
    expect(step).not.toMatch(/if \(res\.getStatus\(\) !== 200\)/);
  });
});
