// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafile-version.test.js — the version a Test Config save is checked against
 * (#540, utils/datafileVersion.js): what changes it for whom, and the
 * If-Match / If-None-Match rule.
 */

const { datafileVersion, etag, parseTags, staleSaveRefusal } = require('../../src/utils/datafileVersion');

const ANA = { role: 'company_user', email: 'ana@v.test', selection: ['ANA_1'] };
const TM  = { role: 'test_manager' };

function file() {
  return {
    scenariosToRun: ['SHARED_1', 'ANA_1', 'BEN_1'],
    scenarios: [
      { code: 'SHARED_1', shared: true, created_by: 'tm@v.test', tripRequirementId: 1 },
      { code: 'ANA_1', created_by: 'ana@v.test', tripRequirementId: 2 },
      { code: 'BEN_1', created_by: 'ben@v.test', tripRequirementId: 3 },
    ],
    tripRequirements: [{ id: 1, t: 's' }, { id: 2, t: 'a' }, { id: 3, t: 'b' }],
    knownDeviations: [{ step: 'x', expected_status: 501 }],
  };
}
const v = (df, viewer) => datafileVersion(Buffer.from(JSON.stringify(df, null, 4)), viewer);

describe('datafileVersion', () => {
  test('is the same for the same file however it is laid out', () => {
    expect(v(file(), TM)).toBe(datafileVersion(JSON.stringify(file()), TM));
    expect(v(file(), TM)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a Test Manager\'s changes with any scenario', () => {
    const df = file(); df.scenarios[2].note = 'edited';
    expect(v(df, TM)).not.toBe(v(file(), TM));
  });

  test('a tester\'s does not change when a colleague\'s private scenario or its entry does', () => {
    const df = file();
    df.scenarios[2].note = 'edited';
    df.tripRequirements[2].t = 'b2';
    df.scenarios.push({ code: 'BEN_2', created_by: 'ben@v.test', tripRequirementId: 3 });
    expect(v(df, ANA)).toBe(v(file(), ANA));
  });

  test('a tester\'s changes with what they can see: a shared scenario, their own, their run list', () => {
    const shared = file(); shared.scenarios[0].note = 'edited';
    const own = file(); own.tripRequirements[1].t = 'a2';
    expect(v(shared, ANA)).not.toBe(v(file(), ANA));
    expect(v(own, ANA)).not.toBe(v(file(), ANA));
    expect(v(file(), { ...ANA, selection: [] })).not.toBe(v(file(), ANA));
  });

  test('a scenario un-shared by the Test Manager changes the tester\'s version', () => {
    const df = file(); df.scenarios[0].shared = false;
    expect(v(df, ANA)).not.toBe(v(file(), ANA));
  });

  test('knownDeviations changes no one\'s version', () => {
    const df = file(); df.knownDeviations = [{ step: 'y', expected_status: 404 }];
    expect(v(df, TM)).toBe(v(file(), TM));
    expect(v(df, ANA)).toBe(v(file(), ANA));
  });

  test('a file that is not a JSON object is versioned by its bytes', () => {
    expect(datafileVersion(Buffer.from('not json'), TM)).not.toBe(datafileVersion(Buffer.from('not json!'), TM));
    expect(datafileVersion(Buffer.from('[1,2]'), ANA)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseTags', () => {
  test('reads *, a list, weak tags, and nothing', () => {
    expect(parseTags('*')).toBe('*');
    expect(parseTags('"a", W/"b" ,"c"')).toEqual(['a', 'b', 'c']);
    expect(parseTags(etag('abc'))).toEqual(['abc']);
    expect(parseTags('')).toBeNull();
    expect(parseTags(undefined)).toBeNull();
  });
});

describe('staleSaveRefusal', () => {
  const cur = 'abc';
  test('no header: the save goes ahead (a page loaded before this release)', () => {
    expect(staleSaveRefusal({}, cur)).toBeNull();
    expect(staleSaveRefusal({}, null)).toBeNull();
  });

  test('If-Match: goes ahead on the current version only', () => {
    expect(staleSaveRefusal({ ifMatch: '"abc"' }, cur)).toBeNull();
    expect(staleSaveRefusal({ ifMatch: 'W/"abc"' }, cur)).toBeNull();
    expect(staleSaveRefusal({ ifMatch: '"old", "abc"' }, cur)).toBeNull();
    expect(staleSaveRefusal({ ifMatch: '*' }, cur)).toBeNull();
    expect(staleSaveRefusal({ ifMatch: '"old"' }, cur)).toMatch(/changed since this page loaded it/);
    expect(staleSaveRefusal({ ifMatch: '"abc"' }, 'unreadable')).toMatch(/changed/);
  });

  test('If-Match when the file has been deleted since', () => {
    expect(staleSaveRefusal({ ifMatch: '"abc"' }, null)).toMatch(/deleted/);
    expect(staleSaveRefusal({ ifMatch: '*' }, null)).toMatch(/deleted/);
  });

  test('If-None-Match: * goes ahead only while there is no file', () => {
    expect(staleSaveRefusal({ ifNoneMatch: '*' }, null)).toBeNull();
    expect(staleSaveRefusal({ ifNoneMatch: '*' }, cur)).toMatch(/saved since this page found none/);
  });
});
