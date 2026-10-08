// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');

test('a token says which provider and client it was issued for', () => {
  const tokens = createTokenService({ now: () => 1000000 });
  const claims = tokens.verify(tokens.issue('alpha', 'client-1', 60));
  assert.deepEqual(claims, { provider: 'alpha', clientId: 'client-1', expiresAt: 1060 });
});

test('two tokens issued in the same second are different', () => {
  const tokens = createTokenService({ now: () => 1000000 });
  assert.notEqual(tokens.issue('alpha', 'client-1', 60), tokens.issue('alpha', 'client-1', 60));
});

test('a token ends at its lifetime, to the second', () => {
  let ms = 1000000;
  const tokens = createTokenService({ now: () => ms });
  const token = tokens.issue('alpha', 'client-1', 60);
  ms += 59000;
  assert.ok(tokens.verify(token));
  ms += 1000;
  assert.equal(tokens.verify(token), null);
});

test('an altered token is refused: payload, signature, or both swapped', () => {
  const tokens = createTokenService({ now: () => 1000000 });
  const token = tokens.issue('alpha', 'client-1', 60);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'beta', c: 'client-1', e: 9999999999 })).toString('base64url');
  assert.equal(tokens.verify(`${forged}.${signature}`), null);
  assert.equal(tokens.verify(`${payload}.${signature.slice(0, -2)}AA`), null);
  assert.equal(tokens.verify(`${payload}.`), null);
  assert.equal(tokens.verify(payload), null);
  assert.equal(tokens.verify(`${payload}.${signature}.${signature}`), null);
});

test('a token signed by another process is refused: a restart ends every token', () => {
  const before = createTokenService({ now: () => 1000000 });
  const after = createTokenService({ now: () => 1000000 });
  assert.equal(after.verify(before.issue('alpha', 'client-1', 60)), null);
});

test('what is not a token is refused without an error', () => {
  const tokens = createTokenService();
  for (const value of [undefined, null, 42, '', '.', 'a.b', 'x'.repeat(2000), {}]) {
    assert.equal(tokens.verify(value), null);
  }
});

test('a correctly signed payload that is not a claim set is refused', () => {
  const crypto = require('node:crypto');
  const key = Buffer.alloc(32, 7);
  const tokens = createTokenService({ key, now: () => 1000000 });
  const signed = (text) => {
    const payload = Buffer.from(text).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
  };
  assert.equal(tokens.verify(signed('not json')), null);
  assert.equal(tokens.verify(signed('null')), null);
  assert.equal(tokens.verify(signed(JSON.stringify({ p: 'alpha', c: 1, e: 9999999999 }))), null);
  assert.ok(tokens.verify(signed(JSON.stringify({ p: 'alpha', c: 'client-1', e: 9999999999 }))));
});

const newStore = (overrides = {}) => {
  const clock = { ms: 0 };
  const store = createStore({ limits: { offer: 3, booking: 2 }, ttlMs: 1000, now: () => clock.ms, ...overrides });
  return { store, clock };
};

test('what one scope stored, another scope does not read', () => {
  const { store } = newStore();
  store.put('booking', 'alpha\nclient-1', 'B1', { id: 'B1' });
  assert.deepEqual(store.get('booking', 'alpha\nclient-1', 'B1'), { id: 'B1' });
  assert.equal(store.get('booking', 'alpha\nclient-2', 'B1'), undefined);
  assert.equal(store.get('booking', 'beta\nclient-1', 'B1'), undefined);
  assert.equal(store.get('offer', 'alpha\nclient-1', 'B1'), undefined);
});

test('a scope that is full drops its oldest entry, and only its own', () => {
  const { store } = newStore();
  store.put('booking', 'other', 'X', 'kept');
  for (const id of ['B1', 'B2', 'B3']) store.put('booking', 'mine', id, id);
  assert.equal(store.get('booking', 'mine', 'B1'), undefined);
  assert.equal(store.get('booking', 'mine', 'B2'), 'B2');
  assert.equal(store.get('booking', 'mine', 'B3'), 'B3');
  assert.equal(store.get('booking', 'other', 'X'), 'kept');
  assert.equal(store.count('booking'), 3);
});

test('storing an id again replaces it and does not use a second place', () => {
  const { store } = newStore();
  store.put('booking', 'mine', 'B1', 'first');
  store.put('booking', 'mine', 'B2', 'second');
  store.put('booking', 'mine', 'B1', 'again');
  assert.equal(store.get('booking', 'mine', 'B1'), 'again');
  assert.equal(store.get('booking', 'mine', 'B2'), 'second');
  assert.equal(store.count('booking'), 2);
});

test('an entry older than the time to live is gone', () => {
  const { store, clock } = newStore();
  store.put('offer', 'mine', 'O1', 'offer');
  clock.ms = 1000;
  assert.equal(store.get('offer', 'mine', 'O1'), 'offer');
  clock.ms = 1001;
  assert.equal(store.get('offer', 'mine', 'O1'), undefined);
  assert.equal(store.count('offer'), 0);
});

test('a kind the store was not created with is a programming error', () => {
  const { store } = newStore();
  assert.throws(() => store.put('ticket', 'mine', 'T1', {}), /unknown kind/);
  assert.throws(() => store.get('ticket', 'mine', 'T1'), /unknown kind/);
});
