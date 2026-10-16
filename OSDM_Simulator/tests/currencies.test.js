// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #781: gamma sells in CZK and EUR. A sale keeps its currency through the
// booking, the refund and the exchange; a currency it does not sell is refused.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const [alphaOne] = SECRETS.alpha;
const [gammaOne] = SECRETS.gamma;
const asking = (currency) => offerRequest(currency ? { offerSearchCriteria: { currency } } : {});

// Every `currency` member anywhere in a value.
function currencies(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => currencies(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'currency') out.add(v);
      else currencies(v, out);
    }
  }
  return out;
}

async function sale(currency) {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const offers = await call(sim.base, token, 'POST', '/gamma/offers', asking(currency));
  return { token, offers };
}

test('offers: in the currency asked, in CZK when none is asked, refused in one not sold', async () => {
  const eur = (await sale('EUR')).offers;
  assert.equal(eur.status, 200);
  assert.deepEqual([...currencies(eur.body.offers)], ['EUR']);
  const none = (await sale(undefined)).offers;
  assert.deepEqual([...currencies(none.body.offers)], ['CZK']);
  assert.deepEqual([...currencies((await sale('CZK')).offers.body.offers)], ['CZK']);
  // Same trip, a 24th of the price in EUR (priceFactor 1 against 24), rounded.
  const amount = (res) => res.body.offers[0].offerSummary.minimalPrice.amount;
  assert.ok(Math.abs(amount(none) / 24 - amount(eur)) <= 1, `${amount(none)} CZK against ${amount(eur)} EUR`);
  const usd = (await sale('USD')).offers;
  assert.equal(usd.status, 400);
  assert.equal(usd.body.code, 'CURRENCY_NOT_SUPPORTED');
  assert.match(usd.body.detail, /USD.*Sold in: CZK, EUR/);
  assert.equal((await sale('eur')).offers.status, 400, 'not an ISO 4217 code');
});

test('a provider naming no other currency answers in its own, as before', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const res = await call(sim.base, token, 'POST', '/alpha/offers', asking('USD'));
  assert.equal(res.status, 200);
  assert.equal(currencies(res.body.offers).has('USD'), false);
});

test('a sale in EUR stays in EUR: booking, confirmation, refund and exchange', async () => {
  const { token, offers } = await sale('EUR');
  const offer = offers.body.offers.find((o) => o.offerSummary.overallFlexibility === 'FULL_FLEXIBLE');
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  assert.equal(booking.provisionalPrice.currency, 'EUR');
  const base = `/gamma/bookings/${booking.id}`;
  const fulfillments = (await call(sim.base, token, 'POST', `${base}/fulfillments`, {})).body.fulfillments;
  const confirmed = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.deepEqual([confirmed.confirmedPrice.currency, confirmed.provisionalPrice.currency], ['EUR', 'EUR']);

  const exchange = await call(sim.base, token, 'POST', `${base}/exchange-offers`,
    { ...asking('EUR'), fulfillmentIds: fulfillments.map((f) => f.id) });
  assert.equal(exchange.status, 200);
  assert.deepEqual([...currencies(exchange.body.exchangeOffers)], ['EUR']);
  // An exchange asked without the currency is offered in CZK: the new
  // journey's price says so, the fee and the balance stay in the booking's.
  const lost = await call(sim.base, token, 'POST', `${base}/exchange-offers`,
    { ...asking(undefined), fulfillmentIds: fulfillments.map((f) => f.id) });
  assert.equal(lost.body.exchangeOffers[0].exchangePrice.currency, 'CZK');
  assert.equal(lost.body.exchangeOffers[0].exchangeFee.currency, 'EUR');

  const refund = await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) });
  assert.equal(refund.status, 200);
  assert.deepEqual([...currencies(refund.body.refundOffers)], ['EUR']);
});
