// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * structureResults.test.js — Unit tests for structureResults pure helpers
 *
 * The two exported pure helpers (classifyVendorCapability, serializeBounded)
 * have no database dependency.
 *
 * db.js is mocked here so that these tests run on Node < 22 as well.
 * extractStructuredResults() is not unit-tested here because it requires
 * both a live database (Node 22+) and real artifact files on disk.
 */

// Mock db.js so the node:sqlite dependency is never loaded
jest.mock('../../src/db/db', () => ({
  run: jest.fn(),
  get: jest.fn(),
  all: jest.fn().mockReturnValue([]),
  transaction: jest.fn((fn) => fn()),
  encrypt: jest.fn((v) => v),
  decrypt: jest.fn((v) => v),
  getConfig: jest.fn().mockReturnValue(''),
}));

const {
  classifyVendorCapability,
  serializeBounded,
} = require('../../src/reports/structureResults');

// ── classifyVendorCapability ──────────────────────────────────────────────────

describe('classifyVendorCapability', () => {
  // NOT_APPLICABLE — httpStatus === 0 (library-bruno "attempted but inapplicable")
  test('httpStatus 0 → NOT_APPLICABLE', () => {
    expect(classifyVendorCapability(0, 0, 0)).toBe('NOT_APPLICABLE');
  });
  test('httpStatus "0" (string) → NOT_APPLICABLE', () => {
    expect(classifyVendorCapability('0', 0, 0)).toBe('NOT_APPLICABLE');
  });

  // NOT_IMPLEMENTED — 501 or 404
  test('httpStatus 501 → NOT_IMPLEMENTED', () => {
    expect(classifyVendorCapability(501, 0, 0)).toBe('NOT_IMPLEMENTED');
  });
  test('httpStatus 404 → NOT_IMPLEMENTED', () => {
    expect(classifyVendorCapability(404, 5, 3)).toBe('NOT_IMPLEMENTED');
  });
  test('httpStatus "404" (string) → NOT_IMPLEMENTED', () => {
    expect(classifyVendorCapability('404', 1, 1)).toBe('NOT_IMPLEMENTED');
  });

  // ERROR — 5xx other than 501
  test('httpStatus 500 → ERROR', () => {
    expect(classifyVendorCapability(500, 0, 0)).toBe('ERROR');
  });
  test('httpStatus 503 → ERROR', () => {
    expect(classifyVendorCapability(503, 2, 1)).toBe('ERROR');
  });

  // IMPLEMENTED — 2xx with all assertions passing (or none)
  test('httpStatus 200, 0 assertions → IMPLEMENTED', () => {
    expect(classifyVendorCapability(200, 0, 0)).toBe('IMPLEMENTED');
  });
  test('httpStatus 201, all assertions pass → IMPLEMENTED', () => {
    expect(classifyVendorCapability(201, 5, 0)).toBe('IMPLEMENTED');
  });
  test('httpStatus 204, 0 assertions → IMPLEMENTED', () => {
    expect(classifyVendorCapability(204, 0, 0)).toBe('IMPLEMENTED');
  });

  // PARTIAL — 2xx but some assertions failed
  test('httpStatus 200, 1 of 3 failed → PARTIAL', () => {
    expect(classifyVendorCapability(200, 3, 1)).toBe('PARTIAL');
  });
  test('httpStatus 201, all failed → PARTIAL', () => {
    expect(classifyVendorCapability(201, 2, 2)).toBe('PARTIAL');
  });

  // null — inconclusive (non-2xx, non-error, non-404/501, or NaN)
  test('httpStatus null → null', () => {
    expect(classifyVendorCapability(null, 0, 0)).toBeNull();
  });
  test('httpStatus undefined → null', () => {
    expect(classifyVendorCapability(undefined, 0, 0)).toBeNull();
  });
  test('httpStatus NaN string → null', () => {
    expect(classifyVendorCapability('not-a-number', 0, 0)).toBeNull();
  });
  test('httpStatus 400 → null (client error, not mapped)', () => {
    expect(classifyVendorCapability(400, 0, 0)).toBeNull();
  });
  test('httpStatus 401 → null', () => {
    expect(classifyVendorCapability(401, 0, 0)).toBeNull();
  });
  test('httpStatus 302 → null (redirect)', () => {
    expect(classifyVendorCapability(302, 0, 0)).toBeNull();
  });
});

// ── serializeBounded ──────────────────────────────────────────────────────────

describe('serializeBounded', () => {
  test('null → null', () => {
    expect(serializeBounded(null)).toBeNull();
  });

  test('undefined → null', () => {
    expect(serializeBounded(undefined)).toBeNull();
  });

  test('empty string → null', () => {
    expect(serializeBounded('')).toBeNull();
  });

  test('short string passes through unchanged', () => {
    expect(serializeBounded('hello')).toBe('hello');
  });

  test('object is JSON-serialized', () => {
    const obj = { key: 'value', num: 42 };
    expect(serializeBounded(obj)).toBe(JSON.stringify(obj));
  });

  test('array is JSON-serialized', () => {
    const arr = [1, 2, 3];
    expect(serializeBounded(arr)).toBe(JSON.stringify(arr));
  });

  test('string shorter than MAX_BODY_SIZE passes through', () => {
    const short = 'a'.repeat(100);
    expect(serializeBounded(short)).toBe(short);
  });

  test('string at exactly MAX_BODY_SIZE passes through', () => {
    // Default MAX_BODY_SIZE = 102400
    const maxSize = parseInt(process.env.MAX_BODY_SIZE || '102400', 10);
    const exact = 'x'.repeat(maxSize);
    expect(serializeBounded(exact)).toBe(exact);
  });

  test('string exceeding MAX_BODY_SIZE is truncated with marker', () => {
    const maxSize = parseInt(process.env.MAX_BODY_SIZE || '102400', 10);
    const oversized = 'z'.repeat(maxSize + 500);
    const result = serializeBounded(oversized);
    expect(result.length).toBeLessThan(oversized.length);
    expect(result).toMatch(/\[truncated \d+ bytes\]/);
  });

  test('object that exceeds size limit is truncated', () => {
    const maxSize = parseInt(process.env.MAX_BODY_SIZE || '102400', 10);
    // Build an object whose JSON exceeds the limit
    const big = { data: 'x'.repeat(maxSize + 200) };
    const result = serializeBounded(big);
    expect(result).toMatch(/\[truncated \d+ bytes\]/);
  });

  test('truncated result starts with the original data (not garbage)', () => {
    const maxSize = parseInt(process.env.MAX_BODY_SIZE || '102400', 10);
    const oversized = 'ab'.repeat(maxSize);
    const result = serializeBounded(oversized);
    // Cut = maxSize - 32, so the first maxSize-32 chars should be original
    const cut = maxSize - 32;
    expect(result.slice(0, 10)).toBe(oversized.slice(0, 10));
    expect(result.slice(0, cut)).toBe(oversized.slice(0, cut));
  });
});
