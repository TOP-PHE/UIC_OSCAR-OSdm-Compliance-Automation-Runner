// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdm-client.test.js — Unit tests for mergeDedicatedHeaders (#477).
 *
 * Every server-side direct-call route (Timetable Discovery, Re-probe,
 * Places refresh) shares this helper, so a bug here is a gap in all three.
 * End-to-end coverage (real route + stubbed fetch) lives in
 * tests/integration/company-test-resources-routes.test.js and
 * tests/integration/company-places.test.js; this file isolates the pure
 * merge/template-resolution logic and its edge cases.
 */

const { mergeDedicatedHeaders } = require('../../src/utils/osdm-client');

describe('mergeDedicatedHeaders', () => {
  test('merges a literal-value dedicated header', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'tracestate', value: 'processid=abc' }]) });
    expect(headers.tracestate).toBe('processid=abc');
  });

  test('resolves a {{var}} template against resolvedVars', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'authorization-echo', value: 'Bearer {{access_token}}' }]) }, { access_token: 'tok-123' });
    expect(headers['authorization-echo']).toBe('Bearer tok-123');
  });

  test('an unresolved var becomes an empty string, never the literal {{...}}', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'x-unknown', value: 'prefix-{{does_not_exist}}-suffix' }]) }, { access_token: 'tok-123' });
    expect(headers['x-unknown']).toBe('prefix--suffix');
  });

  test('var matching is case-sensitive, same as the Bruno run path', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'x-case', value: '{{Access_Token}}' }]) }, { access_token: 'tok-123' });
    expect(headers['x-case']).toBe('');
  });

  test('missing extra_headers is a no-op', () => {
    const headers = { Requestor: 'r1' };
    mergeDedicatedHeaders(headers, { extra_headers: null });
    expect(headers).toEqual({ Requestor: 'r1' });
  });

  test('missing companyRow is a no-op (never throws)', () => {
    const headers = {};
    expect(() => mergeDedicatedHeaders(headers, null)).not.toThrow();
    expect(headers).toEqual({});
  });

  test('malformed extra_headers JSON fails open — no throw, headers untouched', () => {
    const headers = { Requestor: 'r1' };
    expect(() => mergeDedicatedHeaders(headers, { extra_headers: '{not json' })).not.toThrow();
    expect(headers).toEqual({ Requestor: 'r1' });
  });

  test('a non-array extra_headers value is ignored', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify({ name: 'x', value: 'y' }) });
    expect(headers).toEqual({});
  });

  test('an entry without a name is skipped', () => {
    const headers = {};
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ value: 'orphan' }, { name: 'ok', value: 'v' }]) });
    expect(headers).toEqual({ ok: 'v' });
  });

  test('a dedicated header can override an existing entry (explicit config wins)', () => {
    const headers = { Requestor: 'auto-resolved' };
    mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'Requestor', value: 'manual-override' }]) });
    expect(headers.Requestor).toBe('manual-override');
  });

  test('returns the same (mutated) object it was given', () => {
    const headers = {};
    const result = mergeDedicatedHeaders(headers, { extra_headers: JSON.stringify([{ name: 'a', value: 'b' }]) });
    expect(result).toBe(headers);
  });
});
