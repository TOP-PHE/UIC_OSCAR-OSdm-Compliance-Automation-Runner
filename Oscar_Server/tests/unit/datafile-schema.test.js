// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafile-schema.test.js — the upload's schema check (#549) refuses exactly
 * what a run refuses.
 *
 * utils/datafileSchema.js re-states the rules of the collection's run-time
 * check (validateDataFileJsonWithTemplate, library-bruno/validators.js). This
 * file runs both over the same files: the bundled sample data files, and a
 * few thousand variants of them with one field removed, nulled, re-typed or
 * given a value outside its enum. They must agree on whether the file passes,
 * and on how many problems it has. A change to either check shows here.
 */

const fs = require('node:fs');
const path = require('node:path');

let env = {};
let vars = {};
global.bru = {
  getEnvVar: k => env[k],
  setEnvVar: (k, v) => { env[k] = v; },
  getVar: k => vars[k],
  setVar: (k, v) => { vars[k] = v; },
  sendRequest: undefined,
};

const COLLECTION = path.resolve(__dirname, '../../../Bruno_Collection');
const { validateDataFileJsonWithTemplate } = require(path.join(COLLECTION, 'library-bruno/validators.js'));
const { schemaProblems, loadDatafileSchema, MAX_PROBLEMS } = require('../../src/utils/datafileSchema');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(COLLECTION, 'json_validator/datafile.schema.json'), 'utf8'));
// The simulator's data file is one of them (simulator_datafile.json, #593).
const SAMPLES = fs.readdirSync(path.join(COLLECTION, 'data_base'))
  .filter(f => f.endsWith('datafile.json'))
  .map(f => path.join(COLLECTION, 'data_base', f));

// What the collection's check says about `datafile`: passed, and the number of
// problem lines it printed. Its `test` and `expect` are Bruno's, so Jest's are set aside for
// the length of the (synchronous) call.
function collectionVerdict(datafile, schema = SCHEMA) {
  env = { json_schema: 'http://127.0.0.1/json_validator/datafile.schema.json', loggingType: 'ERROR' };
  vars = {};
  const outcomes = [];
  const errors = [];
  const jestTest = global.test;
  const jestExpect = global.expect;
  const consoleError = console.error;
  global.bru.sendRequest = (_opts, cb) => cb(null, { status: 200, data: schema });
  global.test = (name, fn) => { try { fn(); outcomes.push(true); } catch { outcomes.push(false); } };
  global.expect = () => ({ to: { eql: () => {} } });
  console.error = line => { if (String(line).startsWith('[ERROR] ❌')) errors.push(line); };
  try {
    validateDataFileJsonWithTemplate(datafile);
  } finally {
    global.test = jestTest;
    global.expect = jestExpect;
    console.error = consoleError;
  }
  return { passed: outcomes.length === 1 && outcomes[0], count: errors.length };
}

// A small deterministic generator, so a failure can be replayed.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// Every place in the file: [parent, key] pairs.
function places(value, out = []) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push([value, key]);
      places(value[key], out);
    }
  }
  return out;
}

const VARIANTS = [
  // Removed from a list with splice: `delete` would leave a hole, which no
  // parsed JSON has (and which forEach, in the collection, skips).
  (p, k) => { if (Array.isArray(p)) p.splice(Number(k), 1); else delete p[k]; },
  (p, k) => { p[k] = null; },
  (p, k) => { p[k] = 42; },
  (p, k) => { p[k] = 1.5; },
  (p, k) => { p[k] = 'NOT_AN_ENUM_VALUE'; },
  (p, k) => { p[k] = true; },
  (p, k) => { p[k] = []; },
  (p, k) => { p[k] = {}; },
  (p, k) => { p[k] = ['x']; },
  (p, k) => { p[k] = ''; },
];

