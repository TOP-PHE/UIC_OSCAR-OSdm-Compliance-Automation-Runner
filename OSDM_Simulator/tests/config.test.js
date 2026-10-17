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
const { PROVIDERS_DIR, SECRETS, loadAllProviders, tempDir, writeClientsFile } = require('./helpers');

const REAL = ['alpha', 'beta', 'gamma'];

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
  // according to the version (#614). Every function is on all three (#824).
  assert.deepEqual(all.map((p) => p.osdmVersion), ['3.6.0', '3.7.0', '3.8.0']);
});

// Identity keys: what makes a provider itself. Every other key is a function,
// and every provider has every function (#824).
const IDENTITY_KEYS = ['name', 'carrier', 'currency', 'priceFactor', 'otherCurrencies', 'osdmVersion', 'idPrefix', 'utcOffset', 'tokenLifetimeSeconds'];

test('alpha and beta hold every function of gamma, with the same values, and keep their own identity (#824)', () => {
  const raw = (key) => JSON.parse(fs.readFileSync(path.join(PROVIDERS_DIR, `${key}.json`), 'utf8'));
  const gamma = raw('gamma');
  const functions = Object.keys(gamma).filter((key) => !IDENTITY_KEYS.includes(key));
  assert.ok(functions.length >= 18, `gamma has ${functions.length} functions`);
  for (const key of ['alpha', 'beta']) {
    const profile = raw(key);
    for (const fn of functions) {
      assert.deepEqual(profile[fn], gamma[fn], `${key}.${fn} must equal gamma.${fn}`);
    }
    for (const own of Object.keys(profile).filter((k) => !IDENTITY_KEYS.includes(k))) {
      assert.ok(functions.includes(own), `${key}.${own} is a function gamma does not have`);
    }
  }
  const identity = (p) => [p.osdmVersion, p.currency, p.idPrefix];
  assert.deepEqual(identity(raw('alpha')), ['3.6.0', 'EUR', 'ALPHA']);
  assert.deepEqual(identity(raw('beta')), ['3.7.0', 'CHF', 'BETA']);
  assert.deepEqual(identity(raw('gamma')), ['3.8.0', 'CZK', 'GAMMA']);
  // Each sells one other currency of its own, so each refuses one it does not sell.
  for (const key of ['alpha', 'beta', 'gamma']) {
    const other = Object.keys(raw(key).otherCurrencies || {});
    assert.ok(other.length > 0, `${key} sells another currency`);
    assert.ok(!other.includes(raw(key).currency), key);
  }
});

test('the test-only plain provider has none of the functions (#824)', () => {
  const plain = loadAllProviders().get('plain');
  const gamma = JSON.parse(fs.readFileSync(path.join(PROVIDERS_DIR, 'gamma.json'), 'utf8'));
  for (const fn of Object.keys(gamma).filter((key) => !IDENTITY_KEYS.includes(key))) {
    assert.equal(plain[fn], undefined, `plain.${fn}`);
  }
  assert.equal(loadProviders(PROVIDERS_DIR).has('plain'), false);
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

test('overrule codes: every provider lists the four it accepts, plain none; a wrong list stops the start (#596)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) {
    assert.deepEqual(providers.get(key).overruleCodes, ['CONNECTION_BROKEN', 'PAYMENT_FAILURE', 'SALES_STAFF_ERROR', 'TECHNICAL_FAILURE'], key);
  }
  assert.equal(providers.get('plain').overruleCodes, undefined);
  for (const wrong of [[], 'STRIKE', ['strike'], ['STRIKE', 'STRIKE'], [7], Array.from({ length: 31 }, (_, i) => `CODE_${i}`)]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ overruleCodes: wrong }) })), /overruleCodes/, JSON.stringify(wrong));
  }
  assert.deepEqual(loadProviders(providersDir({ 'test.json': profile({ overruleCodes: ['STRIKE'] }) })).get('test').overruleCodes, ['STRIKE']);
});

test('reduction cards: every provider lists three, plain none; a wrong list stops the start (#597)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) {
    assert.deepEqual(providers.get(key).reductionCards.map((c) => [c.code, c.percent]), [['SIM_CARD_25', 25], ['SIM_CARD_50', 50], ['SIM_STUDENT', 30]], key);
  }
  assert.equal(providers.get('plain').reductionCards, undefined);
  const good = { code: 'CARD_A', name: 'Card A', percent: 10 };
  for (const wrong of [[], 'CARD_A', [{ ...good, code: 'a' }], [{ ...good, name: '' }], [{ ...good, percent: 0 }], [{ ...good, percent: 95 }], [{ ...good, percent: 2.5 }], [good, good]]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ reductionCards: wrong }) })), /reductionCards/, JSON.stringify(wrong));
  }
});

