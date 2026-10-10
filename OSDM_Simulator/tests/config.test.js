// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError, loadProviders, loadClients, clientMatches, loadSettings } = require('../src/config');
const { PROVIDERS_DIR, SECRETS, tempDir, writeClientsFile } = require('./helpers');

const profile = (overrides = {}) => ({
  name: 'Test Rail',
  carrier: { ref: 'urn:x:carrier:test', name: 'Test Rail' },
  currency: 'EUR',
  priceFactor: 1,
  osdmVersion: '3.8.0',
  idPrefix: 'TEST',
  utcOffset: '+01:00',
  tokenLifetimeSeconds: 600,
  ...overrides,
});

function providersDir(files) {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('the shipped profiles load: three providers that differ where it shows', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.deepEqual([...providers.keys()], ['alpha', 'beta', 'gamma']);
  const all = [...providers.values()];
  for (const field of ['idPrefix', 'currency', 'name']) {
    assert.equal(new Set(all.map((p) => p[field])).size, 3, `${field} must differ between providers`);
  }
  assert.equal(new Set(all.map((p) => p.carrier.ref)).size, 3);
  assert.equal(new Set(all.map((p) => p.tokenLifetimeSeconds)).size, 3);
  // Not every provider is on 3.8, and the collection sends and checks
  // according to the version (#614). gamma receives each new function.
  assert.deepEqual(all.map((p) => p.osdmVersion), ['3.6.0', '3.7.0', '3.8.0']);
});

test('a profile with a missing or wrong field stops the start', () => {
  const wrong = {
    name: '', carrier: { ref: 'x' }, currency: 'eur', priceFactor: 0, osdmVersion: 3,
    idPrefix: 'lower', utcOffset: '1:00', tokenLifetimeSeconds: 5,
  };
  for (const [field, value] of Object.entries(wrong)) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ [field]: value }) })), ConfigError, field);
  }
  assert.throws(() => loadProviders(providersDir({ 'test.json': '{ not json' })), /not valid JSON/);
  assert.throws(() => loadProviders(providersDir({ 'test.json': 'null' })), /must be an object/);
});

test('overrule codes: gamma lists the four it accepts; a wrong list stops the start (#596)', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.deepEqual(providers.get('gamma').overruleCodes, ['CONNECTION_BROKEN', 'PAYMENT_FAILURE', 'SALES_STAFF_ERROR', 'TECHNICAL_FAILURE']);
  assert.equal(providers.get('alpha').overruleCodes, undefined);
  for (const wrong of [[], 'STRIKE', ['strike'], ['STRIKE', 'STRIKE'], [7], Array.from({ length: 31 }, (_, i) => `CODE_${i}`)]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ overruleCodes: wrong }) })), /overruleCodes/, JSON.stringify(wrong));
  }
  assert.deepEqual(loadProviders(providersDir({ 'test.json': profile({ overruleCodes: ['STRIKE'] }) })).get('test').overruleCodes, ['STRIKE']);
});

test('reduction cards: gamma lists three; a wrong list stops the start (#597)', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.deepEqual(providers.get('gamma').reductionCards.map((c) => [c.code, c.percent]), [['SIM_CARD_25', 25], ['SIM_CARD_50', 50], ['SIM_STUDENT', 30]]);
  assert.equal(providers.get('alpha').reductionCards, undefined);
  const good = { code: 'CARD_A', name: 'Card A', percent: 10 };
  for (const wrong of [[], 'CARD_A', [{ ...good, code: 'a' }], [{ ...good, name: '' }], [{ ...good, percent: 0 }], [{ ...good, percent: 95 }], [{ ...good, percent: 2.5 }], [good, good]]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ reductionCards: wrong }) })), /reductionCards/, JSON.stringify(wrong));
  }
});

