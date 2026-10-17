// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #704: the sales horizon of gamma, for trips from its own stop place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { daysAhead } = require('../src/osdm/salesHorizon');
const { loadAllProviders, offerRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const plain = providers.get('plain');
// 2026-10-11 at 23:30 UTC: already the 12th in gamma's +02:00, still the 11th in UTC.
const NOW = Date.parse('2026-10-11T23:30:00Z');

const on = (date, stopPlaceRef = gamma.salesHorizon.from) => offerRequest({
  tripSearchCriteria: {
    ...offerRequest().tripSearchCriteria,
    origin: { objectType: 'StopPlaceRef', stopPlaceRef },
    departureTime: `${date}T08:00:00`,
  },
});

test('every provider sells 90 days ahead from its own stop place; plain has no horizon', () => {
  for (const key of ['alpha', 'beta', 'gamma']) {
    assert.deepEqual(providers.get(key).salesHorizon, { from: 'urn:uic:stn:0000094', days: 90 }, key);
  }
  assert.equal(plain.salesHorizon, undefined);
});

test('days ahead count from today in UTC to the date written in the trip', () => {
  assert.equal(daysAhead('2026-10-11T08:00:00+02:00', NOW), 0);
  assert.equal(daysAhead('2026-10-10T23:00:00+01:00', NOW), -1);
  assert.equal(daysAhead('2027-01-09T08:00:00+01:00', NOW), 90);
  assert.equal(daysAhead('not a date', NOW), 0);
});

test('the last day of the horizon is sold, today too', () => {
  for (const date of ['2026-10-11', '2027-01-09']) {
    const { response } = buildOfferCollection(on(date), gamma, NOW);
    assert.ok(response.offers.length > 0, date);
    assert.equal(response.problems, undefined, date);
  }
});

test('the day after the horizon: no offer, and a Problem saying why', () => {
  const { response, remembered } = buildOfferCollection(on('2027-01-10'), gamma, NOW);
  assert.deepEqual(response.offers, []);
  assert.deepEqual(remembered, []);
  assert.equal(response.problems.length, 1);
  assert.equal(response.problems[0].code, 'SALES_HORIZON_EXCEEDED');
  assert.match(response.problems[0].detail, /up to 90 days ahead; this one is 91 days ahead/);
});

test('a departure in the past is refused with 400 DEPARTURE_IN_PAST', () => {
  assert.throws(() => buildOfferCollection(on('2026-10-10'), gamma, NOW),
    (e) => e.status === 400 && e.code === 'DEPARTURE_IN_PAST');
});

test('other stop places, and a provider without a horizon, sell any date as before', () => {
  for (const date of ['2026-10-10', '2027-06-01']) {
    assert.ok(buildOfferCollection(on(date, 'urn:uic:stn:0000001'), gamma, NOW).response.offers.length > 0);
    assert.ok(buildOfferCollection(on(date), plain, NOW).response.offers.length > 0);
  }
});

test('the profile check', () => {
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  const check = (salesHorizon) => checkProvider('gamma', { ...base, salesHorizon });
  assert.deepEqual(check({ from: 'urn:uic:stn:1', days: 1 }).salesHorizon, { from: 'urn:uic:stn:1', days: 1 });
  for (const wrong of [null, 'x', {}, { from: '', days: 9 }, { from: 'a', days: 0 }, { from: 'a', days: 1001 }, { from: 'a', days: 2.5 }]) {
    assert.throws(() => check(wrong), /salesHorizon/);
  }
});
