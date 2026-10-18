// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * faults.js — errors injected on demand (#833 PR B), to prove that OSCAR's
 * checks catch them and that the AI analysis explains them.
 *
 * A request names the faults it wants answered with, in the header
 * `X-Simulator-Faults: code, code` (the collection sends it for a scenario
 * that sets `simulatorFaults`), or a whole token carries them: the token
 * request asks the scope `sim-faults:code,code`. A code that is not in the
 * catalogue is refused (400 UNKNOWN_FAULT), so a typing mistake never passes
 * for "OSCAR detected nothing".
 *
 * Each fault changes one kind of answer, after it was built and put in the
 * provider's version shapes: the simulator's state is not changed, only what
 * the caller is told. Each names what OSCAR must report (`expect`: the step,
 * a stable part of the check's text, FAIL or WARNING); the detection report
 * (#833 PR D) compares a run with it. `expect` is what the collection said
 * in the replay of the SIM_FAULT_* scenarios (the error faults are seen on
 * the purchaser probe those scenarios run: any refusal would do).
 */

const HEADER = 'x-simulator-faults';
const SCOPE_PREFIX = 'sim-faults:';
const MAX_FAULTS = 20;
const CODE = /^[a-z][a-z0-9-]*\.[a-z0-9-]+$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v : []);

// The route of a request, without its provider: ['bookings', '<id>', 'passengers', '<id>'].
const is = (route, method, pattern) => route.method === method && pattern.length === route.segments.length
  && pattern.every((p, i) => p === '*' || p === route.segments[i]);

const otherCurrency = (currency) => (currency === 'EUR' ? 'CHF' : 'EUR');

const FAULTS = [
  {
    code: 'offer.price-below-parts',
    feature: 'offer',
    title: 'An offer costs less than its admissions',
    detail: 'Each offer\'s minimalPrice is one unit below the sum of its admission prices.',
    applies: (route) => is(route, 'POST', ['offers']),
    answer: (body) => {
      for (const offer of listOf(body.offers)) {
        const sum = listOf(offer.admissionOfferParts).reduce((t, p) => t + (p.price?.amount || 0), 0);
        if (offer.offerSummary?.minimalPrice) offer.offerSummary.minimalPrice.amount = Math.max(0, sum - 1);
      }
    },
    expect: [{ step: '01. POST Get Offer', check: 'Offer minimalPrice >= sum of admission parts price', level: 'FAIL' }],
  },
  {
    code: 'offer.trip-unknown',
    feature: 'offer',
    title: 'An offer covers a trip the answer does not have',
    detail: 'Each offer\'s tripCoverage names a trip id that is not among the trips of the answer.',
    applies: (route) => is(route, 'POST', ['offers']),
    answer: (body) => {
      for (const offer of listOf(body.offers)) if (offer.tripCoverage) offer.tripCoverage.coveredTripId = 'SIM-FAULT-NO-SUCH-TRIP';
    },
    expect: [{ step: '01. POST Get Offer', check: 'is part of Trip ids', level: 'FAIL' }],
  },
  {
    code: 'booking.currency-changed',
    feature: 'booking',
    title: 'The booking is priced in another currency than the offer',
    detail: 'The provisional price of a new booking is in another currency (EUR, else CHF).',
    applies: (route) => is(route, 'POST', ['bookings']),
    answer: (body) => {
      const price = body.booking?.provisionalPrice;
      if (price) price.currency = otherCurrency(price.currency);
    },
    expect: [{ step: '02. POST Create Booking', check: 'booking.provisionalPrice.currency matches offer currency', level: 'FAIL' }],
  },
  {
    code: 'booking.passenger-dropped',
    feature: 'booking',
    title: 'The booking loses a passenger',
    detail: 'The last passenger of a new booking is left out of its passengers.',
    applies: (route) => is(route, 'POST', ['bookings']),
    answer: (body) => { if (Array.isArray(body.booking?.passengers)) body.booking.passengers.pop(); },
    expect: [{ step: '02. POST Create Booking', check: 'Booking contains exactly the expected number of passengers', level: 'FAIL' }],
  },
  {
    code: 'booking.not-prebooked',
    feature: 'booking',
    title: 'A new booking says its admissions are confirmed',
    detail: 'The admissions of a new booking say CONFIRMED instead of PREBOOKED.',
    applies: (route) => is(route, 'POST', ['bookings']),
    answer: (body) => {
      for (const offer of listOf(body.booking?.bookedOffers)) for (const a of listOf(offer.admissions)) a.status = 'CONFIRMED';
    },
    expect: [{ step: '02. POST Create Booking', check: 'Status is PREBOOKED for admission', level: 'FAIL' }],
  },
  {
    code: 'passenger.name-altered',
    feature: 'passenger',
    title: 'A passenger update returns another last name',
    detail: 'The answer to a passenger update gives the last name with "-X" added.',
    applies: (route) => is(route, 'PATCH', ['bookings', '*', 'passengers', '*']),
    answer: (body) => {
      const detail = body.passenger?.detail;
      if (detail && typeof detail.lastName === 'string') detail.lastName += '-X';
    },
    expect: [{ step: '03. PATCH Multi Passenger', check: 'Last name is correct', level: 'FAIL' }],
  },
  {
    code: 'fulfillment.wrong-status',
    feature: 'fulfillment',
    title: 'A confirmation gives fulfilments in a wrong status',
    detail: 'The fulfilments a confirmation gives say REFUNDED.',
    applies: (route) => is(route, 'POST', ['bookings', '*', 'fulfillments']),
    answer: (body) => { for (const f of listOf(body.fulfillments)) f.status = 'REFUNDED'; },
    expect: [{ step: '06. POST Obtaining Fulfillments from Booking', check: 'status comparison', level: 'FAIL' }],
  },
  {
    code: 'refund.amount-above-paid',
    feature: 'refund',
    title: 'A refund offer gives back more than was paid',
    detail: 'Each refund offer\'s refundable amount is ten times what it was.',
    applies: (route) => is(route, 'POST', ['bookings', '*', 'refund-offers']),
    answer: (body) => {
      for (const offer of listOf(body.refundOffers)) {
        if (offer.refundableAmount) offer.refundableAmount.amount = Math.max(1000, offer.refundableAmount.amount * 10);
      }
    },
    expect: [{ step: '10. POST Refund Offers', check: 'Refund response bounds', level: 'FAIL' }],
  },
  {
    code: 'refund.not-refunded',
    feature: 'refund',
    title: 'After a confirmed refund, the booking still shows its tickets valid',
    detail: 'A booking read after a refund gives its REFUNDED fulfilments and parts as FULFILLED.',
    applies: (route) => is(route, 'GET', ['bookings', '*']),
    answer: (body) => {
      const booking = body.booking;
      if (!booking) return;
      for (const f of listOf(booking.fulfillments)) if (f.status === 'REFUNDED') f.status = 'FULFILLED';
      for (const offer of listOf(booking.bookedOffers)) {
        for (const part of [...listOf(offer.admissions), ...listOf(offer.reservations)]) if (part.status === 'REFUNDED') part.status = 'FULFILLED';
      }
    },
    expect: [{ step: '14. GET Booking after Patch Refund', check: 'REFUNDED', level: 'FAIL' }],
  },
  {
    code: 'answer.html',
    feature: 'answer',
    title: 'A gateway answers a booking read with an HTML page',
    detail: 'GET /bookings/{id} answers HTTP 200 with an HTML "Request Rejected" page.',
    applies: (route) => is(route, 'GET', ['bookings', '*']),
    raw: { contentType: 'text/html; charset=utf-8', text: '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>' },
    expect: [
      { step: '05. GET Booking before Fulfillments', check: 'Content-Type is JSON', level: 'FAIL' },
      { step: '05. GET Booking before Fulfillments', check: 'The answer is a JSON object', level: 'FAIL' },
    ],
  },
  {
    code: 'error.problem-without-code',
    feature: 'error',
    title: 'A refusal gives no problem code',
    detail: 'Every error answer (4xx) leaves out its OSDM problem code.',
    problem: (problem) => ({ ...problem, code: undefined }),
    expect: [{ step: '14. POST Booking Purchaser', check: 'the refusal names no OSDM problem code', level: 'WARNING' }],
  },
  {
    code: 'error.server-error-for-refusal',
    feature: 'error',
    title: 'A refusal comes as a server error',
    detail: 'Every client error (4xx) is answered HTTP 500 instead.',
    problem: (problem) => ({ ...problem, status: 500 }),
    expect: [{ step: '14. POST Booking Purchaser', check: 'provider rejects with a client error (4xx)', level: 'FAIL' }],
  },
];

const BY_CODE = new Map(FAULTS.map((f) => [f.code, f]));

class FaultRefusal extends Error {}

// The codes of a header value or a scope: "a, b c" → ['a', 'b', 'c'].
function codesIn(text) {
  return String(text || '').split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
}

/**
 * The faults a request asks for: those of its header and of its token, each
 * once. Throws FaultRefusal for a code that is not in the catalogue, or too
 * many.
 */
function requestedFaults(headerValue, tokenFaults = []) {
  const codes = [...new Set([...codesIn(headerValue), ...listOf(tokenFaults)])];
  if (codes.length > MAX_FAULTS) throw new FaultRefusal(`At most ${MAX_FAULTS} faults.`);
  const unknown = codes.filter((c) => !CODE.test(c) || !BY_CODE.has(c));
  if (unknown.length) {
    throw new FaultRefusal(`Unknown fault(s): ${unknown.slice(0, 5).map((c) => String(c).slice(0, 60)).join(', ')}. Known: ${[...BY_CODE.keys()].join(', ')}.`);
  }
  return codes;
}

/** The faults a token request asks for in its scope ("openid sim-faults:a,b"), checked. */
function scopeFaults(scope) {
  const asked = String(scope || '').split(/\s+/).filter((s) => s.startsWith(SCOPE_PREFIX));
  return requestedFaults(asked.map((s) => s.slice(SCOPE_PREFIX.length)).join(','));
}

/**
 * A successful answer with the faults applied: { body } (changed in place,
 * the answer is the request's own copy), or { raw: { contentType, text } }
 * for an answer that is not JSON.
 */
function faultyAnswer(codes, route, body) {
  for (const code of codes) {
    const fault = BY_CODE.get(code);
    if (!fault?.applies?.(route)) continue;
    if (fault.raw) return { raw: fault.raw };
    if (fault.answer && isObject(body)) fault.answer(body, route);
  }
  return { body };
}

/** An error answer (4xx) with the faults applied: { status, code, title, detail }. */
function faultyProblem(codes, problem) {
  if (problem.status < 400 || problem.status >= 500) return problem;
  return codes.reduce((p, code) => (BY_CODE.get(code)?.problem ? BY_CODE.get(code).problem(p) : p), problem);
}

/** The catalogue as data: what each fault does and what OSCAR must report. */
function catalogue() {
  return FAULTS.map(({ code, feature, title, detail, expect }) => ({ code, feature, title, detail, expect }));
}

module.exports = { HEADER, SCOPE_PREFIX, FAULTS, FaultRefusal, requestedFaults, scopeFaults, faultyAnswer, faultyProblem, catalogue };
