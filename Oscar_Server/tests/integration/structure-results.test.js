// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * structure-results.test.js — Tests for src/reports/structureResults.js
 *
 * Two layers:
 *   1. Pure-function unit tests — classifyVendorCapability (all status /
 *      assertion-count branches) and serializeBounded (pass-through, empty,
 *      and oversized-truncation contract).
 *   2. extractStructuredResults over a SEEDED run — writes a real AES-encrypted
 *      .bru_results.json artifact (mirroring reports-routes.test.js), a company,
 *      user and run row, then drives extraction and asserts the returned
 *      { suites, requests, assertions } shape plus the DB rows it wrote:
 *      a PASS request, a FAIL request, an auth-URL redaction, and the
 *      vendor-capability classification.
 *
 * Cleanup keyed on a unique company uuid + '@structresults-test.com' email.
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');
const {
  extractStructuredResults,
  classifyVendorCapability,
  serializeBounded,
} = require('../../src/reports/structureResults');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');

// ── Pure: classifyVendorCapability ─────────────────────────────────────────────
describe('classifyVendorCapability', () => {
  test('httpStatus 0 → NOT_APPLICABLE', () => {
    expect(classifyVendorCapability(0, 0, 0)).toBe('NOT_APPLICABLE');
  });

  test('missing / NaN status → null', () => {
    expect(classifyVendorCapability(null, 0, 0)).toBeNull();
    expect(classifyVendorCapability('nonsense', 0, 0)).toBeNull();
  });

  test('501 → NOT_IMPLEMENTED', () => {
    expect(classifyVendorCapability(501, 0, 0)).toBe('NOT_IMPLEMENTED');
  });

  test('404 → NOT_IMPLEMENTED (spec-defined endpoint)', () => {
    expect(classifyVendorCapability(404, 0, 0)).toBe('NOT_IMPLEMENTED');
  });

  test('5xx other than 501 → ERROR', () => {
    expect(classifyVendorCapability(500, 3, 1)).toBe('ERROR');
    expect(classifyVendorCapability(503, 0, 0)).toBe('ERROR');
  });

  test('2xx with no assertions → IMPLEMENTED', () => {
    expect(classifyVendorCapability(200, 0, 0)).toBe('IMPLEMENTED');
  });

  test('2xx with all assertions passing → IMPLEMENTED', () => {
    expect(classifyVendorCapability(201, 4, 0)).toBe('IMPLEMENTED');
  });

  test('2xx with some assertions failing → PARTIAL', () => {
    expect(classifyVendorCapability(200, 4, 2)).toBe('PARTIAL');
  });

  test('numeric string status is parsed', () => {
    expect(classifyVendorCapability('200', 1, 0)).toBe('IMPLEMENTED');
  });

  test('3xx / other non-classified status → null', () => {
    expect(classifyVendorCapability(302, 0, 0)).toBeNull();
    expect(classifyVendorCapability(400, 0, 0)).toBeNull();
  });
});