test('products: gamma sells four named products and two group ones; a wrong list stops the start (#598, #599)', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.deepEqual(providers.get('gamma').products.map((p) => p.code), ['SIM_FLEXI_BASIC', 'SIM_ALL_DAY', 'SIM_FLEXI_SAVER', 'SIM_TRAIN_BOUND', 'SIM_WEEKEND_GROUP', 'SIM_GROUP']);
  assert.equal(providers.get('alpha').products, undefined);
  const good = { code: 'P_A', name: 'Product A', flexibility: 'FULL_FLEXIBLE', factor: 1, isTrainBound: false };
  for (const wrong of [[], [{ ...good, code: 'a' }], [{ ...good, flexibility: 'ANY' }], [{ ...good, factor: 4 }], [{ ...good, isTrainBound: 'no' }], [good, good]]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ products: wrong }) })), /products/, JSON.stringify(wrong));
  }
});

test('a provider key that the router keeps for itself, or that is not a plain name, is refused', () => {
  assert.throws(() => loadProviders(providersDir({ 'healthz.json': profile() })), /not a usable provider key/);
  assert.throws(() => loadProviders(providersDir({ 'Bad Key.json': profile() })), /not a usable provider key/);
});

test('two providers may not share an id prefix', () => {
  assert.throws(() => loadProviders(providersDir({ 'one.json': profile(), 'two.json': profile() })), /already used/);
});

test('no profile, or a directory that is not there, stops the start', () => {
  assert.throws(() => loadProviders(tempDir()), /no provider profile/);
  assert.throws(() => loadProviders(path.join(tempDir(), 'missing')), /cannot be read/);
});

test('the clients file is required: missing, unreadable as JSON or empty is refused', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.throws(() => loadClients(path.join(tempDir(), 'clients.json'), providers), /cannot be read/);
  assert.throws(() => loadClients(writeClientsFile('{'), providers), /not valid JSON/);
  assert.throws(() => loadClients(writeClientsFile('[]'), providers), /keyed by provider/);
  assert.throws(() => loadClients(writeClientsFile({}), providers), /defines no client/);
  assert.throws(() => loadClients(writeClientsFile({ alpha: [] }), providers), /defines no client/);
});

test('a clients file with a weak, placeholder or misplaced entry is refused', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  const good = 's'.repeat(40);
  const refused = [
    [{ delta: [{ client_id: 'abc', client_secret: good }] }, /unknown provider/],
    [{ alpha: { client_id: 'abc', client_secret: good } }, /must be a list/],
    [{ alpha: [{ client_id: 'abc', client_secret: 'short' }] }, /shorter than/],
    [{ alpha: [{ client_id: 'abc' }] }, /shorter than/],
    [{ alpha: [{ client_id: 'a:b', client_secret: good }] }, /client_id is missing or not valid/],
    [{ alpha: [{ client_secret: good }] }, /client_id is missing or not valid/],
    [{ alpha: [{ client_id: 'abc', client_secret: good }, { client_id: 'abc', client_secret: good }] }, /appears twice/],
    [{ alpha: [{ client_id: 'abc', client_secret: 'REPLACE-with-a-random-secret-of-32-chars-or-more' }] }, /placeholder/],
  ];
  for (const [content, message] of refused) {
    assert.throws(() => loadClients(writeClientsFile(content), providers), message);
  }
});

test('the example clients file cannot be used as it is', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  assert.throws(() => loadClients(path.join(__dirname, '..', 'clients.example.json'), providers), /placeholder/);
});

test('a client is recognised only with its own secret, for its own provider', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  const clients = loadClients(writeClientsFile(), providers);
  const [one, two] = SECRETS.alpha;
  assert.equal(clientMatches(clients, 'alpha', one.client_id, one.client_secret), true);
  assert.equal(clientMatches(clients, 'alpha', one.client_id, two.client_secret), false);
  assert.equal(clientMatches(clients, 'beta', one.client_id, one.client_secret), false);
  assert.equal(clientMatches(clients, 'gamma', one.client_id, one.client_secret), false);
  assert.equal(clientMatches(clients, 'alpha', 'nobody', one.client_secret), false);
  assert.equal(clientMatches(clients, 'alpha', undefined, undefined), false);
  assert.equal(clientMatches(clients, 'alpha', one.client_id, { length: 99 }), false);
});

