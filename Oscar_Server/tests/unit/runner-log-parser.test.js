// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runner-log-parser.test.js — how worker/runner.js reads Bruno's output lines.
 *
 * LogParser turns a line into the suite / request / scenario it belongs to;
 * inferLevel decides its log level. Both feed the run page and the reports.
 * Two of their patterns were rewritten for #524 because the old ones could
 * backtrack quadratically on a long line. These tests pin what the patterns
 * accept, and that a pathological line is now handled in linear time.
 */

const { LogParser, inferLevel } = require('../../src/worker/runner');

// Generous on purpose: the old patterns needed seconds on these inputs, the
// new ones need about a millisecond, so a slow CI runner cannot blur the two.
const LINEAR_BUDGET_MS = 500;

function elapsedMs(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

describe('LogParser — Bruno request rows', () => {
  test('reads folder, request name and HTTP status from a CLI row', () => {
    const meta = new LogParser().parse('01-System Infos Requests/00. GET System Version Check (404 Not Found) - 302 ms');
    expect(meta).toMatchObject({
      category: 'system',
      phase: 'execution',
      suite_name: '01-System Infos Requests',
      request_name: '00. GET System Version Check',
      http_status: 404,
    });
  });

  test('accepts the backslash Bruno prints on Windows', () => {
    const meta = new LogParser().parse(String.raw`02-Common Requests\01. POST Get Offer (200 OK) - 1200 ms`);
    expect(meta.suite_name).toBe('02-Common Requests');
    expect(meta.request_name).toBe('01. POST Get Offer');
    expect(meta.http_status).toBe(200);
  });

  test('the request name ends before the whitespace that precedes "("', () => {
    const meta = new LogParser().parse('03-Refund/10. POST Refund Offers \t  (200 OK)');
    expect(meta.request_name).toBe('10. POST Refund Offers');
  });

  test('only the first slash separates folder from request', () => {
    const meta = new LogParser().parse('02-Common Requests/sub/04. GET Passenger (501 Not Implemented)');
    expect(meta.suite_name).toBe('02-Common Requests');
    expect(meta.request_name).toBe('sub/04. GET Passenger');
    expect(meta.http_status).toBe(501);
  });

  test('a row without an HTTP code keeps http_status null', () => {
    const meta = new LogParser().parse('00-Access Token/Bileto Access Token (request skipped via pre-request script)');
    expect(meta.suite_name).toBe('00-Access Token');
    expect(meta.request_name).toBe('Bileto Access Token');
    expect(meta.http_status).toBeNull();
  });

  test('a whitespace-only request name still counts as a row', () => {
    const meta = new LogParser().parse('folder/   (200 OK)');
    expect(meta.suite_name).toBe('folder');
    expect(meta.request_name).toBe('');
    expect(meta.http_status).toBe(200);
  });

  test.each([
    ['no whitespace before the parenthesis', 'folder/request(200 OK)'],
    ['a parenthesis in the folder part', 'fol(der)/request (200 OK)'],
    ['no slash at all', 'just a sentence (with a remark)'],
    ['library narration with a level tag', '[DEBUG] Report updated → /app/reports/report.html (39 assertions)'],
  ])('is not a request row: %s', (_label, line) => {
    const meta = new LogParser().parse(line);
    expect(meta.suite_name).toBeNull();
    expect(meta.request_name).toBeNull();
  });

  test('a long run of spaces with no "(" is rejected in linear time', () => {
    const parser = new LogParser();
    const line = 'x a/' + ' '.repeat(50000) + 'x';
    let meta;
    expect(elapsedMs(() => { meta = parser.parse(line); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(meta.suite_name).toBeNull();
  });
});

describe('LogParser — scenario boundary lines', () => {
  test('start line sets the scenario and its position in the batch', () => {
    const meta = new LogParser().parse('▶  Starting scenario [1/8]: OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG');
    expect(meta).toMatchObject({
      event_kind: 'scenario_start',
      category: 'system',
      scenario_name: 'OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG',
      attempt_index: 1,
      attempt_total: 8,
    });
  });

  test('skip line, with a hyphen in the scenario code', () => {
    const meta = new LogParser().parse('⏭  Skipping to next scenario [2/8]: NHF_RFND-2ADT_2LEG');
    expect(meta.event_kind).toBe('scenario_skipped');
    expect(meta.scenario_name).toBe('NHF_RFND-2ADT_2LEG');
    expect(meta.attempt_index).toBe(2);
  });

  test('end line', () => {
    const meta = new LogParser().parse('scenario [3/8] completed: OTST_EXCH_SRCH_CRIT_1ADT_1LEG');
    expect(meta.event_kind).toBe('scenario_end');
    expect(meta.scenario_name).toBe('OTST_EXCH_SRCH_CRIT_1ADT_1LEG');
  });

  test('the code stops at the first character that is not a letter, digit, "_" or "-"', () => {
    expect(new LogParser().parse('Starting scenario [1/2]: OTST_A.B').scenario_name).toBe('OTST_A');
    expect(new LogParser().parse('Starting scenario [1/2]: OTST_É').scenario_name).toBe('OTST_');
  });

  test('a retry marker stamps the attempt onto the line and the ones after it', () => {
    const parser = new LogParser();
    parser.parse('▶  Starting scenario [1/8]: OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG');
    const retry = parser.parse('⚠  No offers (attempt 2/3) — retrying...');
    expect(retry).toMatchObject({ event_kind: 'scenario_retry', attempt_index: 2, attempt_total: 3 });
    const next = parser.parse('some later line');
    expect(next).toMatchObject({ event_kind: 'log', attempt_index: 2, attempt_total: 3 });
  });
});

describe('LogParser — other line kinds', () => {
  test('an HTTP request line carries its status', () => {
    const meta = new LogParser().parse('GET https://api.example.test/osdm/offers - 404');
    expect(meta.category).toBe('http');
    expect(meta.http_status).toBe(404);
  });

  test('an empty line yields no metadata', () => {
    expect(new LogParser().parse('   ')).toEqual({});
  });
});

describe('inferLevel', () => {
  test.each([
    ['[ERROR] booking failed', 'info', 'error'],
    ['[WARNING] known deviation', 'info', 'warn'],
    ['[INFO] offer selected', 'error', 'info'],
    ['[DEBUG] request body built', 'error', 'debug'],
    ['   ✕ status is 200', 'info', 'error'],
    ['   ✓ status is 200', 'error', 'info'],
    ['AssertionError: expected 404 to equal 200', 'info', 'error'],
  ])('%s → %s stream → %s', (line, fallback, expected) => {
    expect(inferLevel(line, fallback)).toBe(expected);
  });

  test.each([
    ['    at Object.<anonymous> (/app/library-bruno/testCapture.js:42:11)'],
    ['    at Test.fn (C:\\bruno\\lib (x86)\\run.js:7:3)'],
    ['    at wrap(inner) (node:vm:117:9)'],
    ['at fn(file.js:1:2)'],
    ['    at /app/node_modules/@usebruno/cli/src/runner.js:310:15'],
    ['    at Array.forEach (<anonymous>)'],
  ])('stack frame is demoted to debug: %s', (line) => {
    expect(inferLevel(line, 'error')).toBe('debug');
  });

  test.each([
    ['at the station (see the map)'],
    ['    at fn (file.js:12)'],
    ['    at fn (file.js:12:5) and more'],
    ['arrived at fn (file.js:12:5)'],
  ])('is not a stack frame, so the stream decides: %s', (line) => {
    expect(inferLevel(line, 'info')).toBe('info');
    expect(inferLevel(line, 'error')).toBe('error');
  });

  test('a long run of "(" is rejected in linear time', () => {
    const line = '    at ' + '('.repeat(50000);
    let level;
    expect(elapsedMs(() => { level = inferLevel(line, 'info'); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(level).toBe('info');
  });
});
