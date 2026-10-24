// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #950: a part sold WITH_CONDITION says what its conditions are, and the
 * refund keeps the fee they state.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const afterSales = require('../src/osdm/afterSales');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const [gammaOne] = SECRETS.gamma;
const price = (amount) => ({ amount, currency: 'CZK', scale: 2 });

test('conditionsOf: a quarter of the price for each WITH_CONDITION flag, none for YES or NO', () => {
  assert.deepEqual(afterSales.conditionsOf({ price: price(1002), refundable: 'WITH_CONDITION', exchangeable: 'WITH_CONDITION' }), [
    { condition: 'REFUND', afterSaleFee: price(251) },
    { condition: 'EXCHANGE', afterSaleFee: price(251) },
  ]);
  assert.deepEqual(afterSales.conditionsOf({ price: price(400), refundable: 'YES', exchangeable: 'WITH_CONDITION' }), [
    { condition: 'EXCHANGE', afterSaleFee: price(100) },
  ]);
  for (const flag of ['YES', 'NO', undefined]) {
    assert.equal(afterSales.conditionsOf({ price: price(400), refundable: flag, exchangeable: flag }), null);
  }
  assert.equal(afterSales.conditionsOf({ refundable: 'WITH_CONDITION' }), null, 'no price, nothing to state');
  const plain = { price: price(400), refundable: 'NO', exchangeable: 'NO' };
  assert.equal(afterSales.withOfferConditions(plain), plain);
  assert.equal(afterSales.withBookedConditions(plain), plain);
});

test('a semi-flexible offer and its booking state their conditions; the refund keeps the fee stated', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const offers = (await call(sim.base, token, 'POST', '/gamma/offers', offerRequest())).body.offers;
  for (const offer of offers) {
    for (const part of offer.admissionOfferParts) {
      const stated = (part.afterSalesConditions || []).map((c) => c.condition);
      assert.deepEqual(stated, part.refundable === 'WITH_CONDITION' ? ['REFUND', 'EXCHANGE'] : [], offer.offerSummary.overallFlexibility);
    }
  }
  const semi = offers.find((o) => o.offerSummary.overallFlexibility === 'SEMI_FLEXIBLE');
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(semi))).body.booking;
  const admissions = booking.bookedOffers.flatMap((o) => o.admissions);
  assert.ok(admissions.length > 0);
  for (const admission of admissions) {
    const refund = admission.afterSaleConditions.find((c) => c.condition === 'REFUND');
    assert.equal(refund.afterSaleFee.amount, Math.round(admission.price.amount / 4));
  }
  const base = `/gamma/bookings/${booking.id}`;
  const fulfillments = (await call(sim.base, token, 'POST', `${base}/fulfillments`, {})).body.fulfillments;
  const offer = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) })).body.refundOffers[0];
  const stated = admissions.reduce((sum, a) => sum + a.afterSaleConditions.find((c) => c.condition === 'REFUND').afterSaleFee.amount, 0);
  assert.equal(offer.refundFee.amount, stated);
});
