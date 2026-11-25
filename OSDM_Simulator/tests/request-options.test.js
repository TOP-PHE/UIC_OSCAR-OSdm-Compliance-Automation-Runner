// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #227: from the stop place of `requestOptions`, each optional parameter of the
 * profile is ignored, refused or answered without offers, so OSCAR's offer
 * request options scenario meets every class of answer. Elsewhere the same
 * members change nothing.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest } = require('./helpers');

let sim;
let token;
before(async () => { sim = await startSimulator(); token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]); });
after(async () => { await sim.close(); });

const FROM = 'urn:uic:stn:0000078';

function request(from, change) {
  const body = offerRequest();
  if (from) body.tripSearchCriteria.origin.stopPlaceRef = from;
  change(body);
  return body;
}

const ask = (from, change) => call(sim.base, token, 'POST', '/gamma/offers', request(from, change));
const each = (member) => (b) => { for (const p of b.anonymousPassengerSpecifications) p[member] = member === 'prmNeeds' ? ['WHEELCHAIR'] : 'FR'; };

test('the mandatory parameters alone are answered with offers', async () => {
  const res = await ask(FROM, (b) => { b.anonymousPassengerSpecifications = b.anonymousPassengerSpecifications.map((p) => ({ externalRef: p.externalRef, type: p.type })); });
  assert.equal(res.status, 200);
  assert.ok(res.body.offers.length > 0);
});

test('prmNeeds 501, embed 500, an unknown promotion code 400 naming it', async () => {
  assert.equal((await ask(FROM, each('prmNeeds'))).status, 501);
  assert.equal((await ask(FROM, (b) => { b.embed = ['ALL']; })).status, 500);
  const refused = await ask(FROM, (b) => { b.promotionCodes = [{ code: 'NOPE' }]; });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'PROMOTION_CODE_UNKNOWN');
  assert.match(refused.body.detail, /NOPE/);
  const known = await ask(FROM, (b) => { b.promotionCodes = [{ code: 'SIM-PROMO-10' }]; });
  assert.equal(known.status, 200);
});

test('residency ignored and said; flexibilities ignored silently', async () => {
  const said = await ask(FROM, each('residency'));
  assert.equal(said.status, 200);
  assert.ok(said.body.offers.length > 0);
  const problem = said.body.problems.find((p) => p.code === 'PARAMETER_NOT_SUPPORTED');
  assert.deepEqual(problem.pointers, [{ requestPointer: '/anonymousPassengerSpecifications/0/residency' }]);
  const silent = await ask(FROM, (b) => { b.offerSearchCriteria = { flexibilities: ['FULL_FLEXIBLE'] }; });
  const flexibilities = new Set(silent.body.offers.map((o) => o.offerSummary.overallFlexibility));
  assert.ok(flexibilities.size > 1, 'every tariff, as if not asked');
  assert.equal(silent.body.problems, undefined);
});

test('transportable: no offer, said; tripResponseParameters: no offer, nothing said', async () => {
  const said = await ask(FROM, (b) => { b.anonymousPassengerSpecifications[0].transportable = { type: 'BICYCLE' }; });
  assert.deepEqual(said.body.offers, []);
  assert.equal(said.body.problems[0].code, 'NO_OFFER_FOUND');
  const silent = await ask(FROM, (b) => { b.tripResponseParameters = { stopBehavior: 'REAL_BOARDING_ALIGHTING' }; });
  assert.deepEqual(silent.body.offers, []);
  assert.equal(silent.body.problems, undefined);
});

test('from another stop place the same members change nothing', async () => {
  const res = await ask(null, (b) => { each('prmNeeds')(b); b.embed = ['ALL']; b.promotionCodes = [{ code: 'NOPE' }]; b.tripResponseParameters = { stopBehavior: 'REAL_BOARDING_ALIGHTING' }; });
  assert.equal(res.status, 200);
  assert.ok(res.body.offers.length > 0);
  const flex = await ask(null, (b) => { b.offerSearchCriteria = { flexibilities: ['FULL_FLEXIBLE'] }; });
  assert.deepEqual([...new Set(flex.body.offers.map((o) => o.offerSummary.overallFlexibility))], ['FULL_FLEXIBLE']);
});

test('the profile check', () => {
  const { checkProvider } = require('../src/config');
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  const check = (requestOptions) => checkProvider('gamma', { ...base, requestOptions });
  const one = { from: 'urn:uic:stn:1', members: { embed: 'error' }, promotionCodes: ['A'] };
  assert.deepEqual(check(one).requestOptions, one);
  assert.deepEqual(check({ from: 'x', members: { embed: 'error' } }).requestOptions.promotionCodes, []);
  assert.equal(checkProvider('gamma', { ...base, requestOptions: undefined }).requestOptions, undefined);
  for (const wrong of [null, {}, { from: '', members: { embed: 'error' } }, { from: 'a', members: {} }, { from: 'a', members: [] },
    { from: 'a', members: { embed: 'explode' } }, { from: 'a', members: { 'a.b.c': 'error' } },
    { from: 'a', members: { embed: 'error' }, promotionCodes: [''] }, { from: 'a', members: { embed: 'error' }, promotionCodes: 'A' }]) {
    assert.throws(() => check(wrong), /requestOptions/);
  }
});

