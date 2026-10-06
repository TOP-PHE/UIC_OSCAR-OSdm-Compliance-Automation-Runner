// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runner-env-yml.test.js — the Bruno environment file worker/runner.js writes
 * for each run (buildEnvYml).
 *
 * The file had no test. #524 restyled three of its statements (one push() per
 * pair of lines, replaceAll for the header escaping), so the output is pinned
 * here: which variables appear, in which order, and how the Dedicated Headers
 * JSON is escaped to survive inside a YAML double-quoted scalar.
 */

const { buildEnvYml } = require('../../src/worker/runner');

const BASE = ['OTST_Test_Env', 'https://api.example.test/osdm', '', 'http://127.0.0.1:3001/data/x.json', '', null];

function names(yml) {
  return yml.split('\n').filter(l => l.startsWith('  - name: ')).map(l => l.slice('  - name: '.length));
}

function valueOf(yml, name) {
  const lines = yml.split('\n');
  const i = lines.indexOf(`  - name: ${name}`);
  return i === -1 ? undefined : lines[i + 1];
}

describe('buildEnvYml', () => {
  test('the base file names the environment and carries the five fixed variables', () => {
    const yml = buildEnvYml(...BASE);
    expect(yml.startsWith('name: OTST_Test_Env\nvariables:\n')).toBe(true);
    expect(yml.endsWith('\n')).toBe(true);
    expect(names(yml)).toEqual(['api_base', 'library_base', 'data_base', 'json_schema', 'scenariosToRunIndex']);
    expect(valueOf(yml, 'api_base')).toBe('    value: "https://api.example.test/osdm"');
    expect(valueOf(yml, 'data_base')).toBe('    value: "http://127.0.0.1:3001/data/x.json"');
    expect(valueOf(yml, 'scenariosToRunIndex')).toBe('    value: "0"');
  });

  test('requestor and scenario_override are appended, in that order, only when given', () => {
    const [env, api, , data] = BASE;
    const yml = buildEnvYml(env, api, 'req-42', data, 'OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG', null);
    expect(names(yml).slice(5)).toEqual(['requestor', 'scenario_override']);
    expect(valueOf(yml, 'requestor')).toBe('    value: "req-42"');
    expect(valueOf(yml, 'scenario_override')).toBe('    value: "OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG"');

    const onlyOverride = buildEnvYml(env, api, '', data, 'NHF_RFND_SRCH_CRIT_2ADT_2LEG', []);
    expect(names(onlyOverride).slice(5)).toEqual(['scenario_override']);
  });

  test('dedicated headers travel as one JSON string with its quotes escaped', () => {
    const [env, api, , data] = BASE;
    const yml = buildEnvYml(env, api, '', data, '', [{ name: 'a', value: 'b' }]);
    expect(names(yml).slice(5)).toEqual(['__extraHeaders']);
    expect(valueOf(yml, '__extraHeaders')).toBe(String.raw`    value: "[{\"name\":\"a\",\"value\":\"b\"}]"`);
  });

  test('a backslash in a header value is doubled again for YAML', () => {
    const [env, api, , data] = BASE;
    // JSON.stringify writes the one backslash as two; YAML escaping doubles those.
    const yml = buildEnvYml(env, api, '', data, '', [{ name: 'p', value: String.raw`C:\dir` }]);
    expect(valueOf(yml, '__extraHeaders')).toBe(String.raw`    value: "[{\"name\":\"p\",\"value\":\"C:\\\\dir\"}]"`);
  });

  test('un-escaping the scalar gives back the original headers', () => {
    const [env, api, , data] = BASE;
    const headers = [
      { name: 'tracestate', value: 'say "hi"' },
      { name: 'x-path', value: String.raw`a\b\\c` },
      { name: 'x-tpl', value: '{{requestor}}/$& $1' },
    ];
    const line = valueOf(buildEnvYml(env, api, '', data, '', headers), '__extraHeaders');
    const scalar = line.slice('    value: "'.length, -1);
    // Undo the YAML double-quoted escapes this function applies: \\ and \".
    const json = scalar.replace(/\\(["\\])/g, '$1');
    expect(JSON.parse(json)).toEqual(headers);
  });

  test('an empty or missing header list adds nothing', () => {
    const [env, api, , data] = BASE;
    expect(names(buildEnvYml(env, api, '', data, '', []))).toHaveLength(5);
    expect(names(buildEnvYml(env, api, '', data, '', undefined))).toHaveLength(5);
  });
});
