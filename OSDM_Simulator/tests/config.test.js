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
