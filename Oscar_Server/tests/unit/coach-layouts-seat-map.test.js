// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #1117: the coach layouts (01. GET Coach, 02. GET Coach By Id) are read only
 * for a provider whose Test Framework declares a seat map. The server's run
 * copy marks each scenario `__seatMapDeclared: false`, the parser turns the
 * mark into `__coachLayoutsSkip`, and the collection's run filter skips the
 * two reads on it. A standalone run (no mark) reads them as before.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('../../src/utils/undeclaredSteps');

global.bru = { getEnvVar: () => undefined, setEnvVar: () => {}, getVar: () => undefined, setVar: () => {} };
const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');

const COLLECTION = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
const read = (rel) => fs.readFileSync(path.join(COLLECTION, rel), 'utf8').replaceAll('\r\n', '\n');

describe('the run copy of a provider declaring no seat map', () => {
  const datafile = () => ({ scenarios: [{ code: 'A' }, null, { code: 'B', placeSelectionMode: 'SEATMAP_AT_OFFER' }] });

  test('a seat map is declared only by placeSelection.seatMap true', () => {
    expect(U.seatMapDeclared({ placeSelection: { seatMap: true } })).toBe(true);
    expect(U.seatMapDeclared({ placeSelection: { seatMap: false } })).toBe(false);
    expect(U.seatMapDeclared({ placeSelection: { seatMap: 'true' } })).toBe(false);
    expect(U.seatMapDeclared({ placeSelection: {} })).toBe(false);
    expect(U.seatMapDeclared({})).toBe(false);
    expect(U.seatMapDeclared(null)).toBe(false);
  });

  test('every scenario is marked when none is declared, once', () => {
    const df = datafile();
    expect(U.withoutUndeclaredCoachLayouts(df, { placeSelection: { seatMap: false } })).toBe(2);
    expect(df.scenarios).toEqual([
      { code: 'A', __seatMapDeclared: false }, null,
      { code: 'B', placeSelectionMode: 'SEATMAP_AT_OFFER', __seatMapDeclared: false },
    ]);
    expect(U.withoutUndeclaredCoachLayouts(df, {})).toBe(0);
  });

  test('nothing changes when a seat map is declared, or there are no scenarios', () => {
    const df = datafile();
    expect(U.withoutUndeclaredCoachLayouts(df, { placeSelection: { seatMap: true } })).toBe(0);
    expect(df).toEqual(datafile());
    expect(U.withoutUndeclaredCoachLayouts({}, {})).toBe(0);
    expect(U.withoutUndeclaredCoachLayouts(null, {})).toBe(0);
  });

  test('the parser reads the server\'s mark, and nothing else', () => {
    const df = { scenarios: [{ code: 'A' }] };
    U.withoutUndeclaredCoachLayouts(df, {});
    expect(sp.coachLayoutsSkipped(df.scenarios[0])).toBe(true);
    expect(sp.coachLayoutsSkipped({ code: 'A' })).toBe(false);
    expect(sp.coachLayoutsSkipped({ __seatMapDeclared: true })).toBe(false);
    expect(sp.coachLayoutsSkipped({ __seatMapDeclared: 'false' })).toBe(false);
    expect(sp.coachLayoutsSkipped(null)).toBe(false);
  });

  test('every simulator reference declares a seat map, so their runs keep the coach checks', () => {
    const dir = path.join(COLLECTION, 'data_base', 'reference');
    const files = fs.readdirSync(dir).filter((f) => /^simulator-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { framework } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect([file, U.seatMapDeclared(framework)]).toEqual([file, true]);
    }
  });
});

describe('the collection', () => {
  test('the parser sets the flag at each parse, and both reset lists clear it', () => {
    const parser = read('library-bruno/scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("__coachLayoutsSkip", coachLayoutsSkipped(scenario) ? "true" : "false");');
    const resetList = parser.slice(parser.indexOf('function resetScenarioEnvVars()'), parser.indexOf("resetScenarioEnvVars: all business env vars cleared"));
    expect(resetList).toContain('"__coachLayoutsSkip"');
    const yml = read('opencollection.yml');
    const deleteList = yml.slice(yml.indexOf('const _deleteList'), yml.indexOf('_deleteList.forEach'));
    expect(deleteList).toContain('"__coachLayoutsSkip"');
  });

  test('the only requests the rule matches are the two coach layout reads', () => {
    const names = [];
    for (const folder of fs.readdirSync(COLLECTION, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^\d\d-/.test(folder.name)) continue;
      for (const file of fs.readdirSync(path.join(COLLECTION, folder.name))) {
        if (file.endsWith('.yml') && file !== 'folder.yml') names.push(file.replace(/\.yml$/, ''));
      }
    }
    expect(names.filter((n) => n.toLowerCase().includes('get coach')).sort())
      .toEqual(['01. GET Coach', '02. GET Coach By Id']);
  });

  // The run filter itself, run as Bruno runs it: the collection's
  // before-request, from "1. Smart run filter" to "2. Normal before-request".
  const yml = read('opencollection.yml');
  const filter = yml.slice(yml.indexOf('// ── 1. Smart run filter'), yml.indexOf('// ── 2. Normal before-request'));
  const script = new vm.Script(`RUNSCRIPT: {\n${filter}\n}`);

  function runFilter(name, env) {
    const skipRequest = jest.fn();
    const logs = [];
    const context = vm.createContext({
      req: { getName: () => name, getUrl: () => '{{api_base}}/{{coachLayoutsResource}}' },
      bru: {
        getEnvVar: (k) => env[k],
        getEnvName: () => 'acme_1a2b3c4d',
        runner: { skipRequest },
      },
      console: { log: (m) => logs.push(m) },
    });
    script.runInContext(context);
    return { skipped: skipRequest.mock.calls.length === 1, logs };
  }

  test.each(['01. GET Coach', '02. GET Coach By Id'])('%s is skipped where no seat map is declared, and says why', (name) => {
    const { skipped, logs } = runFilter(name, { __coachLayoutsSkip: 'true' });
    expect(skipped).toBe(true);
    expect(logs).toEqual([expect.stringContaining('the Test Framework declares no seat map')]);
  });

  test.each([
    ['01. GET Coach', { __coachLayoutsSkip: 'false' }],
    ['01. GET Coach', {}],
    ['02. GET Coach By Id', { __coachLayoutsSkip: 'false' }],
    ['04. GET Passenger Categories', { __coachLayoutsSkip: 'true' }],
    ['08. GET Products', { __coachLayoutsSkip: 'true' }],
  ])('%s runs (%j)', (name, env) => {
    expect(runFilter(name, env)).toEqual({ skipped: false, logs: [] });
  });
});
