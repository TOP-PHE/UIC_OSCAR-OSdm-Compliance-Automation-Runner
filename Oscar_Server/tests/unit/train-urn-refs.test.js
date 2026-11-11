// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #1116: Test Data's Train Details take any URN as stop place and operator.
 * OSDM's StopPlaceRef and CompanyRef are plain strings; a provider may use a
 * scheme of its own (urn:x_cze:cisjr:<id>, urn:x_bileto:code:<id>), and
 * OSDM's own CompanyRef example has a second number (urn:uic:rics:1185:000011).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCENARIOS = path.resolve(__dirname, '..', '..', 'public', 'js', 'scenarios.js');
const source = fs.readFileSync(SCENARIOS, 'utf8').replaceAll('\r\n', '\n');

// A top-level function of scenarios.js, from its `function name(` line to the
// next `}` at column 0 (how the file is written).
function loadFunction(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (start < 0 || end < 0) throw new Error(`${name} not found`);
  const context = vm.createContext({});
  vm.runInContext(lines.slice(start, end + 1).join('\n'), context);
  return context[name];
}

const isUrnRef = loadFunction('isUrnRef');

describe('a stop place or operator reference of Test Data', () => {
  test.each([
    'urn:uic:stn:8400058',
    'urn:uic:stn:0850000',
    'urn:x_bileto:stn:4f6a2c1e-9b7d-4c2a-8e1f-0a1b2c3d4e5f',
    'urn:x_cze:cisjr:1234567',
    'urn:uic:rics:1184',
    'urn:uic:rics:1185:000011',
    'urn:x_bileto:code:ABCD',
    'URN:UIC:STN:8400058',
  ])('%s is a URN', (v) => {
    expect(isUrnRef(v)).toBe(true);
  });

  test.each([
    '8400058', 'urn:', 'urn:uic', 'urn:uic:', 'urn::stn:1', 'uic:stn:8400058',
    'urn:uic:stn:84 00058', ' urn:uic:stn:8400058', 'urn:_x:stn:1', 'urn:x.y:stn:1',
  ])('%j is not', (v) => {
    expect(isUrnRef(v)).toBe(false);
  });

  test('the check takes linear time', () => {
    const t = process.hrtime.bigint();
    expect(isUrnRef('urn:' + 'a'.repeat(60000) + ' ')).toBe(false);
    expect(isUrnRef('urn:a:' + 'b'.repeat(60000) + ' ')).toBe(false);
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(500);
  });

  test('Train Details checks the stop places and the operator with it', () => {
    const start = source.indexOf('function wizValidateTrain(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    for (const field of ['originURN', 'destinationURN', 'operatorCode']) {
      const line = body.split('\n').find((l) => l.includes(`tfield: '${field}',`));
      expect([field, line.includes('test: v => !v || isUrnRef(v),')]).toEqual([field, true]);
    }
    expect(body).not.toMatch(/:stn:\[|rics:\\d/);
  });
});
