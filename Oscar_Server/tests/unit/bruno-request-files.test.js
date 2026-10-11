// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-request-files.test.js — #613 F1: every request file of the collection
 * is laid out the way Bruno reads it.
 *
 * `03-Refund/11. GET Refund Offer.yml` had its after-response script indented
 * under `http.headers`. YAML read it as a header with no name; Bruno dropped
 * that header and loaded no script, so the step ran without a single check.
 * Nothing failed, which is why it went unseen. The files are read with js-yaml,
 * the parser Bruno 4.2.1 uses for them.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const COLLECTION = path.resolve(__dirname, '../../../Bruno_Collection');
const REQUEST_FOLDERS = fs.readdirSync(COLLECTION, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d\d-/.test(d.name))
  .map(d => d.name);

function requestFiles() {
  const files = [];
  for (const folder of REQUEST_FOLDERS) {
    for (const name of fs.readdirSync(path.join(COLLECTION, folder))) {
      if (!name.endsWith('.yml') || name === 'folder.yml' || name === 'opencollection.yml') continue;
      files.push(path.join(folder, name));
    }
  }
  return files;
}

const FILES = requestFiles();

function scriptTypes(doc) {
  const scripts = (doc && doc.runtime && Array.isArray(doc.runtime.scripts)) ? doc.runtime.scripts : [];
  return scripts.map(s => s && s.type);
}

describe('Bruno request files (#613 F1)', () => {
  test('the collection has request files to check', () => {
    expect(REQUEST_FOLDERS.length).toBeGreaterThanOrEqual(4);
    expect(FILES.length).toBeGreaterThan(30);
  });

  test.each(FILES)('%s: every header has a name and a value, and nothing else', (file) => {
    const doc = yaml.load(fs.readFileSync(path.join(COLLECTION, file), 'utf8'));
    const headers = (doc.http && doc.http.headers) || [];
    for (const header of headers) {
      expect(Object.keys(header).sort()).toEqual(expect.arrayContaining(['name']));
      expect(typeof header.name).toBe('string');
      expect(header.name.length).toBeGreaterThan(0);
      expect(header).not.toHaveProperty('type');
      expect(header).not.toHaveProperty('code');
    }
  });

  test.each(FILES)('%s: a script written in the file is a script Bruno loads', (file) => {
    const text = fs.readFileSync(path.join(COLLECTION, file), 'utf8');
    const loaded = scriptTypes(yaml.load(text));
    for (const type of ['before-request', 'after-response']) {
      if (text.includes(`type: ${type}`)) expect(loaded).toContain(type);
    }
  });

  test('a script under http.headers is caught (the F1 layout)', () => {
    const broken = [
      'http:',
      '  method: GET',
      '  url: "{{api_base}}/x"',
      '  headers:',
      '    - name: Accept',
      '      value: application/json',
      '    - type: after-response',
      '      code: |-',
      '        test("x", () => {});',
    ].join('\n');
    const doc = yaml.load(broken);
    expect(scriptTypes(doc)).not.toContain('after-response');
    expect(doc.http.headers[1]).toHaveProperty('type', 'after-response');
  });
});

// #644: a by-id system-information request is not sent with "null" in its
// path when no id was configured and the list call gave none.
describe('#644: by-id requests without an id are skipped', () => {
  const CASES = [
    ['01-System Infos Requests/02. GET Coach By Id.yml', 'coachId', 'coachListCandidateIds'],
    ['01-System Infos Requests/09. GET Product By ProductId.yml', 'productId', 'productListCandidateIds'],
  ];
  const beforeRequest = (file) => yaml.load(fs.readFileSync(path.join(COLLECTION, file), 'utf8'))
    .runtime.scripts.find((s) => s.type === 'before-request').code;
  const runScript = (file, env) => {
    let skipped = false;
    const bru = {
      getEnvVar: (k) => env[k],
      setEnvVar: (k, v) => { env[k] = v; },
      setVar: () => {},
      runner: { skipRequest: () => { skipped = true; } },
    };
    const fakeRequire = () => ({ resolveEffectiveVersion: () => '3.8.0', atLeast: () => true });
    new Function('bru', 'require', 'console', beforeRequest(file))(bru, fakeRequire, { log: () => {} });
    return { skipped, env };
  };

  test.each(CASES)('%s', (file, idVar, listVar) => {
    expect(runScript(file, { [idVar]: 'null' }).skipped).toBe(true);
    expect(runScript(file, { [idVar]: '', [listVar]: '[]' }).skipped).toBe(true);
    const picked = runScript(file, { [idVar]: null, [listVar]: '["A1"]' });
    expect(picked.skipped).toBe(false);
    expect(picked.env[idVar]).toBe('A1');
    expect(runScript(file, { [idVar]: 'X9' }).skipped).toBe(false);
  });
});
