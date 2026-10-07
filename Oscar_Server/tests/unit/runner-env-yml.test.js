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
    expect(yml.startsWith('name: "OTST_Test_Env"\nvariables:\n')).toBe(true);   // quoted since PR-03
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

// ── PR-03 / NEW-02: a value is data, never structure ─────────────────────────
// Every value written to the file used to be pasted between two double quotes
// as it came. A scenario code is free text a tester stores, so a code holding a
// quote and a line break added variables of its own to the run's environment,
// a second api_base among them; Bruno 4.2.1 uses the last one, and the run's
// requests, token included, went to it. The tests below read the file twice:
// with a strict reader that accepts only the shapes the runner writes
// (tests/helpers/env-yml.js), and with js-yaml, the parser Bruno itself uses.
const yaml = require('js-yaml');
const { readEnvYml, valueIn } = require('../helpers/env-yml');
const { CHILD_ENV_ALLOWLIST } = require('../../src/worker/runner');

const FIXED = ['api_base', 'library_base', 'data_base', 'json_schema', 'scenariosToRunIndex'];

// Strings that mean something to a YAML parser, or to the person reading a log.
const HOSTILE = [
  'X"\n  - name: api_base\n    value: "https://elsewhere.example/collect',
  'X"\r\n  - name: data_base\r\n    value: "http://elsewhere.example/file.json',
  'say "hi"',
  'ends with a backslash\\',
  String.raw`a\"b`,
  String.raw`A written out, not a letter`,
  'tab\there', 'bell\u0007', 'nul\u0000', 'del\u007f',
  'next line\u0085x', 'line separator\u2028x', 'paragraph separator\u2029x', 'bom\ufeffx',
  'accents éàü ß', 'emoji 🚆', 'lone surrogate \ud83d end',
  '  leading and trailing spaces  ',
  'key: value', '# not a comment', '- not: a list', '{{api_base}}', '!!js/function "x"', '&anchor *alias',
  "single 'quotes'", '%YAML 1.2', '---', '...', '|', '>',
];

function expectClean(yml, expectedNames) {
  const strict = readEnvYml(yml);                           // throws on any other line shape
  expect(strict.variables.map(v => v.name)).toEqual(expectedNames);
  const loaded = yaml.load(yml);                            // what Bruno's parser sees
  expect(Object.keys(loaded)).toEqual(['name', 'variables']);
  expect(loaded.variables.map(v => Object.keys(v))).toEqual(expectedNames.map(() => ['name', 'value']));
  expect(loaded.variables).toEqual(strict.variables);
  expect(loaded.name).toBe(strict.name);
  expect(/^[\x20-\x7e\n]*$/.test(yml)).toBe(true);          // printable ASCII and line feeds only
  return strict;
}

