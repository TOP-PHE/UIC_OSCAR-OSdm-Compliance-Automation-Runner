// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * diff.test.js — Unit tests for the run comparison / diff engine
 *
 * Uses jest.spyOn to mock fs so no real artifact files are needed.
 * Covers all six diff categories:
 *   ADDED, REMOVED, FAILED_TO_PASSED, PASSED_TO_FAILED,
 *   UNCHANGED_PASS, UNCHANGED_FAIL
 * and Bruno CLI output format variations.
 */

const fs   = require('fs');
const path = require('path');

// We need to mock fs BEFORE requiring diff.js so the module picks up the mock.
// jest.mock is hoisted automatically, but for spyOn we use beforeAll.
jest.mock('fs');

const { compareRuns } = require('../../src/reports/diff');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockResultsFile(runId, results) {
  // diff.js: const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
  // It builds: path.join(ARTIFACTS_DIR, runId, '.bru_results.json')
  const ARTIFACTS_DIR = path.resolve(
    __dirname,
    '../../src/reports/../../data/artifacts'
  );
  const expectedPath = path.join(ARTIFACTS_DIR, runId, '.bru_results.json');

  fs.existsSync.mockImplementation((p) => p === expectedPath);
  fs.readFileSync.mockImplementation((p) => {
    if (p === expectedPath) return JSON.stringify(results);
    throw new Error(`Unexpected readFileSync call for: ${p}`);
  });
}

function mockTwoRunsFiles(runIdA, resultsA, runIdB, resultsB) {
  const ARTIFACTS_DIR = path.resolve(
    __dirname,
    '../../src/reports/../../data/artifacts'
  );
  const pathA = path.join(ARTIFACTS_DIR, runIdA, '.bru_results.json');
  const pathB = path.join(ARTIFACTS_DIR, runIdB, '.bru_results.json');

  fs.existsSync.mockImplementation((p) => p === pathA || p === pathB);
  fs.readFileSync.mockImplementation((p) => {
    if (p === pathA) return JSON.stringify(resultsA);
    if (p === pathB) return JSON.stringify(resultsB);
    throw new Error(`Unexpected readFileSync call for: ${p}`);
  });
}

// Minimal Bruno result entry with one test
function makeEntry(suite, filename, testName, passed) {
  return {
    suiteName: suite,
    filename,
    tests: [{ name: testName, status: passed ? 'passed' : 'failed' }],
    assertions: [],
  };
}

// ── Error handling ─────────────────────────────────────────────────────────────

describe('compareRuns — missing artifact files', () => {
  beforeEach(() => {
    fs.existsSync.mockReturnValue(false);
  });

  test('throws when run A artifact is missing', () => {
    expect(() => compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toThrow(/run A/i);
  });

  test('throws when run B artifact is missing', () => {
    const ARTIFACTS_DIR = path.resolve(
      __dirname,
      '../../src/reports/../../data/artifacts'
    );
    const pathA = path.join(ARTIFACTS_DIR, '11111111-1111-4111-8111-111111111111', '.bru_results.json');

    fs.existsSync.mockImplementation((p) => p === pathA);
    fs.readFileSync.mockReturnValue(JSON.stringify([]));
    expect(() => compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toThrow(/run B/i);
  });
});

// ── Empty results ──────────────────────────────────────────────────────────────

describe('compareRuns — empty results', () => {
  test('empty results → zeroed summary with no items', () => {
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [], '22222222-2222-4222-8222-222222222222', []);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(0);
    expect(diff.items).toHaveLength(0);
  });
});

// ── Diff categories ────────────────────────────────────────────────────────────

describe('compareRuns — UNCHANGED_PASS', () => {
  test('assertion passes in both runs → UNCHANGED_PASS', () => {
    const entry = makeEntry('Suite1', 'req1.bru', 'status code is 200', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.unchanged_pass).toBe(1);
    expect(diff.summary.total).toBe(1);
    expect(diff.items[0].category).toBe('UNCHANGED_PASS');
  });
});

describe('compareRuns — UNCHANGED_FAIL', () => {
  test('assertion fails in both runs → UNCHANGED_FAIL', () => {
    const entry = makeEntry('Suite1', 'req1.bru', 'status code is 200', false);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.unchanged_fail).toBe(1);
    expect(diff.items[0].category).toBe('UNCHANGED_FAIL');
  });
});

