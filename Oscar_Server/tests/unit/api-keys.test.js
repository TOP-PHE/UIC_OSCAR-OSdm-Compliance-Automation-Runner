// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/** api-keys.test.js — the shape of an API key (#503), utils/apiKeys.js. */

const K = require('../../src/utils/apiKeys');

describe('a new key', () => {
  test('is oscar_<8 hex>_<43 base64url>, parses back, and its hash matches', () => {
    const made = K.newKey();
    expect(made.key).toMatch(/^oscar_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const parsed = K.parseKey(made.key);
    expect(parsed.prefix).toBe(made.prefix);
    expect(K.secretMatches(parsed.secret, made.secretHash)).toBe(true);
    expect(K.secretMatches(parsed.secret + 'x', made.secretHash)).toBe(false);
  });

  test('two keys never share a prefix or a secret (in 2,000 draws)', () => {
    const keys = Array.from({ length: 2000 }, () => K.newKey());
    expect(new Set(keys.map(k => k.prefix)).size).toBe(2000);
    expect(new Set(keys.map(k => k.key)).size).toBe(2000);
  });
});

describe('reading a key', () => {
  test.each([
    ['', null], [null, null], [42, null],
    ['oscar_', null], ['oscar_ABCDEF12_' + 'a'.repeat(43), null],
    ['oscar_abcdef12_' + 'a'.repeat(42), null], ['oscar_abcdef12_' + 'a'.repeat(44), null],
    [' oscar_abcdef12_' + 'a'.repeat(43), null], ['oscar_abcdef12_' + 'a'.repeat(42) + '=', null],
  ])('%j is not a key', (value, expected) => {
    expect(K.parseKey(value)).toBe(expected);
  });

  test('a stored hash that is not one never matches', () => {
    expect(K.secretMatches('x', null)).toBe(false);
    expect(K.secretMatches('x', 'not-a-hash')).toBe(false);
    expect(K.secretMatches('x', K.hashOf('x').toUpperCase())).toBe(false);
  });

  test('only an oscar_ token looks like a key', () => {
    expect(K.looksLikeKey('oscar_whatever')).toBe(true);
    expect(K.looksLikeKey('eyJhbGciOi')).toBe(false);
    expect(K.looksLikeKey(null)).toBe(false);
  });
});

describe('name, lifetime and state', () => {
  test('lifetime: absent is 90 days, 1 to 365 whole days, nothing else', () => {
    expect(K.lifetimeOf(undefined)).toEqual({ days: 90 });
    expect(K.lifetimeOf('')).toEqual({ days: 90 });
    expect(K.lifetimeOf(365)).toEqual({ days: 365 });
    expect(K.lifetimeOf('30')).toEqual({ days: 30 });
    for (const bad of [0, 366, -1, 2.5, 'abc', true]) expect(K.lifetimeOf(bad).error).toBeTruthy();
  });

  test('name: trimmed, required, 80 characters at most', () => {
    expect(K.nameOf('  CI  ')).toEqual({ name: 'CI' });
    expect(K.nameOf('').error).toBeTruthy();
    expect(K.nameOf(12).error).toBeTruthy();
    expect(K.nameOf('x'.repeat(81)).error).toBeTruthy();
  });

  test('expiry is SQLite UTC text, and a row is usable until then', () => {
    const now = new Date('2026-10-18T10:00:00Z');
    expect(K.expiryAfter(1, now)).toBe('2026-10-19 10:00:00');
    expect(K.unusableBecause({ expires_at: '2026-10-19 10:00:00' }, now)).toBeNull();
    expect(K.unusableBecause({ expires_at: '2026-10-18 10:00:00' }, now)).toBe('expired');
    expect(K.unusableBecause({ expires_at: 'garbage' }, now)).toBe('expired');
    expect(K.unusableBecause({ expires_at: '2026-10-19 10:00:00', revoked_at: '2026-10-18 09:00:00' }, now)).toBe('revoked');
    expect(K.unusableBecause(null, now)).toBe('unknown');
  });
});