test('products: every provider sells four named products and two group ones, plain none; a wrong list stops the start (#598, #599)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) {
    assert.deepEqual(providers.get(key).products.map((p) => p.code), ['SIM_FLEXI_BASIC', 'SIM_ALL_DAY', 'SIM_FLEXI_SAVER', 'SIM_TRAIN_BOUND', 'SIM_WEEKEND_GROUP', 'SIM_GROUP'], key);
  }
  assert.equal(providers.get('plain').products, undefined);
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
  const providers = loadAllProviders();
  const clients = loadClients(writeClientsFile(), providers);
  const [one, two] = SECRETS.alpha;
  assert.equal(clientMatches(clients, 'alpha', one.client_id, one.client_secret), true);
  assert.equal(clientMatches(clients, 'alpha', one.client_id, two.client_secret), false);
  assert.equal(clientMatches(clients, 'beta', one.client_id, one.client_secret), false);
  assert.equal(clientMatches(clients, 'gamma', one.client_id, one.client_secret), false);
  assert.equal(clientMatches(clients, 'plain', one.client_id, one.client_secret), false);
  assert.equal(clientMatches(clients, 'plain', SECRETS.plain[0].client_id, SECRETS.plain[0].client_secret), true);
  assert.equal(clientMatches(clients, 'alpha', SECRETS.plain[0].client_id, SECRETS.plain[0].client_secret), false);
  assert.equal(clientMatches(clients, 'alpha', 'nobody', one.client_secret), false);
  assert.equal(clientMatches(clients, 'alpha', undefined, undefined), false);
  assert.equal(clientMatches(clients, 'alpha', one.client_id, { length: 99 }), false);
});

test('the secrets themselves are not kept in memory, only their digests', () => {
  const clients = loadClients(writeClientsFile(), loadAllProviders());
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

test('second-class-only categories: every provider names R and Os, plain none; a wrong list stops the start (#600)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) assert.deepEqual(providers.get(key).secondClassOnlyCategories, ['R', 'Os'], key);
  assert.equal(providers.get('plain').secondClassOnlyCategories, undefined);
  for (const wrong of [[], 'R', ['R', 'R'], ['R x'], ['ABCDEFGHIJK'], new Array(11).fill(0).map((_, i) => `C${i}`)]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ secondClassOnlyCategories: wrong }) })), /secondClassOnlyCategories/, JSON.stringify(wrong));
  }
});

test('reservations: every provider\'s SuperCity mandatory, EuroCity optional, plain none; a wrong map stops the start (#601)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) assert.deepEqual(providers.get(key).reservations, { SC: 'MANDATORY', EC: 'OPTIONAL' }, key);
  assert.equal(providers.get('plain').reservations, undefined);
  for (const wrong of [{}, [], { SC: 'YES' }, { 'S C': 'MANDATORY' }, 'SC']) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ reservations: wrong }) })), /reservations/, JSON.stringify(wrong));
  }
});

test('trips collection: every provider answers it, plain does not; a value that is not true or false stops the start (#602)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) assert.equal(providers.get(key).tripsCollection, true, key);
  assert.equal(providers.get('plain').tripsCollection, undefined);
  assert.equal(loadProviders(providersDir({ 'test.json': profile({ tripsCollection: false }) })).get('test').tripsCollection, undefined);
  for (const wrong of ['yes', 1, null]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ tripsCollection: wrong }) })), /tripsCollection/, JSON.stringify(wrong));
  }
});

test('documents: every provider issues PDF_A4 and RETAILER_APP, its receipt after 30 s, plain none; a wrong profile stops the start (#603)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) {
    const provider = providers.get(key);
    assert.deepEqual([provider.documents, provider.refundReceiptDelaySeconds], [['PDF_A4', 'RETAILER_APP'], 30], key);
  }
  assert.equal(providers.get('plain').documents, undefined);
  for (const wrong of [[], ['PDF_A4', 'PDF_A4'], ['RCT2'], 'PDF_A4']) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ documents: wrong, refundReceiptDelaySeconds: 30 }) })), /documents/, JSON.stringify(wrong));
  }
  for (const wrong of [undefined, -1, 3601, 1.5]) {
    assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ documents: ['PDF_A4'], refundReceiptDelaySeconds: wrong }) })), /refundReceiptDelaySeconds/, String(wrong));
  }
});

test('idempotency: every provider keeps the answers, plain does not; a value that is not true or false stops the start (#604)', () => {
  const providers = loadAllProviders();
  for (const key of REAL) assert.equal(providers.get(key).idempotency, true, key);
  assert.equal(providers.get('plain').idempotency, undefined);
  assert.throws(() => loadProviders(providersDir({ 'test.json': profile({ idempotency: 'yes' }) })), /idempotency/);
});
