// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-idempotency.test.js — #604: the booking and the confirmation sent
 * again with the same Idempotency-Key give the same answer; the booking with
 * another key gives a new booking.
 */

let envStore = {};
let sent = [];
let answers = [];
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  sendRequest:  (options, callback) => { sent.push(options); answers.shift()(callback); },
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
}));

const idem = require('../../../Bruno_Collection/library-bruno/idempotency.js');
const steps = require('../../../Bruno_Collection/library-bruno/idempotencySteps.js');

beforeEach(() => { envStore = {}; sent = []; answers = []; mockResults = []; mockLogs = []; });

const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);
const booking = (id) => ({ booking: { id } });
const reply = (status, data) => (cb) => cb(null, { status, data });

describe('the checks', () => {
  test('a version 4 UUID', () => {
    const key = idem.uuidFromBytes(Array.from({ length: 16 }, (_, i) => i * 17));
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('the same key: the same booking passes, another booking fails', () => {
    expect(failed(idem.checkBookingReplay(booking('B1'), booking('B1'), 200))).toEqual([]);
    expect(failed(idem.checkBookingReplay(booking('B1'), booking('B2'), 200))).toEqual(['Idempotency-Key, POST /bookings sent again with the same key: the same booking — B1']);
    expect(failed(idem.checkBookingReplay(booking('B1'), null, 409))).toEqual(['Idempotency-Key, POST /bookings sent again with the same key: HTTP status 200 — actual 409']);
  });

  test('another key: a new booking passes, the same booking fails', () => {
    expect(failed(idem.checkBookingOtherKey(booking('B1'), booking('B2'), 200))).toEqual([]);
    expect(failed(idem.checkBookingOtherKey(booking('B1'), booking('B1'), 200))).toEqual(['Idempotency-Key, POST /bookings with another key: a new booking']);
  });

  test('the confirmation: the same fulfillments in any order; none is a failure', () => {
    const f = (...ids) => ({ fulfillments: ids.map((id) => ({ id })) });
    expect(failed(idem.checkFulfillmentReplay(f('F1', 'F2'), f('F2', 'F1'), 200))).toEqual([]);
    expect(failed(idem.checkFulfillmentReplay(f('F1'), f('F9'), 200))).toHaveLength(1);
    expect(failed(idem.checkFulfillmentReplay(f(), f(), 200))).toHaveLength(1);
  });
});

describe('the steps', () => {
  const on = () => ({ idempotencyCheck: 'true', api_base: 'https://p.example', osdmVersion: '3.8.0', access_token: 't', requestor: 'r', bookingId: 'B1', BookingRequest: '{"offers":[]}' });

  test('off: no key on the request, nothing sent again', async () => {
    const req = { setHeader: jest.fn() };
    expect(steps.setIdempotencyKey(req, 'booking')).toBeNull();
    expect(req.setHeader).not.toHaveBeenCalled();
    await steps.checkBookingIdempotency(booking('B1'));
    expect(sent).toEqual([]);
  });

  test('on: the key goes on the request, and the booking is sent again with it, then with another', async () => {
    envStore = on();
    const req = { setHeader: jest.fn() };
    const key = steps.setIdempotencyKey(req, 'booking');
    expect(req.setHeader).toHaveBeenCalledWith('Idempotency-Key', key);
    answers = [reply(200, booking('B1')), reply(200, booking('B2'))];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(sent.map((s) => s.headers['Idempotency-Key'])).toEqual([key, expect.not.stringMatching(key)]);
    expect(sent[0]).toMatchObject({ url: 'https://p.example/bookings', method: 'POST', data: '{"offers":[]}' });
    expect(mockResults.every((r) => r.ok)).toBe(true);
    expect(mockResults).toHaveLength(4);
  });

  test('the confirmation is sent again with its own key; a transport error is a failed status', async () => {
    envStore = on();
    steps.setIdempotencyKey({ setHeader: () => {} }, 'confirmation');
    answers = [(cb) => cb(new Error('ECONNRESET'))];
    await steps.checkConfirmationIdempotency({ fulfillments: [{ id: 'F1' }] });
    expect(sent[0].url).toBe('https://p.example/bookings/B1/fulfillments');
    expect(sent[0].headers['Idempotency-Key']).toBe(envStore.__idempotencyKey_confirmation);
    expect(mockResults).toEqual([expect.objectContaining({ ok: false, message: 'HTTP 0' })]);
  });

  test('a refusal answered as an error with a response is graded on its status', async () => {
    envStore = on();
    answers = [(cb) => cb({ response: { status: 409, data: { code: 'IDEMPOTENCY_KEY_REUSED' } } }), reply(200, booking('B2'))];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(mockResults[0]).toMatchObject({ ok: false, message: 'HTTP 409' });
  });
});

// #693: a provider that books an offer only once refuses the booking with
// another key; new offers are asked for and the booking is made on one.
describe('an offer booked only once (#693)', () => {
  const summary = (flex, cls, amount) => ({ overallFlexibility: flex, overallTravelClass: cls, minimalPrice: { amount } });
  const offer = (id, flex = 'NON_FLEXIBLE', cls = 'SECOND', amount = 100) => ({ offerId: id, offerSummary: summary(flex, cls, amount) });
  const chosen = offer('O1');
  const bookingRequest = {
    offers: [{ offerId: 'O1', passengerRefs: ['P1'], placeSelections: [{ reservationId: 'R1' }], optionalReservationSelections: [{ reservationId: 'R2' }] }],
    passengerSpecifications: [{ externalRef: 'P1' }],
  };
  const env = () => ({
    idempotencyCheck: 'true', api_base: 'https://p.example', osdmVersion: '3.8.0', access_token: 't',
    BookingRequest: JSON.stringify(bookingRequest), OfferCollectionRequest: '{"tripSearchCriteria":{}}', offer: JSON.stringify(chosen),
  });

  test('matchingOffer: same flexibility, class and price, else same kind, else the first', () => {
    expect(idem.matchingOffer(chosen, [offer('A', 'FULL_FLEXIBLE'), offer('B', 'NON_FLEXIBLE', 'SECOND', 90), offer('C')]))
      .toEqual({ offer: offer('C'), how: 'the same flexibility, travel class and price' });
    expect(idem.matchingOffer(chosen, [offer('A', 'FULL_FLEXIBLE'), offer('B', 'NON_FLEXIBLE', 'SECOND', 90)]).offer.offerId).toBe('B');
    expect(idem.matchingOffer(chosen, [offer('A', 'FULL_FLEXIBLE')]).how).toMatch(/^the first offer/);
    expect(idem.matchingOffer(chosen, [])).toBeNull();
    expect(idem.matchingOffer(chosen, [{ summary: 'no id' }])).toBeNull();
  });

  test('bookingOnOffer: the new offer, without the old offer\'s seats; several offers are not made again', () => {
    const r = idem.bookingOnOffer(bookingRequest, 'N1');
    expect(r).toEqual({ body: { offers: [{ offerId: 'N1', passengerRefs: ['P1'] }], passengerSpecifications: [{ externalRef: 'P1' }] }, droppedSelections: true });
    expect(idem.bookingOnOffer({ offers: [{ offerId: 'O1' }] }, 'N1').droppedSelections).toBe(false);
    expect(idem.bookingOnOffer({ offers: [{ offerId: 'O1' }, { offerId: 'O2' }] }, 'N1')).toBeNull();
    expect(bookingRequest.offers[0].offerId).toBe('O1');
  });

  test('refusedWithoutBooking: a 4xx with no booking only', () => {
    expect(idem.refusedWithoutBooking(409, { title: 'already booked' })).toBe(true);
    expect(idem.refusedWithoutBooking(409, booking('B2'))).toBe(false);
    expect(idem.refusedWithoutBooking(500, null)).toBe(false);
    expect(idem.refusedWithoutBooking(200, booking('B2'))).toBe(false);
  });

  test('the step: a warning naming the offer, new offers asked without a key, the booking made on the match', async () => {
    envStore = env();
    answers = [reply(200, booking('B1')), reply(409, { title: 'Offer already booked' }), reply(200, { offers: [offer('X', 'FULL_FLEXIBLE'), offer('N1')] }), reply(200, booking('B3'))];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(sent.map((s) => s.url)).toEqual(['https://p.example/bookings', 'https://p.example/bookings', 'https://p.example/offers', 'https://p.example/bookings']);
    expect(sent[2].headers).not.toHaveProperty('Idempotency-Key');
    expect(sent[2].data).toBe('{"tripSearchCriteria":{}}');
    expect(sent[3].headers['Idempotency-Key']).not.toBe(sent[1].headers['Idempotency-Key']);
    expect(JSON.parse(sent[3].data).offers).toEqual([{ offerId: 'N1', passengerRefs: ['P1'] }]);
    expect(mockLogs.find((l) => l.startsWith('[WARNING]'))).toMatch(/refused \(HTTP 409\) for offer O1, already booked: this provider books an offer only once/);
    expect(mockLogs.some((l) => l.includes('new offer N1, the same flexibility, travel class and price') && l.includes('left out'))).toBe(true);
    expect(mockResults.filter((r) => !r.ok)).toEqual([]);
    expect(mockResults.map((r) => r.name)).toContain('Idempotency-Key, POST /bookings with another key: a new booking');
  });

  test('no offer asked again, or several offers booked: said, and not checked', async () => {
    envStore = env();
    answers = [reply(200, booking('B1')), reply(409, {}), reply(200, { offers: [] })];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(mockLogs.some((l) => l.includes('gave none (HTTP 200)'))).toBe(true);
    expect(mockResults.map((r) => r.name).some((n) => n.includes('with another key'))).toBe(false);

    envStore = { ...env(), BookingRequest: JSON.stringify({ offers: [{ offerId: 'O1' }, { offerId: 'O2' }] }) };
    sent = []; mockLogs = []; mockResults = [];
    answers = [reply(200, booking('B1')), reply(409, {})];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(sent).toHaveLength(2);
    expect(mockLogs.some((l) => l.includes('names several offers'))).toBe(true);
  });

  test('a provider that books an offer twice is checked as before', async () => {
    envStore = env();
    answers = [reply(200, booking('B1')), reply(200, booking('B2'))];
    await steps.checkBookingIdempotency(booking('B1'));
    expect(sent).toHaveLength(2);
    expect(mockLogs.some((l) => l.startsWith('[WARNING]'))).toBe(false);
  });
});
