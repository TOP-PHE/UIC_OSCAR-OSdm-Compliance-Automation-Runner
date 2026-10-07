// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-secrets.test.js — utils/runSecrets.js (tracker S8-loopback).
 *
 * The runner issues a secret per run and the two loopback routes verify it.
 * Pure in-memory, so nothing is mocked.
 */

const runSecrets = require('../../src/utils/runSecrets');

afterEach(() => runSecrets._clear());

describe('runSecrets', () => {
  test('a freshly issued secret verifies to the run\'s company', () => {
    const secret = runSecrets.issue('run-1', 'company-A');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);               // 32 random bytes, hex
    expect(runSecrets.verify('run-1', secret)).toBe('company-A');
  });

  test('two runs get different secrets, each bound to its own company', () => {
    const a = runSecrets.issue('run-a', 'company-A');
    const b = runSecrets.issue('run-b', 'company-B');
    expect(a).not.toBe(b);
    expect(runSecrets.verify('run-a', a)).toBe('company-A');
    expect(runSecrets.verify('run-b', b)).toBe('company-B');
    expect(runSecrets.verify('run-a', b)).toBeNull();       // b's secret is not a's
    expect(runSecrets.verify('run-b', a)).toBeNull();
  });

  test('the wrong secret, the wrong run, and anything not a string give null', () => {
    const secret = runSecrets.issue('run-1', 'company-A');
    expect(runSecrets.verify('run-1', 'deadbeef'.repeat(8))).toBeNull();   // right length, wrong value
    expect(runSecrets.verify('run-1', secret + 'x')).toBeNull();           // wrong length
    expect(runSecrets.verify('run-1', '')).toBeNull();
    expect(runSecrets.verify('run-2', secret)).toBeNull();                 // unknown run
    for (const bad of [null, undefined, 7, {}, [], true]) {
      expect(runSecrets.verify('run-1', bad)).toBeNull();
    }
    for (const badRun of [null, undefined, '', 0]) {
      expect(runSecrets.verify(badRun, secret)).toBeNull();
    }
  });

  test('a revoked secret no longer verifies; revoke is idempotent', () => {
    const secret = runSecrets.issue('run-1', 'company-A');
    runSecrets.revoke('run-1');
    expect(runSecrets.verify('run-1', secret)).toBeNull();
    expect(() => runSecrets.revoke('run-1')).not.toThrow();
    expect(() => runSecrets.revoke('never-existed')).not.toThrow();
  });

  test('re-issuing for the same run replaces the old secret', () => {
    const first = runSecrets.issue('run-1', 'company-A');
    const second = runSecrets.issue('run-1', 'company-A');
    expect(second).not.toBe(first);
    expect(runSecrets.verify('run-1', first)).toBeNull();
    expect(runSecrets.verify('run-1', second)).toBe('company-A');
  });
});