test('the secrets themselves are not kept in memory, only their digests', () => {
  const clients = loadClients(writeClientsFile(), loadProviders(PROVIDERS_DIR));
  const kept = clients.get('alpha').get(SECRETS.alpha[0].client_id);
  assert.ok(Buffer.isBuffer(kept));
  assert.equal(kept.length, 32);
  assert.equal(kept.toString('utf8').includes(SECRETS.alpha[0].client_secret), false);
});

test('settings have defaults, listen on loopback, and refuse a value out of range', () => {
  const settings = loadSettings({}, '/base');
  assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.port, 3002);
  assert.equal(settings.trustProxy, false);
  assert.equal(settings.limits.bodyBytes, 256 * 1024);
  assert.equal(loadSettings({ SIM_PORT: '0', SIM_TRUST_PROXY: '1', SIM_HOST: '0.0.0.0' }, '/base').trustProxy, true);
  assert.throws(() => loadSettings({ SIM_PORT: 'abc' }, '/base'), ConfigError);
  assert.throws(() => loadSettings({ SIM_MAX_BODY_BYTES: '1' }, '/base'), /SIM_MAX_BODY_BYTES/);
  assert.throws(() => loadSettings({ SIM_TTL_SECONDS: '1.5' }, '/base'), /SIM_TTL_SECONDS/);
});

test('group rules: gamma\'s two group products; a wrong rule stops the start (#599)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  assert.deepEqual(gamma.products.find((p) => p.code === 'SIM_WEEKEND_GROUP').group,
    { minPassengers: 2, maxPassengers: 5, maxOver15: 2, weekendOnly: true, secondClassOnly: false, oneFulfillment: true, pricedPassengers: 2 });
  assert.deepEqual(gamma.products.find((p) => p.code === 'SIM_GROUP').group,
    { minPassengers: 2, maxPassengers: 19, weekendOnly: false, secondClassOnly: true, oneFulfillment: false, followerPercent: 60 });
  const group = { minPassengers: 2, maxPassengers: 5, weekendOnly: false, secondClassOnly: false, oneFulfillment: false, pricedPassengers: 2 };
  const product = (rules) => ({ code: 'P_G', name: 'Group', flexibility: 'NON_FLEXIBLE', factor: 1, isTrainBound: false, group: rules });
  assert.doesNotThrow(() => loadProviders(providersDir({ 'test.json': profile({ products: [product(group)] }) })));
  const { pricedPassengers, ...unpriced } = group;
  for (const wrong of [null, { ...group, minPassengers: 0 }, { ...group, maxPassengers: 1 }, { ...group, maxPassengers: 20 }, { ...group, maxOver15: -1 },
    { ...group, weekendOnly: 'yes' }, { ...group, followerPercent: 50 }, unpriced, { ...unpriced, followerPercent: 0 }, { ...group, pricedPassengers: 0 }]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ products: [product(wrong)] }) })), /products/, JSON.stringify(wrong));
  }
  assert.ok(pricedPassengers);
});

test('second-class-only categories: gamma names R and Os; a wrong list stops the start (#600)', () => {
  assert.deepEqual(loadProviders(PROVIDERS_DIR).get('gamma').secondClassOnlyCategories, ['R', 'Os']);
  assert.equal(loadProviders(PROVIDERS_DIR).get('alpha').secondClassOnlyCategories, undefined);
  for (const wrong of [[], 'R', ['R', 'R'], ['R x'], ['ABCDEFGHIJK'], new Array(11).fill(0).map((_, i) => `C${i}`)]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ secondClassOnlyCategories: wrong }) })), /secondClassOnlyCategories/, JSON.stringify(wrong));
  }
});
