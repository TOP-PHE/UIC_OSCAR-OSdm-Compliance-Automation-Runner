// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A provider's answer holding "{{" ends the run before the next request:
 * the engine would fill it in with its own variables there.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '../../../Bruno_Collection/library-bruno');
const { holdsTemplate, checkAnswerTemplates } = require(path.join(LIB, 'answerTemplates.js'));

const OPEN = '{' + '{';

describe('holdsTemplate()', () => {
  test.each([
    [{ id: `${OPEN}process.env.OSCAR_RUN_SECRET}}` }, true],
    [`{"a":"x${OPEN}y"}`, true],
    [{ nested: [{ deep: `${OPEN}data_base_tmp}}` }] }, true],
    [Buffer.from(`${OPEN}a}}`), true],
    [{ id: 'BK-1', note: 'a {single} brace } {' }, false],
    ['', false], [null, false], [undefined, false],
  ])('%j → %s', (body, expected) => {
    expect(holdsTemplate(body)).toBe(expected);
  });
});

describe('checkAnswerTemplates()', () => {
  let stops;
  beforeEach(() => {
    stops = 0;
    global.bru = { runner: { stopExecution: () => { stops++; } } };
  });
  afterAll(() => { delete global.bru; });

  const recorder = () => {
    const checks = [];
    const bruTest = (name, fn) => {
      try { fn(); checks.push({ name, passed: true }); } catch (e) { checks.push({ name, passed: false, error: e.message }); }
    };
    return { checks, bruTest };
  };
  const expectFn = (value, message) => ({ to: { be: { get true() { if (value !== true) throw new Error(message); return true; } } } });

  test('an answer holding "{{" fails one check and stops the run', () => {
    const { checks, bruTest } = recorder();
    const res = { getBody: () => ({ id: `${OPEN}process.env.OSCAR_ACCESS_TOKEN}}` }) };
    expect(checkAnswerTemplates(res, bruTest, expectFn)).toBe(true);
    expect(checks).toEqual([expect.objectContaining({ passed: false, name: expect.stringContaining('holds no template text') })]);
    expect(stops).toBe(1);
  });

  test('an ordinary answer records nothing and goes on', () => {
    const { checks, bruTest } = recorder();
    expect(checkAnswerTemplates({ getBody: () => ({ id: 'BK-1' }) }, bruTest, expectFn)).toBe(false);
    expect(checks).toEqual([]);
    expect(stops).toBe(0);
  });

  test('an answer that cannot be read is left alone', () => {
    const { checks, bruTest } = recorder();
    expect(checkAnswerTemplates({ getBody: () => { throw new Error('x'); } }, bruTest, expectFn)).toBe(false);
    expect(checks).toEqual([]);
  });
});

test('the collection runs the check on every answer, before anything else of its after-response', () => {
  const yml = fs.readFileSync(path.join(LIB, '../opencollection.yml'), 'utf8');
  const after = yml.indexOf('- type: after-response');
  const check = yml.indexOf('answerTemplates.js").checkAnswerTemplates(res', after);
  expect(after).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(after);
  expect(check).toBeLessThan(yml.indexOf('checkAuthRejection(res', after));
});
