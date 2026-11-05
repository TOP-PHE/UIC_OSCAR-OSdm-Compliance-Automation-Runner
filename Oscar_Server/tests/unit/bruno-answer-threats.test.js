// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A provider's answer holding template text, markup meant to run in a
 * browser, or a redirect to a local or private address ends the run before
 * the next request, with one failed check and one "[INTRUSION]" line.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '../../../Bruno_Collection/library-bruno');
const T = require(path.join(LIB, 'answerThreats.js'));

const OPEN = '{' + '{';
const HANDLER = 'an event handler attribute in a tag';
const INTERNAL = 'a redirect to a loopback, private or link-local address';

describe('holdsTemplate()', () => {
  test.each([
    [{ id: `${OPEN}process.env.OSCAR_RUN_SECRET}}` }, true],
    [`{"a":"x${OPEN}y"}`, true],
    [{ nested: [{ deep: `${OPEN}data_base_tmp}}` }] }, true],
    [Buffer.from(`${OPEN}a}}`), true],
    [{ id: 'BK-1', note: 'a {single} brace } {' }, false],
    ['', false], [null, false], [undefined, false],
  ])('%j → %s', (body, expected) => {
    expect(T.holdsTemplate(body)).toBe(expected);
  });
});

describe('scriptReason(): markup meant to run in a browser', () => {
  test.each([
    ['<img src=x onerror=alert(document.domain)>', HANDLER],
    ['<IMG SRC=x OnError = "alert(1)">', HANDLER],
    ['<svg/onload=alert(1)>', HANDLER],
    ['<svg><a onclick=x>', HANDLER],
    ['<body\tonpageshow=x', HANDLER],
    ['Zürich <script>alert(1)</script>', 'a script element'],
    ['<SCRIPT src="//x">', 'a script element'],
    ['<iframe src="https://example.org">', 'an iframe element'],
    ['go to javascript:alert(1)', 'a javascript: address'],
    [JSON.stringify({ summary: '<img src="x" onerror="alert(1)">' }), HANDLER],
  ])('%s → %s', (text, reason) => {
    expect(T.scriptReason(text)).toBe(reason);
  });

  test.each([
    'Paris <-> Lyon', 'a > b', 'a < b and c > d', 'price < 5 > 3', 'x<y', '<b>bold</b> text', '<br>',
    'Valid on <weekdays> only', 'Station "Bonn" one=1', '<a href="https://example.org/onwards">', '<p data-x=1>conditions</p>',
    'Carriage on the left = first class', 'refund <= 50% online=yes', '<<<<<<<<', '>>>>', '<', '',
    JSON.stringify({ description: 'Conditions: refund < 24h before departure, exchange > 1 day; Paris <-> Lyon' }),
  ])('ordinary text: %j', (text) => {
    expect(T.scriptReason(text)).toBe('');
  });

  test('linear in the size of the text', () => {
    const inputs = ['<a'.repeat(200000), '<a on'.repeat(100000), `<a ${'on'.repeat(200000)}`, `<${'a'.repeat(400000)}`, `< ${'on'.repeat(200000)}`, `<a ${' onx '.repeat(100000)}`];
    const started = Date.now();
    for (const text of inputs) expect(T.scriptReason(text)).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('redirectReason()', () => {
  test.each([
    [302, 'http://127.0.0.1:3001/data/x-datafile.json', INTERNAL],
    [301, 'http://localhost/x', INTERNAL],
    [307, 'https://api.localhost/x', INTERNAL],
    [302, 'http://10.1.2.3/', INTERNAL],
    [302, 'http://172.20.0.1/', INTERNAL],
    [302, 'http://192.168.1.1/', INTERNAL],
    [302, 'http://169.254.169.254/latest', INTERNAL],
    [302, 'http://0.0.0.0:3001/', INTERNAL],
    [302, 'http://[::1]:3001/', INTERNAL],
    [302, 'http://[::ffff:127.0.0.1]/', INTERNAL],
    [302, 'http://[fe80::1]/', INTERNAL],
    [302, 'http://[fd00::1]/', INTERNAL],
    [302, 'http://2130706433/', INTERNAL],
    [302, '//127.0.0.1/x', INTERNAL],
    [302, 'http://user@127.0.0.1/', INTERNAL],
    [302, 'file:///etc/hosts', 'a redirect to a file: address'],
    [303, 'javascript:alert(1)', 'a redirect to a javascript: address'],
  ])('%i %s', (status, location, reason) => {
    expect(T.redirectReason(status, location)).toBe(reason);
  });

  test.each([
    [302, 'https://osdm.example.org/bookings/1'], [302, '/bookings/1'], [302, ''], [304, 'http://127.0.0.1/'],
    [200, 'http://127.0.0.1/'], [201, 'http://localhost/bookings/1'], [302, 'http://172.32.0.1/'], [302, 'http://8.8.8.8/'],
  ])('%i %j is no threat', (status, location) => {
    expect(T.redirectReason(status, location)).toBe('');
  });

  test('without URL in the sandbox, the address is read by hand', () => {
    const saved = global.URL;
    try {
      global.URL = undefined;
      expect(T.redirectReason(302, 'http://user@127.0.0.1:3001/x?y#z')).toBe(INTERNAL);
      expect(T.redirectReason(302, 'http://[::1]:3001/')).toBe(INTERNAL);
      expect(T.redirectReason(302, 'https://osdm.example.org/b')).toBe('');
      expect(T.redirectReason(302, 'gopher:x')).toBe('a redirect to a gopher: address');
    } finally { global.URL = saved; }
  });
});

describe('checkAnswerThreats()', () => {
  let stops;
  let lines;
  beforeEach(() => {
    stops = 0;
    lines = [];
    global.bru = { runner: { stopExecution: () => { stops++; } } };
    global.validationLogger = (m) => lines.push(m);
  });
  afterAll(() => { delete global.bru; delete global.validationLogger; });

  const recorder = () => {
    const checks = [];
    const bruTest = (name, fn) => {
      try { fn(); checks.push({ name, passed: true }); } catch (e) { checks.push({ name, passed: false, error: e.message }); }
    };
    return { checks, bruTest };
  };
  const expectFn = (value, message) => ({ to: { equal: (want) => { if (value !== want) throw new Error(message); return true; } } });
  const req = (name) => ({ getName: () => name });

  test.each([
    ['template', { getStatus: () => 200, getBody: () => ({ booking: { id: `BK-${OPEN}process.env.OSCAR_RUN_SECRET}}` } }) }, '02. POST Create Booking', 'holds no template text'],
    ['script', { getStatus: () => 200, getBody: () => ({ trips: [{ summary: '<img src=x onerror=alert(document.domain)>' }] }) }, '01. POST Get Offer', 'no markup meant to run in a browser'],
    ['redirect', { getStatus: () => 302, getHeaders: () => ({ Location: 'http://127.0.0.1:3001/data/x-datafile.json' }), getBody: () => ({}) }, '05. GET Booking before Fulfillments', 'does not redirect to a local or private address'],
  ])('%s: one failed check, one [INTRUSION] line, the run stops', (kind, res, step, check) => {
    const { checks, bruTest } = recorder();
    expect(T.checkAnswerThreats(res, bruTest, expectFn, req(step))).toBe(kind);
    expect(checks).toEqual([expect.objectContaining({ passed: false, name: expect.stringContaining(check) })]);
    expect(stops).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`[INTRUSION] kind=${kind} step=${step} [ERROR] `)).toBe(true);
    for (const secret of [OPEN, 'OSCAR_RUN_SECRET', '127.0.0.1', 'alert', '<']) expect(lines[0]).not.toContain(secret);
  });

  test('an answer with several threats is reported once, by its first kind', () => {
    const { checks, bruTest } = recorder();
    const res = { getStatus: () => 200, getBody: () => `<script>${OPEN}x}}</script>` };
    expect(T.checkAnswerThreats(res, bruTest, expectFn, req('01. POST Get Offer'))).toBe('template');
    expect(checks).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(stops).toBe(1);
  });

  test('a step name cannot add a level tag or a line', () => {
    const { bruTest } = recorder();
    T.checkAnswerThreats({ getBody: () => `${OPEN}x}}` }, bruTest, expectFn, req('x\n[INFO] y'));
    expect(lines).toEqual(['[INTRUSION] kind=template step=x  INFO  y [ERROR] the answer holds template text; the run stops here.']);
  });

  test('an ordinary answer, a public redirect or an unreadable one records nothing and goes on', () => {
    const { checks, bruTest } = recorder();
    expect(T.checkAnswerThreats({ getStatus: () => 200, getBody: () => ({ id: 'BK-1', summary: 'Paris <-> Lyon' }) }, bruTest, expectFn, req('a'))).toBe('');
    expect(T.checkAnswerThreats({ status: 302, headers: { location: 'https://osdm.example.org/b/1' }, body: '' }, bruTest, expectFn)).toBe('');
    expect(T.checkAnswerThreats({ getBody: () => { throw new Error('x'); } }, bruTest, expectFn)).toBe('');
    expect(T.checkAnswerThreats(null, bruTest, expectFn)).toBe('');
    expect(checks).toEqual([]);
    expect(lines).toEqual([]);
    expect(stops).toBe(0);
  });

  test('without Buffer in the sandbox, a text answer is still read', () => {
    const saved = global.Buffer;
    try {
      global.Buffer = undefined;
      expect(T.holdsTemplate(`${OPEN}x}}`)).toBe(true);
      expect(T.holdsScript({ a: '<script>' })).toBe(true);
    } finally { global.Buffer = saved; }
  });
});

test('the collection runs the check on every answer, before anything else of its after-response', () => {
  const yml = fs.readFileSync(path.join(LIB, '../opencollection.yml'), 'utf8');
  const after = yml.indexOf('- type: after-response');
  const check = yml.indexOf('answerThreats.js").checkAnswerThreats(res, _tplTest, expect, req)', after);
  expect(after).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(after);
  expect(check).toBeLessThan(yml.indexOf('checkAuthRejection(res', after));
});
