// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1004: the OSCAR server's address gets a limit of its own, every other
// caller keeps the ordinary one.

const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter, plainAddress } = require('../src/app');
const { loadSettings } = require('../src/config');

test('a trusted address counts against its own, higher limit', () => {
  const allow = createRateLimiter({ perMinute: 2, trustedPerMinute: 4, trusted: new Set(['203.0.113.10']), now: () => 0 });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => allow('203.0.113.10')), [true, true, true, true, false]);
  assert.deepEqual([1, 2, 3].map(() => allow('198.51.100.7')), [true, true, false]);
});

test('the IPv4 form a dual-stack socket gives is the same address', () => {
  assert.equal(plainAddress('::ffff:203.0.113.10'), '203.0.113.10');
  assert.equal(plainAddress('::FFFF:203.0.113.10'), '203.0.113.10');
  assert.equal(plainAddress('2001:db8::1'), '2001:db8::1');
  const allow = createRateLimiter({ perMinute: 1, trustedPerMinute: 3, trusted: new Set(['203.0.113.10']), now: () => 0 });
  assert.deepEqual([1, 2, 3].map(() => allow('::ffff:203.0.113.10')), [true, true, true]);
});

test('without trusted addresses every caller has the ordinary limit, as before', () => {
  const allow = createRateLimiter({ perMinute: 1, now: () => 0 });
  assert.deepEqual([allow('203.0.113.10'), allow('203.0.113.10')], [true, false]);
});

test('settings: SIM_TRUSTED_ADDRESSES is a list of IP addresses, with its own limit', () => {
  const none = loadSettings({}, '/b').limits;
  assert.deepEqual(none.trustedAddresses, []);
  assert.equal(none.trustedRequestsPerMinute, 30000);
  const set = loadSettings({ SIM_TRUSTED_ADDRESSES: '203.0.113.10, 2001:DB8::1 203.0.113.10', SIM_TRUSTED_REQUESTS_PER_MINUTE: '50000' }, '/b').limits;
  assert.deepEqual(set.trustedAddresses, ['203.0.113.10', '2001:db8::1']);
  assert.equal(set.trustedRequestsPerMinute, 50000);
  assert.throws(() => loadSettings({ SIM_TRUSTED_ADDRESSES: 'oscar.example.org' }, '/b'), /IP addresses only, not: oscar\.example\.org/);
  assert.throws(() => loadSettings({ SIM_TRUSTED_REQUESTS_PER_MINUTE: '5' }, '/b'), /between 10 and 1000000/);
});