describe('the upload check and the run check agree', () => {
  test('there are sample data files to start from, and they pass both', () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const file of SAMPLES) {
      const df = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(collectionVerdict(df)).toEqual({ passed: true, count: 0 });
      expect(schemaProblems(df, SCHEMA)).toEqual({ problems: [], more: false });
    }
  });

  test('on thousands of broken variants, the same verdict and the same number of problems', () => {
    const rnd = prng(549);
    let refused = 0;
    for (let i = 0; i < 3000; i++) {
      const df = JSON.parse(fs.readFileSync(SAMPLES[i % SAMPLES.length], 'utf8'));
      const edits = 1 + Math.floor(rnd() * 3);
      for (let e = 0; e < edits; e++) {
        const all = places(df);
        const [parent, key] = all[Math.floor(rnd() * all.length)];
        VARIANTS[Math.floor(rnd() * VARIANTS.length)](parent, key);
      }
      const theirs = collectionVerdict(df);
      const ours = schemaProblems(df, SCHEMA);
      const label = `variant ${i}: ${JSON.stringify(ours.problems.slice(0, 3))}`;
      expect([label, ours.problems.length === 0]).toEqual([label, theirs.passed]);
      if (!ours.more) expect([label, ours.problems.length]).toEqual([label, theirs.count]);
      if (!theirs.passed) refused++;
    }
    // The variants must exercise the refusals, not only harmless edits.
    expect(refused).toBeGreaterThan(1000);
  });
});

describe('the rules the current schema does not reach, checked on schemas of their own', () => {
  const cases = [
    // null listed in an enum is allowed, whatever the type says
    [{ properties: { a: { type: 'string', enum: ['x', null] } } }, { a: null }],
    [{ properties: { a: { type: 'string', enum: ['x'] } } }, { a: null }],
    // properties and items are only looked at when the type is that one word
    [{ properties: { a: { type: ['object', 'null'], properties: { b: { type: 'integer' } }, required: ['c'] } } }, { a: { b: 's' } }],
    [{ properties: { a: { type: 'object', properties: { b: { type: 'integer' } }, required: ['c'] } } }, { a: { b: 's' } }],
    [{ properties: { a: { type: ['array', 'string'], items: { type: 'integer' } } } }, { a: ['s'] }],
    [{ properties: { a: { type: 'string', minLength: 2, maxLength: 3 } } }, { a: 'x' }],
    [{ properties: { a: { type: 'string', minLength: 2, maxLength: 3 } } }, { a: 'xxxx' }],
  ];
  test.each(cases.map((c, i) => [i, ...c]))('case %i: the same verdict and count', (_i, schema, datafile) => {
    const theirs = collectionVerdict(datafile, schema);
    const ours = schemaProblems(datafile, schema);
    expect([ours.problems.length === 0, ours.problems.length]).toEqual([theirs.passed, theirs.count]);
  });
});

describe('schemaProblems', () => {
  test('a file that is not a JSON object is refused for that alone', () => {
    expect(schemaProblems([], SCHEMA).problems).toEqual(['The file holds a JSON array, not a data file (a JSON object).']);
    expect(schemaProblems('x', SCHEMA).problems).toEqual(['The file holds a JSON string, not a data file (a JSON object).']);
    expect(schemaProblems(null, SCHEMA).problems).toEqual(['The file holds a JSON null, not a data file (a JSON object).']);
  });

  test('stops at the limit, however much is wrong', () => {
    const df = JSON.parse(fs.readFileSync(SAMPLES[0], 'utf8'));
    df.scenarios = Array.from({ length: 100000 }, () => ({}));
    const started = Date.now();
    const { problems, more } = schemaProblems(df, SCHEMA);
    expect(problems).toHaveLength(MAX_PROBLEMS);
    expect(more).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a long value is shortened in the message', () => {
    const df = JSON.parse(fs.readFileSync(SAMPLES[0], 'utf8'));
    df.scenarios[0].loggingType = 'L'.repeat(500);
    const [problem] = schemaProblems(df, SCHEMA).problems;
    expect(problem.length).toBeLessThan(200);
    expect(problem).toContain('…');
  });

  test('reads the schema of the collection the runs use, falling back to the repository copy', () => {
    const saved = process.env.COLLECTION_PATH;
    try {
      process.env.COLLECTION_PATH = COLLECTION;
      expect(loadDatafileSchema()).toEqual(SCHEMA);
      process.env.COLLECTION_PATH = path.join(COLLECTION, 'no-such-folder');
      expect(loadDatafileSchema()).toEqual(SCHEMA);
    } finally {
      process.env.COLLECTION_PATH = saved;
    }
  });
});
