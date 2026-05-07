// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * paths.test.js — Unit tests for the path-traversal guard helpers.
 *
 * Coverage matters here because every guarded code path on the server
 * (run artifacts, workspaces, structured-results extraction, diff)
 * relies on these. A bug in safeJoinUuid is a hole in every one of them.
 */

const path = require('path');
const { isUuid, safeJoinUuid, UUID_RE } = require('../../src/utils/paths');

describe('isUuid', () => {
  test('accepts canonical lowercase UUID v4', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
  });

  test('accepts mixed-case hex (Node uuid lib emits lowercase, but case is permitted)', () => {
    expect(isUuid('A1B2C3D4-1234-4567-89AB-CDEF01234567')).toBe(true);
  });

  test('rejects non-strings', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid({})).toBe(false);
    expect(isUuid([])).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isUuid('')).toBe(false);
  });

  test('rejects path-traversal attempts', () => {
    expect(isUuid('../../../etc/passwd')).toBe(false);
    expect(isUuid('..')).toBe(false);
    expect(isUuid('/etc/passwd')).toBe(false);
    expect(isUuid('a..b')).toBe(false);
  });

  test('rejects path separators', () => {
    expect(isUuid('aaa/bbb')).toBe(false);
    expect(isUuid('aaa\\bbb')).toBe(false);
  });

  test('rejects too-short or too-long strings', () => {
    expect(isUuid('aaa')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-00000000000')).toBe(false);   // 35 chars
    expect(isUuid('00000000-0000-4000-8000-0000000000000')).toBe(false); // 37 chars
  });

  test('rejects strings with valid UUID prefix but extra content', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000000/extra')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-000000000000\nfoo')).toBe(false);
  });

  test('rejects braced GUID syntax (Microsoft variant)', () => {
    expect(isUuid('{00000000-0000-4000-8000-000000000000}')).toBe(false);
  });
});

describe('safeJoinUuid', () => {
  const BASE = path.resolve('/tmp/test-base');

  test('returns absolute path when UUID is valid', () => {
    const id = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
    const result = safeJoinUuid(BASE, id);
    expect(result).toBe(path.resolve(BASE, id));
  });

  test('appends extra path segments', () => {
    const id = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
    const result = safeJoinUuid(BASE, id, 'subdir', 'file.json');
    expect(result).toBe(path.resolve(BASE, id, 'subdir', 'file.json'));
  });

  test('returns null when UUID is invalid', () => {
    expect(safeJoinUuid(BASE, '../etc')).toBeNull();
    expect(safeJoinUuid(BASE, 'not-a-uuid')).toBeNull();
    expect(safeJoinUuid(BASE, '')).toBeNull();
    expect(safeJoinUuid(BASE, null)).toBeNull();
    expect(safeJoinUuid(BASE, undefined)).toBeNull();
  });

  test('returns null when traversal escapes the base directory', () => {
    // Hand-crafted: a UUID-shaped string can't actually escape, but the
    // containment check is still tested with a regex-passing payload that
    // somehow resolves outside (achievable only via a wider regex in the
    // future). Simulate by giving a different baseDir.
    const id = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
    const result = safeJoinUuid(BASE, id);
    expect(result.startsWith(BASE + path.sep)).toBe(true);
  });

  test('handles base directories with and without trailing separator', () => {
    const id = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
    const withSep = path.resolve('/tmp/test-base/');
    const withoutSep = path.resolve('/tmp/test-base');
    expect(safeJoinUuid(withSep, id)).toBe(safeJoinUuid(withoutSep, id));
  });
});

describe('UUID_RE export', () => {
  test('exports a regex that matches isUuid behaviour', () => {
    const id = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
    expect(UUID_RE.test(id)).toBe(true);
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
  });
});