// ── Pure: serializeBounded ─────────────────────────────────────────────────────
describe('serializeBounded', () => {
  test('null / undefined / empty string → null', () => {
    expect(serializeBounded(null)).toBeNull();
    expect(serializeBounded(undefined)).toBeNull();
    expect(serializeBounded('')).toBeNull();
  });

  test('small string passes through unchanged', () => {
    expect(serializeBounded('hello')).toBe('hello');
  });

  test('object is JSON-stringified', () => {
    expect(serializeBounded({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  test('oversized value is truncated with a marker', () => {
    const big = 'x'.repeat(200000);
    const out = serializeBounded(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/\[truncated \d+ bytes\]$/);
  });

  test('un-serializable value (circular) → null', () => {
    const circular = {};
    circular.self = circular;
    expect(serializeBounded(circular)).toBeNull();
  });
});

// ── extractStructuredResults over a seeded run ─────────────────────────────────
describe('extractStructuredResults', () => {
  const companyId = uuidv4();
  const userId    = uuidv4();
  const runId     = uuidv4();
  const artifactDir = path.join(ARTIFACTS_DIR, runId);

  beforeAll(() => {
    run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'StructResults Test', 'structresults-test')`, [companyId]);
    run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
         VALUES (?, ?, 'user@structresults-test.com', 'x', 'company_user')`, [userId, companyId]);
    run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at)
         VALUES (?, ?, ?, 'COMPLETED', 'SALE_STRUCT', datetime('now'), datetime('now'))`,
      [runId, companyId, userId]);

    // Bruno-style results: a PASS request (2xx, passing tests), a FAIL request
    // (5xx + a failing declarative assertion), and an auth/token request that
    // the extractor must SKIP entirely (URL matches /token).
    const results = [
      {
        path: 'SALE_STRUCT/01-Common/00. GET Offers.bru',
        name: 'GET Offers',
        request: { method: 'GET', url: 'https://vendor.example/offers', headers: { Accept: 'application/json' } },
        response: { status: 200, data: { offers: [{ id: 'O1' }] }, headers: { 'Content-Type': 'application/json' } },
        runDuration: 0.042,
        testResults: [
          { description: 'status is 200', status: 'pass' },
          { description: 'has an offer', status: 'pass' },
        ],
      },
      {
        path: 'SALE_STRUCT/01-Common/01. POST Booking.bru',
        name: 'POST Booking',
        request: {
          method: 'POST',
          url: 'https://vendor.example/bookings',
          headers: { Authorization: 'Bearer super-secret-token-value-1234567890' },
          data: { offerId: 'O1' },
        },
        response: { status: 500, data: { error: 'boom' }, headers: {} },
        runDuration: 0.088,
        assertionResults: [
          { name: 'status is 201', status: 'fail', error: 'got 500', lhsExpr: 'res.status', rhsExpr: '201' },
        ],
      },
      {
        // Auth/token request — must be skipped by the extractor.
        path: 'SALE_STRUCT/01-Common/02. POST Token.bru',
        name: 'Get Access Token',
        request: { method: 'POST', url: 'https://vendor.example/token', headers: {}, data: { client_secret: 'x' } },
        response: { status: 200, data: { access_token: 'abc' } },
        runDuration: 0.01,
        testResults: [{ description: 'status is 200', status: 'pass' }],
      },
    ];

    fs.mkdirSync(artifactDir, { recursive: true });
    encryptToFile(JSON.stringify(results), path.join(artifactDir, '.bru_results.json'));
  });

  afterAll(() => {
    const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
    safe('DELETE FROM run_assertions WHERE company_id = ?', [companyId]);
    safe('DELETE FROM run_requests   WHERE company_id = ?', [companyId]);
    safe('DELETE FROM run_suites     WHERE company_id = ?', [companyId]);
    safe('DELETE FROM runs           WHERE company_id = ?', [companyId]);
    safe('DELETE FROM users          WHERE company_id = ?', [companyId]);
    safe('DELETE FROM companies      WHERE id = ?', [companyId]);
    try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('returns { suites, requests, assertions } counts (auth request skipped)', () => {
    const out = extractStructuredResults(runId, companyId);
    // Auth/token request is skipped, so only the two real requests are counted.
    expect(out.suites).toBe(1);
    expect(out.requests).toBe(2);
    expect(out.assertions).toBe(3); // 2 passing tests + 1 failing assertion
  });

  test('seeded a PASS request with IMPLEMENTED capability', () => {
    const row = get(
      `SELECT * FROM run_requests WHERE run_id = ? AND request_name = 'GET Offers'`,
      [runId]
    );
    expect(row).toBeTruthy();
    expect(row.http_status).toBe(200);
    expect(row.result).toBe('PASS');
    expect(row.vendor_capability).toBe('IMPLEMENTED');
    expect(row.total).toBe(2);
    expect(row.passed).toBe(2);
    expect(row.failed).toBe(0);
  });

  test('seeded a FAIL request with ERROR capability and redacted auth header', () => {
    const row = get(
      `SELECT * FROM run_requests WHERE run_id = ? AND request_name = 'POST Booking'`,
      [runId]
    );
    expect(row).toBeTruthy();
    expect(row.http_status).toBe(500);
    expect(row.result).toBe('FAIL');
    expect(row.vendor_capability).toBe('ERROR');
    expect(row.failed).toBe(1);
    // The stored Authorization header must not contain the raw secret.
    expect(String(row.request_headers || '')).not.toContain('super-secret-token-value-1234567890');
  });

  test('auth/token request is not persisted', () => {
    const row = get(
      `SELECT * FROM run_requests WHERE run_id = ? AND request_name = 'Get Access Token'`,
      [runId]
    );
    expect(row).toBeUndefined();
  });

  test('assertions were written with pass/fail flags', () => {
    const rows = all(`SELECT passed FROM run_assertions WHERE run_id = ? ORDER BY id`, [runId]);
    expect(rows.length).toBe(3);
    const passed = rows.filter(r => r.passed === 1).length;
    const failed = rows.filter(r => r.passed === 0).length;
    expect(passed).toBe(2);
    expect(failed).toBe(1);
  });

  test('non-UUID runId short-circuits to zero counts (no DB touch)', () => {
    expect(extractStructuredResults('not-a-uuid', companyId)).toEqual({ suites: 0, requests: 0, assertions: 0 });
  });

  test('valid UUID with no artifact file → zero counts', () => {
    expect(extractStructuredResults(uuidv4(), companyId)).toEqual({ suites: 0, requests: 0, assertions: 0 });
  });
});
