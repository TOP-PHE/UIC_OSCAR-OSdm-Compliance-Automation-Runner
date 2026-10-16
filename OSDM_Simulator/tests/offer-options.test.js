// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #780: what gamma does with the offer search criteria, and the stop place
// where it ignores them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { PROVIDERS_DIR, offerRequest } = require('./helpers');

const providers = loadProviders(PROVIDERS_DIR);
const gamma = providers.get('gamma');
const alpha = providers.get('alpha');
const NOW = Date.parse('2026-10-11T08:00:00Z');

function answer(criteria, { provider = gamma, from = 'urn:uic:stn:0000001' } = {}) {
  const request = offerRequest({ offerSearchCriteria: criteria });
  request.tripSearchCriteria.origin.stopPlaceRef = from;
  return buildOfferCollection(request, provider, NOW).response;
}
const classes = (response) => [...new Set(response.offers.map((o) => o.offerSummary.overallTravelClass))].sort();
const serviceClasses = (response) => [...new Set(response.offers.map((o) => o.offerSummary.overallServiceClass?.type))].sort();

test('service classes: HIGH is first class, STANDARD second, BEST and BASIC are not sold', () => {
  assert.deepEqual(classes(answer({ serviceClassTypes: ['HIGH'] })), ['FIRST']);
  assert.deepEqual(serviceClasses(answer({ serviceClassTypes: ['HIGH'] })), ['HIGH']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['STANDARD'] })), ['SECOND']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['HIGH', 'STANDARD'] })), ['FIRST', 'SECOND']);
  assert.equal(answer({ serviceClassTypes: ['BEST'] }).offers.length, 0);
  // With a travel class too, both must hold.
  assert.equal(answer({ serviceClassTypes: ['HIGH'], travelClasses: ['SECOND'] }).offers.length, 0);
  // Nothing asked: second class, as before.
  assert.deepEqual(classes(answer(undefined)), ['SECOND']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['ANY'] })), ['SECOND']);
});

test('offer parts without an admission: the usual offers, and a problem saying the member was ignored', () => {
  const reservationOnly = answer({ requestedOfferParts: ['RESERVATION'] });
  assert.ok(reservationOnly.offers.length > 0);
  assert.deepEqual(reservationOnly.problems, [{
    code: 'PARAMETER_NOT_SUPPORTED',
    title: "Parameter 'offerSearchCriteria.requestedOfferParts' was ignored.",
    detail: 'No offer without an admission is sold (asked: RESERVATION); offers with admissions are given.',
    pointers: ['offerSearchCriteria.requestedOfferParts'],
  }]);
  for (const parts of [['ADMISSION'], ['ADMISSION', 'RESERVATION'], ['ALL'], ['UNKNOWN']]) {
    assert.equal(answer({ requestedOfferParts: parts }).problems, undefined, parts.join());
  }
});

test('from the ignoring stop place, gamma answers as if no criteria were sent; elsewhere and on alpha, it keeps to them', () => {
  const from = gamma.variants.ignoresOfferOptionsFrom;
  assert.equal(from, 'urn:uic:stn:0000090');
  assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] }, { from })), ['SECOND']);
  assert.equal(answer({ requestedOfferParts: ['RESERVATION'] }, { from }).problems, undefined);
  assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] })), ['FIRST']);
  assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] }, { provider: alpha, from })), ['FIRST']);
});

test('the variant stop place is optional in a provider profile, and must be text when given', () => {
  const { checkProvider } = require('../src/config');
  const raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(PROVIDERS_DIR, 'gamma.json'), 'utf8'));
  const withVariants = (variants) => ({ ...raw, variants });
  assert.equal(checkProvider('gamma', withVariants({ wrongOffersFrom: 'x' })).variants.ignoresOfferOptionsFrom, undefined);
  assert.equal(checkProvider('gamma', withVariants({ wrongOffersFrom: 'x', ignoresOfferOptionsFrom: 'y' })).variants.ignoresOfferOptionsFrom, 'y');
  assert.throws(() => checkProvider('gamma', withVariants({ wrongOffersFrom: 'x', ignoresOfferOptionsFrom: 3 })), /variants/);
});
