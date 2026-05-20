// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-envutils.test.js — first test of the Bruno scenario engine
 * (Bruno_Collection/library-bruno), establishing the harness pattern.
 *
 * The library modules expect a global `bru` (Bruno's sandbox API: getEnvVar /
 * setEnvVar) and use globalThis injection. We mock `bru` BEFORE requiring the
 * module under test. envUtils has zero dependencies, so loading it pulls only
 * itself into coverage — it cannot endanger the CI global coverage gate.
 *
 * Module under test: envUtils.parseEnvJson (added v1.11.18, audit #84) — the
 * safe accessor that turns the two silent failure modes of
 * `JSON.parse(bru.getEnvVar(x))` into actionable errors.
 */

let store = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
  setEnvVar: (k, v) => { store[k] = v; },
};

const { parseEnvJson } = require('../../../Bruno_Collection/library-bruno/envUtils.js');

beforeEach(() => { store = {}; });

describe('library-bruno envUtils.parseEnvJson', () => {
  test('parses a valid JSON object', () => {
    store.x = '{"a":1,"b":[2,3]}';
    expect(parseEnvJson('x')).toEqual({ a: 1, b: [2, 3] });
  });

  test('parses a valid JSON array', () => {
    store.x = '[1,2,3]';
    expect(parseEnvJson('x')).toEqual([1, 2, 3]);
  });

  test('required + missing → throws, naming the variable + cause', () => {
    expect(() => parseEnvJson('offerSearchCriteria'))
      .toThrow(/Required scenario variable "offerSearchCriteria"/);
    expect(() => parseEnvJson('offerSearchCriteria'))
      .toThrow(/getScenarioData/);
  });

  test('required + empty string → throws', () => {
    store.x = '';
    expect(() => parseEnvJson('x')).toThrow(/Required scenario variable "x"/);
  });

  test('optional + missing → returns the fallback (no throw)', () => {
    expect(parseEnvJson('x', [])).toEqual([]);
    expect(parseEnvJson('y', { d: 1 })).toEqual({ d: 1 });
  });

  test('optional + empty string → returns the fallback', () => {
    store.x = '';
    expect(parseEnvJson('x', [])).toEqual([]);
  });

  test('optional but PRESENT → parses the value (fallback ignored)', () => {
    store.x = '[9]';
    expect(parseEnvJson('x', [])).toEqual([9]);
  });

  test('malformed JSON → throws, naming the variable', () => {
    store.x = '{not valid';
    expect(() => parseEnvJson('x')).toThrow(/"x" is not valid JSON/);
  });

  test('malformed JSON throws even WITH a fallback (value present but bad)', () => {
    // The fallback applies only to a MISSING var, not to malformed JSON —
    // a corrupt value is a real error we want surfaced, not silently dropped.
    store.x = '{bad';
    expect(() => parseEnvJson('x', [])).toThrow(/"x" is not valid JSON/);
  });

  test('non-string value passes through unchanged (already-parsed sandbox value)', () => {
    store.x = { already: 'parsed' };
    expect(parseEnvJson('x')).toEqual({ already: 'parsed' });
  });

  test('the JSON null literal parses to null', () => {
    store.x = 'null';
    expect(parseEnvJson('x', [])).toBeNull();
  });
});
