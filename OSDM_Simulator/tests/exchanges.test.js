// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #611: the exchange of a confirmed booking, on a provider with `exchange`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const [alphaOne] = SECRETS.alpha;
const [gammaOne] = SECRETS.gamma;

// A booking of one offer of the flexibility asked, confirmed unless told not to.
async function booked(provider, flexibility = 'FULL_FLEXIBLE', { confirm = true } = {}) {
  const token = await tokenFor(sim.base, provider, provider === 'gamma' ? gammaOne : alphaOne);
  const offers = (await call(sim.base, token, 'POST', `/${provider}/offers`, offerRequest())).body.offers;
  const offer = offers.find((o) => o.offerSummary.overallFlexibility === flexibility);
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, bookingRequest(offer))).body.booking;
  const base = `/${provider}/bookings/${booking.id}`;
  const fulfillments = confirm ? (await call(sim.base, token, 'POST', `${base}/fulfillments`, {})).body.fulfillments : [];
  return { token, booking, fulfillments, base };
}

const exchangeRequest = (fulfillmentIds, extra = {}) => ({ ...offerRequest(), fulfillmentIds, ...extra });
const partsOf = (booking) => booking.bookedOffers.flatMap((o) => [...o.admissions, ...(o.reservations || [])]);

test('exchange: a provider without it answers 501', async () => {
  const { token, base, fulfillments } = await booked('alpha');
  const res = await call(sim.base, token, 'POST', `${base}/exchange-offers`, exchangeRequest([fulfillments[0].id]));
  assert.equal(res.status, 501);
  assert.equal((await call(sim.base, token, 'POST', `${base}/exchange-operations`, {})).status, 501);
});

test('exchange: offers priced against what is given up, then pre-booked, then confirmed', async () => {
  const { token, booking, base, fulfillments } = await booked('gamma');
  const given = fulfillments.map((f) => f.id);
  const res = await call(sim.base, token, 'POST', `${base}/exchange-offers`, exchangeRequest(given));
  assert.equal(res.status, 200);
  const paid = booking.provisionalPrice.amount;
  for (const offer of res.body.exchangeOffers) {
    for (const field of ['offerId', 'createdOn', 'preBookableUntil', 'exchangePrice', 'exchangeFee', 'passengerRefs', 'fulfillments', 'admissionOfferParts']) assert.ok(offer[field], field);
    assert.equal(offer.exchangeFee.amount, 0, 'a fully flexible ticket is exchanged without a fee');
    const balance = offer.exchangePrice.amount + offer.exchangeFee.amount - paid;
    if (balance >= 0) assert.equal(offer.amountToBePaid.amount, balance);
    else assert.equal(offer.refundableAmount.amount, -balance);
    assert.deepEqual(offer.fulfillments.map((f) => [f.id, f.status]), fulfillments.map((f) => [f.id, 'FULFILLED']));
  }
  const chosen = res.body.exchangeOffers[0];

  const op = await call(sim.base, token, 'POST', `${base}/exchange-operations`, { exchangeOffers: [{ offerId: chosen.offerId, passengerRefs: chosen.passengerRefs }] });
  assert.equal(op.status, 200);
  assert.equal(op.body.exchangeOperation.status, 'PREBOOKED');
  assert.equal(op.body.exchangeOperation.exchangeOffers[0].offerId, chosen.offerId);
  const during = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.ok(partsOf(during).every((p) => p.status === 'EXCHANGE_ONGOING'));
  assert.equal(JSON.stringify(during).includes('exchangeOperations'), false, 'the exchange state is not part of the booking');
  const again = await call(sim.base, token, 'POST', `${base}/exchange-operations`, { exchangeOffers: [{ offerId: chosen.offerId }] });
  assert.equal(again.status, 409, 'one pre-booked exchange at a time');
  const read = await call(sim.base, token, 'GET', `${base}/exchange-operations/${op.body.exchangeOperation.id}`);
  assert.deepEqual(read.body.exchangeOperation, op.body.exchangeOperation);

  const confirmed = await call(sim.base, token, 'POST', `${base}/fulfillments`, {});
  assert.equal(confirmed.status, 200);
  const statuses = confirmed.body.fulfillments.map((f) => f.status);
  assert.deepEqual(statuses, [...given.map(() => 'EXCHANGED'), 'FULFILLED']);
  const after = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.equal(after.bookedOffers.length, 2);
  assert.ok(after.bookedOffers[0].admissions.every((p) => p.status === 'EXCHANGED'));
  assert.ok(after.bookedOffers[1].admissions.every((p) => p.status === 'FULFILLED'));
  assert.equal(after.bookedOffers[1].offerId, chosen.offerId);
  assert.equal(after.confirmedPrice.amount, chosen.exchangePrice.amount + chosen.exchangeFee.amount);
  assert.equal((await call(sim.base, token, 'GET', `${base}/exchange-operations/${op.body.exchangeOperation.id}`)).body.exchangeOperation.status, 'CONFIRMED');
  const withdraw = await fetch(`${sim.base}${base}/exchange-operations/${op.body.exchangeOperation.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(withdraw.status, 409, 'a confirmed exchange cannot be withdrawn');
  const twice = await call(sim.base, token, 'POST', `${base}/exchange-offers`, exchangeRequest(given));
  assert.equal(twice.status, 409, 'an exchanged ticket cannot be exchanged again');
});

test('exchange: withdrawn while pre-booked, the booking keeps its ticket', async () => {
  const { token, base, fulfillments } = await booked('gamma');
  const [chosen] = (await call(sim.base, token, 'POST', `${base}/exchange-offers`, exchangeRequest([fulfillments[0].id]))).body.exchangeOffers;
  const op = (await call(sim.base, token, 'POST', `${base}/exchange-operations`, { exchangeOffers: [{ offerId: chosen.offerId }] })).body.exchangeOperation;
  const removed = await fetch(`${sim.base}${base}/exchange-operations/${op.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(removed.status, 204);
  assert.equal((await call(sim.base, token, 'GET', `${base}/exchange-operations/${op.id}`)).status, 404);
  const booking = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.ok(partsOf(booking).every((p) => p.status === 'FULFILLED'));
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['FULFILLED']);
  assert.equal(booking.bookedOffers.length, 1);
});

test('exchange: the fee follows the exchangeability of what is given up; an overrule code waives it', async () => {
  const semi = await booked('gamma', 'SEMI_FLEXIBLE');
  const part = partsOf(semi.booking)[0];
  assert.equal(part.exchangeable, 'WITH_CONDITION');
  const [offer] = (await call(sim.base, semi.token, 'POST', `${semi.base}/exchange-offers`, exchangeRequest([semi.fulfillments[0].id]))).body.exchangeOffers;
  assert.equal(offer.exchangeFee.amount, Math.round(part.price.amount * 0.25));
  const waived = (await call(sim.base, semi.token, 'POST', `${semi.base}/exchange-offers`,
    exchangeRequest([semi.fulfillments[0].id], { overruleCode: 'TECHNICAL_FAILURE' }))).body.exchangeOffers[0];
  assert.equal(waived.exchangeFee.amount, 0);
  assert.equal(waived.appliedOverruleCode, 'TECHNICAL_FAILURE');
  const refused = await call(sim.base, semi.token, 'POST', `${semi.base}/exchange-offers`, exchangeRequest([semi.fulfillments[0].id], { overruleCode: 'STRIKE' }));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'OVERRULE_CODE_NOT_SUPPORTED');
});

