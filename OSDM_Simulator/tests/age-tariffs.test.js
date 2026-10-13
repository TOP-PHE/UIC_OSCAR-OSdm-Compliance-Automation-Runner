// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #705: prices by age on gamma, for trips from its own stop place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders, checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { ageOn } = require('../src/osdm/ageTariffs');
const { PROVIDERS_DIR, offerRequest } = require('./helpers');

const providers = loadProviders(PROVIDERS_DIR);
const gamma = providers.get('gamma');
const NOW = Date.parse('2026-10-11T08:00:00Z');
// The helpers' trip leaves on 2026-11-20.
const born = (dateOfBirth, ref) => ({ externalRef: ref, type: 'PERSON', dateOfBirth });
const PASSENGERS = [
  born('2011-11-21', 'child'), // 14, 15 tomorrow
  born('2011-11-20', 'youth'), // 15 today
  born('2000-11-20', 'adult'), // 26 today
  born('2021-01-01', 'small'), // 5
];

const offerFrom = (stopPlaceRef, passengers = PASSENGERS) => buildOfferCollection(offerRequest({
  anonymousPassengerSpecifications: passengers,
  tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } },
}), gamma, NOW).response.offers[0];
const partOf = (offer, ref) => offer.admissionOfferParts.find((p) => p.passengerRefs[0] === ref);

test('the age on a day: the birthday counts from its own day', () => {
  assert.equal(ageOn('2011-11-21', '2026-11-20'), 14);
  assert.equal(ageOn('2011-11-20', '2026-11-20'), 15);
  assert.equal(ageOn(undefined, '2026-11-20'), null);
  assert.equal(ageOn('2011-13', '2026-11-20'), null);
});

test('from the age-tariff stop place: each passenger typed and priced by its age', () => {
  const offer = offerFrom(gamma.ageTariffs.from);
  const full = partOf(offerFrom('urn:uic:stn:0000001'), 'adult').price.amount;
  const typed = (ref) => partOf(offer, ref).appliedPassengerTypes;
  assert.deepEqual(typed('child').map((t) => [t.passengerRef, t.type]), [['child', 'CHILD']]);
  assert.deepEqual(typed('youth').map((t) => t.type), ['YOUTH']);
  assert.deepEqual(typed('adult').map((t) => t.type), ['ADULT']);
  assert.deepEqual(typed('small').map((t) => t.type), ['YOUNG_CHILD']);
  assert.match(typed('child')[0].description, /aged 14 on the day of travel/);
  const fromStop = partOf(offer, 'adult').price.amount;
  assert.equal(partOf(offer, 'child').price.amount, Math.round(fromStop / 2));
  assert.equal(partOf(offer, 'youth').price.amount, Math.round(fromStop * 3 / 4));
  assert.equal(partOf(offer, 'small').price.amount, 0);
  assert.ok(full > 0 && fromStop > 0);
});

test('elsewhere, or without a date of birth, prices and types are as before', () => {
  const offer = offerFrom('urn:uic:stn:0000001');
  const adult = partOf(offer, 'adult').price.amount;
  for (const ref of ['child', 'youth', 'small']) {
    assert.equal(partOf(offer, ref).price.amount, adult);
    assert.equal(partOf(offer, ref).appliedPassengerTypes, undefined);
  }
  const noDate = offerFrom(gamma.ageTariffs.from, [{ externalRef: 'x', type: 'PERSON' }]);
  assert.equal(partOf(noDate, 'x').appliedPassengerTypes, undefined);
});

test('the profile check', () => {
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  const check = (ageTariffs) => checkProvider('gamma', { ...base, ageTariffs });
  const one = { from: 'urn:uic:stn:1', bands: [{ type: 'CHILD', maxAge: 14, percent: 50 }] };
  assert.deepEqual(check(one).ageTariffs, one);
  const band = (b) => ({ from: 'a', bands: [b] });
  for (const wrong of [null, {}, { from: 'a', bands: [] }, { from: '', bands: one.bands },
    band({ type: 'child', maxAge: 1, percent: 1 }), band({ type: 'CHILD', maxAge: 121, percent: 1 }), band({ type: 'CHILD', maxAge: 1, percent: 101 }),
    { from: 'a', bands: [{ type: 'CHILD', maxAge: 9, percent: 1 }, { type: 'YOUTH', maxAge: 9, percent: 1 }] }]) {
    assert.throws(() => check(wrong), /ageTariffs/);
  }
});
