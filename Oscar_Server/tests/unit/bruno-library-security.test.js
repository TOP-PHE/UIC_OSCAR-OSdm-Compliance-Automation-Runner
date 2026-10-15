// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-library-security.test.js — the two Sonar vulnerabilities of
 * library-bruno (#758): no code downloaded at run time is executed (S1523,
 * validators.js), and request ids are not drawn from Math.random (S2245,
 * scenarioParser.js). The last test keeps the library free of both.
 */

const fs = require('node:fs');
const path = require('node:path');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => envStore[k],
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       () => undefined,
  setVar:       () => {},
};
global.validationLogger = () => {};

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => { envStore = {}; });

describe('randomUUID (scenarioParser.js)', () => {
  test('a v4 UUID from crypto, a new one each time', () => {
    const { randomUUID } = require(path.join(LIB, 'scenarioParser.js'));
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(V4);
  });

  test('without crypto (a sandbox that does not give it): still a v4 UUID, unique within the run', () => {
    jest.isolateModules(() => {
      jest.doMock('node:crypto', () => { throw new Error('crypto is not available here'); });
      const { randomUUID } = require(path.join(LIB, 'scenarioParser.js'));
      // 1 and 10, 2 and 20…: the first fallback cut its seed and gave those the same id.
      const ids = Array.from({ length: 300 }, () => randomUUID());
      expect(new Set(ids).size).toBe(300);
      for (const id of ids) expect(id).toMatch(V4);
    });
    jest.dontMock('node:crypto');
  });
});

describe('swaggerSchemaValidatorContent (validators.js)', () => {
  const validators = () => require(path.join(LIB, 'validators.js'));

  test('without the captured schema it says so and stops', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    validators().swaggerSchemaValidatorContent();
    expect(spy.mock.calls.flat().join(' ')).toContain('swaggerJson env var is missing');
    spy.mockRestore();
  });

  test('with the schema it validates at once: nothing is downloaded, scriptContent is never read or written', () => {
    const sent = jest.fn();
    global.bru.sendRequest = sent;
    const read = jest.spyOn(global.bru, 'getEnvVar');
    envStore.swaggerJson = JSON.stringify({ paths: { '/offers': { post: { responses: {} } } } });
    envStore.url = '{{api_base}}/offers';
    envStore.method = 'POST';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    validators().swaggerSchemaValidatorContent();
    expect(sent).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([k]) => k)).not.toContain('scriptContent');
    expect(envStore).not.toHaveProperty('scriptContent');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('No matching path');
    spy.mockRestore();
    read.mockRestore();
    delete global.bru.sendRequest;
  });

  test('a schema that is not JSON is reported, not thrown', () => {
    envStore.swaggerJson = '{not json';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validators().swaggerSchemaValidatorContent()).not.toThrow();
    expect(spy.mock.calls.flat().join(' ')).toContain('Error during the Swagger validation');
    spy.mockRestore();
  });
});

describe('the library keeps clear of both', () => {
  // Comments are left out: the reasons for the rule name what it forbids.
  const code = (file) => fs.readFileSync(path.join(LIB, file), 'utf8')
    .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));

  test.each(['new Function(', 'Math.random(', 'eval('])('no %s in library-bruno', (call) => {
    expect(files.filter((f) => code(f).includes(call))).toEqual([]);
  });
});