describe('compareRuns — FAILED_TO_PASSED', () => {
  test('failed in A, passed in B → FAILED_TO_PASSED', () => {
    const entryA = makeEntry('Suite1', 'req1.bru', 'offer array exists', false);
    const entryB = makeEntry('Suite1', 'req1.bru', 'offer array exists', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entryA], '22222222-2222-4222-8222-222222222222', [entryB]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.failed_to_passed).toBe(1);
    expect(diff.items[0].category).toBe('FAILED_TO_PASSED');
  });
});

describe('compareRuns — PASSED_TO_FAILED', () => {
  test('passed in A, failed in B → PASSED_TO_FAILED', () => {
    const entryA = makeEntry('Suite1', 'req1.bru', 'offer array exists', true);
    const entryB = makeEntry('Suite1', 'req1.bru', 'offer array exists', false);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entryA], '22222222-2222-4222-8222-222222222222', [entryB]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.passed_to_failed).toBe(1);
    expect(diff.items[0].category).toBe('PASSED_TO_FAILED');
  });
});

describe('compareRuns — ADDED', () => {
  test('assertion only in B → ADDED', () => {
    const entryB = makeEntry('SuiteNew', 'req2.bru', 'new assertion', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [], '22222222-2222-4222-8222-222222222222', [entryB]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.added).toBe(1);
    expect(diff.items[0].category).toBe('ADDED');
    expect(diff.items[0].run_a).toBeNull();
    expect(diff.items[0].run_b).not.toBeNull();
  });
});

describe('compareRuns — REMOVED', () => {
  test('assertion only in A → REMOVED', () => {
    const entryA = makeEntry('OldSuite', 'req3.bru', 'old assertion', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entryA], '22222222-2222-4222-8222-222222222222', []);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.removed).toBe(1);
    expect(diff.items[0].category).toBe('REMOVED');
    expect(diff.items[0].run_a).not.toBeNull();
    expect(diff.items[0].run_b).toBeNull();
  });
});

// ── Mixed results ──────────────────────────────────────────────────────────────

describe('compareRuns — mixed categories', () => {
  test('computes summary totals correctly across multiple assertions', () => {
    const entriesA = [
      makeEntry('S', 'f.bru', 'assertion-pass-both', true),
      makeEntry('S', 'f.bru', 'assertion-fail-both', false),
      makeEntry('S', 'f.bru', 'assertion-was-failing', false),
      makeEntry('S', 'f.bru', 'assertion-was-passing', true),
      makeEntry('S', 'f.bru', 'assertion-removed', true),
    ];
    const entriesB = [
      makeEntry('S', 'f.bru', 'assertion-pass-both', true),
      makeEntry('S', 'f.bru', 'assertion-fail-both', false),
      makeEntry('S', 'f.bru', 'assertion-was-failing', true),    // fixed
      makeEntry('S', 'f.bru', 'assertion-was-passing', false),   // regressed
      makeEntry('S', 'f.bru', 'assertion-added', true),
    ];
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', entriesA, '22222222-2222-4222-8222-222222222222', entriesB);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.unchanged_pass).toBe(1);
    expect(diff.summary.unchanged_fail).toBe(1);
    expect(diff.summary.failed_to_passed).toBe(1);
    expect(diff.summary.passed_to_failed).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.total).toBe(6);
  });

  test('items are sorted: PASSED_TO_FAILED first, UNCHANGED_PASS last', () => {
    const entriesA = [
      makeEntry('S', 'f.bru', 'regression', true),
      makeEntry('S', 'f.bru', 'stable-pass', true),
    ];
    const entriesB = [
      makeEntry('S', 'f.bru', 'regression', false),
      makeEntry('S', 'f.bru', 'stable-pass', true),
    ];
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', entriesA, '22222222-2222-4222-8222-222222222222', entriesB);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.items[0].category).toBe('PASSED_TO_FAILED');
    expect(diff.items[diff.items.length - 1].category).toBe('UNCHANGED_PASS');
  });
});