// ── #1437: the same behaviours without a trip, from 0000046 or in SIM-OPTIONS ──

const OPTIONVILLE = 'urn:uic:stn:0000046';
const nonTripRequest = (where, change = () => {}) => {
  const body = offerRequest();
  delete body.tripSearchCriteria;
  body.nonTripSearchCriteria = { ...where, validFrom: '2026-11-20T00:00:00+01:00' };
  change(body);
  return body;
};
const BY_PLACES = { places: [{ objectType: 'StopPlaceRef', stopPlaceRef: OPTIONVILLE }, { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000040' }] };
const byZone = (carrier) => ({ zones: [{ id: 'SIM-OPTIONS', carrier }] });

test('without a trip: every provider, by its stop place and by its zone, answers each behaviour, in its own version', async () => {
  for (const key of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    const t = await tokenFor(sim.base, key, SECRETS[key][0]);
    const carrier = `urn:x_osdm_simulator:carrier:${key}`;
    for (const where of [BY_PLACES, byZone(carrier)]) {
      const nt = (change) => call(sim.base, t, 'POST', `/${key}/offers`, nonTripRequest(where, change));
      const label = `${key} ${Object.keys(where)[0]}`;
      const plain = await nt((b) => { delete b.nonTripSearchCriteria.validFrom; });
      assert.equal(plain.status, 200, label);
      assert.ok(plain.body.offers.length > 0, label);
      assert.equal((await nt(each('prmNeeds'))).status, 501, label);
      assert.equal((await nt((b) => { b.embed = ['ALL']; })).status, 500, label);
      assert.equal((await nt((b) => { b.promotionCodes = [{ code: 'NOPE' }]; })).status, 400, label);
      assert.equal((await nt((b) => { b.promotionCodes = [{ code: 'SIM-PROMO-10' }]; })).status, 200, label);
      const said = await nt(each('residency'));
      assert.ok(said.body.offers.length > 0, label);
      assert.equal(said.body.problems.find((p) => p.code === 'PARAMETER_NOT_SUPPORTED').pointers[0].requestPointer, '/anonymousPassengerSpecifications/0/residency', label);
      const silent = await nt((b) => { b.offerSearchCriteria = { flexibilities: ['FULL_FLEXIBLE'] }; });
      assert.ok(new Set(silent.body.offers.map((o) => o.offerSummary.overallFlexibility)).size > 1, `${label}: every product, as if not asked`);
      const none = await nt((b) => { b.anonymousPassengerSpecifications[0].transportable = { type: 'BICYCLE' }; });
      assert.deepEqual(none.body.offers, [], label);
      assert.equal(none.body.problems.find((p) => p.code === 'NO_OFFER_FOUND').code, 'NO_OFFER_FOUND', label);
    }
  }
});

test('without a trip elsewhere the same members change nothing', async () => {
  const elsewhere = { places: [{ objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000040' }, { objectType: 'StopPlaceRef', stopPlaceRef: OPTIONVILLE }] };
  const res = await call(sim.base, token, 'POST', '/gamma/offers', nonTripRequest(elsewhere, (b) => { each('prmNeeds')(b); b.embed = ['ALL']; b.promotionCodes = [{ code: 'NOPE' }]; }));
  assert.equal(res.status, 200, 'the first stop place chooses, not any of them');
  const zone = await call(sim.base, token, 'POST', '/gamma/offers', nonTripRequest(byZone('urn:x_osdm_simulator:carrier:gamma'), (b) => { b.nonTripSearchCriteria.zones[0].id = 'SIM-CITY'; b.embed = ['ALL']; }));
  assert.equal(zone.status, 200);
});

test('the profile check: the stop place and zone without a trip are optional text', () => {
  const { checkProvider } = require('../src/config');
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  assert.equal(base.requestOptions.nonTripFrom, OPTIONVILLE);
  assert.equal(base.requestOptions.nonTripZone, 'SIM-OPTIONS');
  const check = (requestOptions) => checkProvider('gamma', { ...base, requestOptions });
  const one = { from: 'urn:uic:stn:1', members: { embed: 'error' }, promotionCodes: [], nonTripFrom: 'urn:uic:stn:2', nonTripZone: 'Z' };
  assert.deepEqual(check(one).requestOptions, one);
  for (const wrong of [{ nonTripFrom: '' }, { nonTripZone: 3 }, { nonTripZone: 'x'.repeat(61) }]) {
    assert.throws(() => check({ ...one, ...wrong }), /requestOptions/);
  }
});
