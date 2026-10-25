// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #227: from the stop place of `requestOptions`, each optional member of the
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

test('the mandatory members alone are answered with offers', async () => {
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