describe('buildEnvYml — values are data, never structure (PR-03, NEW-02)', () => {
  const [env, api, , data] = BASE;

  test('a crafted scenario code stays one value and adds no variable', () => {
    const code = HOSTILE[0];
    const file = expectClean(buildEnvYml(env, api, '', data, code, null), [...FIXED, 'scenario_override']);
    expect(valueIn(file, 'scenario_override')).toBe(code);
    expect(valueIn(file, 'api_base')).toBe(api);            // valueIn throws if it appears twice
    expect(valueIn(file, 'data_base')).toBe(data);
  });

  test.each(HOSTILE.map(s => [JSON.stringify(s), s]))('scenario code %s comes back unchanged', (_shown, hostile) => {
    const file = expectClean(buildEnvYml(env, api, '', data, hostile, null), [...FIXED, 'scenario_override']);
    expect(valueIn(file, 'scenario_override')).toBe(hostile);
  });

  test('the same holds for the endpoint, the requestor, the datafile address and the environment name', () => {
    for (const hostile of HOSTILE) {
      const asEndpoint = expectClean(buildEnvYml(env, hostile, '', data, '', null), FIXED);
      expect(valueIn(asEndpoint, 'api_base')).toBe(hostile);

      const asRequestor = expectClean(buildEnvYml(env, api, hostile, data, '', null), [...FIXED, 'requestor']);
      expect(valueIn(asRequestor, 'requestor')).toBe(hostile);

      const asDatafile = expectClean(buildEnvYml(env, api, '', hostile, '', null), FIXED);
      expect(valueIn(asDatafile, 'data_base')).toBe(hostile);

      const asName = expectClean(buildEnvYml(hostile, api, '', data, '', null), FIXED);
      expect(asName.name).toBe(hostile);
    }
  });

  test('dedicated headers with hostile names and values come back unchanged', () => {
    const headers = HOSTILE.map((s, i) => ({ name: `x-h${i}`, value: s }));
    headers.push({ name: HOSTILE[0], value: 'a hostile name' });
    const file = expectClean(buildEnvYml(env, api, '', data, '', headers), [...FIXED, '__extraHeaders']);
    expect(JSON.parse(valueIn(file, '__extraHeaders'))).toEqual(headers);
  });

  test('all of them hostile at once', () => {
    const [a, b, c, d, e] = HOSTILE;
    const file = expectClean(buildEnvYml(a, b, c, d, e, [{ name: a, value: b }]), [...FIXED, 'requestor', 'scenario_override', '__extraHeaders']);
    expect([file.name, valueIn(file, 'api_base'), valueIn(file, 'requestor'), valueIn(file, 'data_base'), valueIn(file, 'scenario_override')])
      .toEqual([a, b, c, d, e]);
  });

  test('2,000 random strings from an awkward alphabet come back unchanged', () => {
    const alphabet = ['"', '\\', '\n', '\r', '\t', ' ', ':', '-', '#', '{', '}', "'", 'a', 'Z', '0', 'u', 'n',
      '\u0000', '\u007f', '\u0085', '\u2028', '\u2029', '\ufeff', 'é', '\ud83d', '\ude86'];
    let seed = 20261006;                                    // fixed, so a failure can be replayed
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let i = 0; i < 2000; i++) {
      let s = '';
      const length = 1 + (next() % 24);
      for (let k = 0; k < length; k++) s += alphabet[next() % alphabet.length];
      const yml = buildEnvYml(env, api, s, data, s, [{ name: 'h', value: s }]);
      const file = readEnvYml(yml);
      expect([i, valueIn(file, 'requestor'), valueIn(file, 'scenario_override')]).toEqual([i, s, s]);
      expect([i, JSON.parse(valueIn(file, '__extraHeaders'))]).toEqual([i, [{ name: 'h', value: s }]]);
      expect([i, yaml.load(yml).variables]).toEqual([i, file.variables]);
    }
  });

  test('an ordinary run writes the same lines as before, apart from the quoted name', () => {
    const yml = buildEnvYml('OTST_bileto_0a1b2c3d_Env', 'https://osdm.example/api', 'req-42',
      'http://localhost:3001/data/bileto-datafile.json', 'OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG',
      [{ name: 'X-Tenant', value: '{{requestor}}' }]);
    const lines = yml.split('\n');
    expect(lines[0]).toBe('name: "OTST_bileto_0a1b2c3d_Env"');
    expect(lines[9].startsWith('    value: "http')).toBe(true);   // json_schema: set by the server's own environment
    lines[9] = '    value: "<json schema address>"';
    expect(lines).toEqual([
      'name: "OTST_bileto_0a1b2c3d_Env"',
      'variables:',
      '  - name: api_base',
      '    value: "https://osdm.example/api"',
      '  - name: library_base',
      '    value: "./library-bruno/"',
      '  - name: data_base',
      '    value: "http://localhost:3001/data/bileto-datafile.json"',
      '  - name: json_schema',
      '    value: "<json schema address>"',
      '  - name: scenariosToRunIndex',
      '    value: "0"',
      '  - name: requestor',
      '    value: "req-42"',
      '  - name: scenario_override',
      '    value: "OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG"',
      '  - name: __extraHeaders',
      String.raw`    value: "[{\"name\":\"X-Tenant\",\"value\":\"{{requestor}}\"}]"`,
      '',
    ]);
  });
});

describe('the list of what a child process may inherit (PR-03, NEW-01)', () => {
  test('is fixed, and names no secret of the server', () => {
    expect(Array.isArray(CHILD_ENV_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(CHILD_ENV_ALLOWLIST)).toBe(true);
    expect(CHILD_ENV_ALLOWLIST).toContain('PATH');
    for (const key of CHILD_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/KEY|SECRET|TOKEN|PASS|SMTP|JWT|CREDENTIAL|OSCAR_|DATABASE|DB_/i);
    }
  });
});