// ── Item shape ─────────────────────────────────────────────────────────────────

describe('compareRuns — item structure', () => {
  test('diff item has suite, request, assertion, run_a, run_b, category fields', () => {
    const entry = makeEntry('MySuite', 'myRequest.bru', 'my assertion text', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    const item = diff.items[0];
    expect(item).toHaveProperty('key');
    expect(item).toHaveProperty('suite');
    expect(item).toHaveProperty('request');
    expect(item).toHaveProperty('assertion');
    expect(item).toHaveProperty('category');
    expect(item).toHaveProperty('run_a');
    expect(item).toHaveProperty('run_b');
    expect(item.run_a).toHaveProperty('passed');
    expect(item.run_b).toHaveProperty('passed');
  });

  test('key format includes suite, filename (without extension), and assertion', () => {
    const entry = makeEntry('Suite', 'request.bru', 'assertion name', true);
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    // key = "{suite}|{filename_without_ext}|{assertion}"
    expect(diff.items[0].key).toContain('Suite');
    expect(diff.items[0].key).toContain('assertion name');
  });
});

// ── Bruno CLI output format variations ────────────────────────────────────────

describe('compareRuns — Bruno CLI format variations', () => {
  test('raw array of results (v1 flat)', () => {
    const results = [makeEntry('S', 'f.bru', 'test', true)];
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', results, '22222222-2222-4222-8222-222222222222', results);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(1);
  });

  test('raw.results wrapper', () => {
    const results = { results: [makeEntry('S', 'f.bru', 'test', true)] };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', results, '22222222-2222-4222-8222-222222222222', results);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(1);
  });

  test('raw.testResults wrapper', () => {
    const results = { testResults: [makeEntry('S', 'f.bru', 'test', true)] };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', results, '22222222-2222-4222-8222-222222222222', results);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(1);
  });

  test('entries use testResults field name (not tests)', () => {
    const entry = {
      suiteName: 'S',
      filename: 'f.bru',
      testResults: [{ name: 'assertion', status: 'passed' }],
      assertions: [],
    };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(1);
  });

  test('entries with assertions field', () => {
    const entry = {
      suiteName: 'S',
      filename: 'f.bru',
      tests: [],
      assertions: [{ name: 'http.status == 200', status: 'passed', passed: true }],
    };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(1);
    expect(diff.summary.unchanged_pass).toBe(1);
  });
});

// ── Auth URL filtering ─────────────────────────────────────────────────────────

describe('compareRuns — auth URL filtering', () => {
  test('entries with /token URL are skipped', () => {
    const tokenEntry = {
      suiteName: 'Auth',
      filename: 'get-token.bru',
      request: { url: 'https://api.example.com/token' },
      tests: [{ name: 'token obtained', status: 'passed' }],
      assertions: [],
    };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [tokenEntry], '22222222-2222-4222-8222-222222222222', [tokenEntry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(0);  // auth entry skipped
  });

  test('entries with /login URL are skipped', () => {
    const entry = {
      suiteName: 'Auth',
      filename: 'login.bru',
      request: { url: 'https://api.example.com/login' },
      tests: [{ name: 'login ok', status: 'passed' }],
      assertions: [],
    };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(0);
  });

  test('entries with "access token" in the name are skipped', () => {
    const entry = {
      suiteName: 'Auth',
      filename: 'GetAccessToken.bru',
      tests: [{ name: 'access token valid', status: 'passed' }],
      assertions: [],
    };
    mockTwoRunsFiles('11111111-1111-4111-8111-111111111111', [entry], '22222222-2222-4222-8222-222222222222', [entry]);
    const diff = compareRuns('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(diff.summary.total).toBe(0);
  });
});