test('exchange: refused requests', async () => {
  const pending = await booked('gamma', 'FULL_FLEXIBLE', { confirm: false });
  assert.equal((await call(sim.base, pending.token, 'POST', `${pending.base}/exchange-offers`, exchangeRequest(['x']))).status, 409, 'not confirmed yet');
  const { token, base, fulfillments } = await booked('gamma');
  const cases = [
    [exchangeRequest([]), 400],
    [exchangeRequest(['not-a-fulfillment']), 400],
    [exchangeRequest([fulfillments[0].id, fulfillments[0].id]), 400],
    [exchangeRequest([7]), 400],
    [{ ...exchangeRequest([fulfillments[0].id]), anonymousPassengerSpecifications: [{ externalRef: 'someone-else', type: 'PERSON' }] }, 400],
  ];
  for (const [body, status] of cases) {
    assert.equal((await call(sim.base, token, 'POST', `${base}/exchange-offers`, body)).status, status, JSON.stringify(body).slice(0, 80));
  }
  for (const body of [{}, { exchangeOffers: [] }, { exchangeOffers: [{ offerId: 1 }] }, { exchangeOffers: [{ offerId: 'a' }, { offerId: 'b' }] }]) {
    assert.equal((await call(sim.base, token, 'POST', `${base}/exchange-operations`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(sim.base, token, 'POST', `${base}/exchange-operations`, { exchangeOffers: [{ offerId: 'unknown' }] })).status, 404);
  assert.equal((await call(sim.base, token, 'GET', `${base}/exchange-operations/unknown`)).status, 404);
  assert.equal((await call(sim.base, token, 'PATCH', `${base}/exchange-operations/unknown`, {})).status, 405);
  assert.equal((await call(sim.base, token, 'GET', `${base}/exchange-offers`)).status, 405);
  assert.equal((await call(sim.base, token, 'POST', `${base}/exchange-offers/x`, {})).status, 404);
});
