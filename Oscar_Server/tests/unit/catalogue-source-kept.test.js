// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1236: the scenario catalogue and the simulator's data file were read and
// parsed at every call, the 1.7 MB data file with readFileSync on the
// server's thread, by every preview of the Run page and every launch, which
// need the catalogue's entries only. They are now kept while their file is
// the same, and the facets read the catalogue alone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CS = require('../../src/api/helpers/catalogueSource');

const REPO_CATALOGUE = path.resolve(__dirname, '../../../Bruno_Collection/data_base/scenario_catalogue.json');

let root;
const savedPath = process.env.COLLECTION_PATH;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-catalogue-kept-'));
  fs.mkdirSync(path.join(root, 'data_base'));
  process.env.COLLECTION_PATH = root;
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedPath === undefined) delete process.env.COLLECTION_PATH;
  else process.env.COLLECTION_PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true });
});

const fileOf = (name) => path.join(root, 'data_base', name);
function writeJson(name, value) {
  fs.writeFileSync(fileOf(name), JSON.stringify(value));
}
function writeBoth(entries = [{ code: 'OTST_A', source: 'SIM_A' }]) {
  writeJson('scenario_catalogue.json', { entries });
  writeJson('simulator_datafile.json', { scenarios: [{ code: 'SIM_A' }] });
}
// The files of `root` read with readFileSync while `fn` runs, by name or
// by the descriptor openSync gave for them (named when read: a closed
// descriptor's number is given again).
function filesReadBy(fn) {
  const opened = new Map();
  const read = [];
  const { openSync, readFileSync } = fs;
  const open = jest.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
    const fd = openSync(file, ...rest);
    opened.set(fd, String(file));
    return fd;
  });
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
    read.push(typeof file === 'number' ? opened.get(file) : String(file));
    return readFileSync(file, ...rest);
  });
  fn();
  spy.mockRestore();
  open.mockRestore();
  return read.filter((file) => file?.startsWith(root)).map((file) => path.basename(file));
}

describe('the catalogue kept while its file is the same (#1236)', () => {
  test('a second read reads no file and gives the same values', () => {
    writeBoth();
    let first;
    expect(filesReadBy(() => { first = CS.readCatalogue(); })).toEqual(['scenario_catalogue.json', 'simulator_datafile.json']);
    let second;
    expect(filesReadBy(() => { second = CS.readCatalogue(); })).toEqual([]);
    expect(second.catalogue).toBe(first.catalogue);
    expect(second.simulator).toBe(first.simulator);
    expect(first.catalogue.entries[0].code).toBe('OTST_A');
  });

  test('a changed file is read again, the other one is not', () => {
    writeBoth();
    CS.readCatalogue();
    writeJson('scenario_catalogue.json', { entries: [{ code: 'OTST_B', source: 'SIM_A' }, { code: 'OTST_C', source: 'SIM_A' }] });
    let after;
    expect(filesReadBy(() => { after = CS.readCatalogue(); })).toEqual(['scenario_catalogue.json']);
    expect(after.catalogue.entries.map((e) => e.code)).toEqual(['OTST_B', 'OTST_C']);
  });

  test('a file replaced by one of the same size and time is read again (another inode)', () => {
    writeBoth([{ code: 'OTST_A', source: 'SIM_A' }]);
    const before = fs.statSync(fileOf('scenario_catalogue.json'));
    CS.readCatalogue();
    const next = fileOf('scenario_catalogue.json.new');
    fs.writeFileSync(next, JSON.stringify({ entries: [{ code: 'OTST_Z', source: 'SIM_A' }] }));
    fs.utimesSync(next, before.atime, before.mtime);
    fs.renameSync(next, fileOf('scenario_catalogue.json'));
    expect(CS.catalogueEntries().map((e) => e.code)).toEqual(['OTST_Z']);
  });

  test('what is kept is frozen: a caller writing into it throws', () => {
    writeBoth();
    const { catalogue, simulator } = CS.readCatalogue();
    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(() => { catalogue.entries[0].code = 'CHANGED'; }).toThrow(TypeError);
    expect(() => { simulator.scenarios.push({}); }).toThrow(TypeError);
    expect(CS.readCatalogue().catalogue.entries[0].code).toBe('OTST_A');
  });

  test('the facets\' entries read the catalogue alone, never the simulator\'s data file', () => {
    writeBoth();
    let entries;
    expect(filesReadBy(() => { entries = CS.catalogueEntries(); })).toEqual(['scenario_catalogue.json']);
    expect(entries.map((e) => e.code)).toEqual(['OTST_A']);
    writeJson('scenario_catalogue.json', { version: 1 });
    expect(CS.catalogueEntries()).toEqual([]);
  });

  test('runCandidates.facetsFor() reads no simulator data file', () => {
    writeBoth();
    const { facetsFor } = require('../../src/api/helpers/runCandidates');
    const read = filesReadBy(() => facetsFor('no-such-company', { scenarios: [] }, [], { role: 'test_manager' }));
    expect(read.filter((f) => f === 'simulator_datafile.json')).toEqual([]);
  });

  test('the entries are the catalogue file\'s own (the repository copy, as the runs\' collection)', () => {
    process.env.COLLECTION_PATH = path.resolve(__dirname, '../../../Bruno_Collection');
    expect(CS.catalogueEntries()).toEqual(JSON.parse(fs.readFileSync(REPO_CATALOGUE, 'utf8')).entries);
  });

  test('a collection file that cannot be read falls back to the repository copy; none at all is a 503', () => {
    fs.writeFileSync(fileOf('scenario_catalogue.json'), '{ not json');
    expect(CS.catalogueEntries().length).toBeGreaterThan(0);
    const openSync = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith('scenario_catalogue.json')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return openSync(file, ...rest);
    });
    expect(() => CS.catalogueEntries()).toThrow(expect.objectContaining({ status: 503 }));
  });
});
