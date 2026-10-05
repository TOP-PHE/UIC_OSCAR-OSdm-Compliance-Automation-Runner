// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenarios-load-guard.test.js — #534.
 *
 * Test Config used to treat ANY failed load (no network, 403, 429, 500) as
 * "this company has nothing yet". The scenario wizard then built an empty
 * datafile, added the new scenario and saved it over the stored one: for a
 * Test Manager that replaced the whole company datafile.
 *
 * The rule now: only a 404 means "none". After any other failure nothing on
 * the page is replaced and nothing is written.
 *
 * There is no browser here. The real functions are lifted out of
 * public/js/scenarios.js and run in a `vm` context with a fake `fetch` and a
 * fake `document`, so what is tested is the code the page runs. A function is
 * located by its `function name(` / `async function name(` line at column 0
 * and the next line that is just `}`.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8')
  .replaceAll('\r\n', '\n').split('\n');

function sourceOf(name) {
  const start = SOURCE.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`scenarios.js: no top-level function ${name} at column 0`);
  const end = SOURCE.findIndex((l, i) => i > start && l === '}');
  return SOURCE.slice(start, end + 1).join('\n');
}

// Runs the named functions in one context, on top of the given globals.
function page(names, globals) {
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(names.map(sourceOf).join('\n\n'), context, { filename: 'scenarios.js (extract)' });
  return context;
}

const INVALID_JSON = Symbol('invalid json');
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === INVALID_JSON) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}

// A fake server: `routes` maps "METHOD url" to a response, an Error (the request fails), or a function.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    calls.push(key);
    const r = typeof routes[key] === 'function' ? routes[key](opts) : routes[key];
    if (r === undefined) throw new Error(`unexpected request in test: ${key}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const DATAFILE = '/v1/company/datafile';
const FRAMEWORK = '/v1/company/test-framework';
const RESOURCES = '/v1/company/test-resources';
const COMPANY = '/v1/company';

const FAILURES = [
  ['a 500', response(500, { title: 'Internal Server Error' }), 'the server answered 500'],
  ['a 429 from the rate limiter', response(429, {}), 'the server answered 429'],
  ['a 403', response(403, {}), 'the server answered 403'],
  ['a network error', new TypeError('Failed to fetch'), 'the server could not be reached (Failed to fetch)'],
  ['a body that is not JSON', response(200, INVALID_JSON), 'the answer could not be read'],
];

describe('loadForEdit', () => {
  const load = (r) => page(['loadForEdit'], { fetch: fakeFetch({ [`GET ${DATAFILE}`]: r }).fetch })
    .loadForEdit(DATAFILE, 'The test configuration');

  test('200 with an object is loaded', async () => {
    const df = { scenarios: [] };
    await expect(load(response(200, df))).resolves.toEqual({ state: 'loaded', value: df });
  });

  test('200 with a list is loaded', async () => {
    await expect(load(response(200, [{ id: 1 }]))).resolves.toEqual({ state: 'loaded', value: [{ id: 1 }] });
  });

  test('404 is the only answer that means "none"', async () => {
    await expect(load(response(404, { detail: 'No data file uploaded yet.' }))).resolves.toEqual({ state: 'none' });
  });

  test('401 means the session is gone', async () => {
    await expect(load(response(401, {}))).resolves.toEqual({ state: 'signedOut' });
  });

  test.each(FAILURES)('%s is a failure, and says so', async (_label, r, expected) => {
    const out = await load(r);
    expect(out.state).toBe('failed');
    expect(out.reason).toContain('The test configuration could not be loaded');
    expect(out.reason).toContain(expected);
  });

  test.each([[null], ['text'], [42], [true]])('200 with %j instead of an object is a failure', async (body) => {
    expect((await load(response(200, body))).state).toBe('failed');
  });
});

describe('refreshAllSections (page load and every refresh)', () => {
  function setup(routes) {
    const { fetch, calls } = fakeFetch({ [`GET ${COMPANY}`]: response(200, { name: 'ACME Rail' }), ...routes });
    const rendered = [];
    const elements = {};
    const before = {
      state: { marker: 'state before the refresh' },
      framework: { marker: 'framework before the refresh' },
      resources: [{ marker: 'resources before the refresh' }],
    };
    const ctx = page(['loadForEdit', 'refreshAllSections'], {
      fetch,
      loggedOut: 0,
      logout() { ctx.loggedOut++; },
      state: before.state,
      dirty: false,
      isTester: false,
      wizProfile: {},
      wizData: { framework: before.framework, resources: before.resources },
      emptyFramework: () => ({ empty: true }),
      migrateLegacySalesFlowActions() {},
      migrateMissingOfferSearchCriteria() {},
      setSaveBtnState() {},
      renderFrameworkSection: (fw) => rendered.push(['framework', fw]),
      renderTestDataSection: (fw, res) => rendered.push(['data', res]),
      renderScenariosSection: (fw, res, df) => rendered.push(['scenarios', df]),
      document: {
        getElementById: (id) => (elements[id] ||= { style: {}, closest: () => null }),
        querySelectorAll: () => [],
      },
    });
    return { ctx, calls, rendered, elements, before };
  }
  const present = {
    [`GET ${FRAMEWORK}`]: response(200, { config: { osdmVersion: '3.8' } }),
    [`GET ${RESOURCES}`]: response(200, [{ id: 7, resource_type: 'TRAIN' }]),
    [`GET ${DATAFILE}`]: response(200, { scenarios: [{ code: 'A' }], scenariosToRun: ['A'] }),
  };

  function expectNothingReplaced({ ctx, rendered, before }) {
    expect(ctx.state).toBe(before.state);
    expect(ctx.wizData.framework).toBe(before.framework);
    expect(ctx.wizData.resources).toBe(before.resources);
    expect(rendered).toEqual([]);
  }

  test('everything present: the page takes what the server holds', async () => {
    const t = setup(present);
    await t.ctx.refreshAllSections();
    expect(t.ctx.state).toEqual({ scenarios: [{ code: 'A' }], scenariosToRun: ['A'] });
    expect(t.ctx.wizData.framework).toEqual({ osdmVersion: '3.8' });
    expect(t.ctx.wizData.resources).toEqual([{ id: 7, resource_type: 'TRAIN' }]);
    expect(t.rendered.map(r => r[0])).toEqual(['framework', 'data', 'scenarios']);
    expect(t.elements['btn-download'].style.display).toBe('');
    expect(t.calls).toEqual([`GET ${FRAMEWORK}`, `GET ${RESOURCES}`, `GET ${COMPANY}`, `GET ${DATAFILE}`]);
  });

  test('a new company (404 for the framework and the datafile) opens empty, as before', async () => {
    const t = setup({
      [`GET ${FRAMEWORK}`]: response(404, {}),
      [`GET ${RESOURCES}`]: response(200, []),
      [`GET ${DATAFILE}`]: response(404, {}),
    });
    await t.ctx.refreshAllSections();
    expect(t.ctx.wizData.framework).toEqual({ empty: true });
    expect(t.ctx.wizData.resources).toEqual([]);
    expect(t.rendered).toEqual([['framework', null], ['data', []], ['scenarios', null]]);
    expect(t.elements['btn-download'].style.display).toBe('none');
  });

  describe.each([
    ['the datafile', DATAFILE, 'The test configuration could not be loaded'],
    ['the Test Framework', FRAMEWORK, 'The Test Framework could not be loaded'],
    ['the test data', RESOURCES, 'The test data could not be loaded'],
  ])('when loading %s fails', (_what, url, sentence) => {
    test.each(FAILURES)('with %s: it throws and replaces nothing', async (_label, r, expected) => {
      const t = setup({ ...present, [`GET ${url}`]: r });
      const err = await t.ctx.refreshAllSections().then(() => null, e => e);
      expect(err).not.toBeNull();
      expect(err.message).toContain(sentence);
      expect(err.message).toContain(expected);
      expect(err.message).toContain('The page was not refreshed');
      expectNothingReplaced(t);
      expect(t.ctx.loggedOut).toBe(0);
    });
  });

  test.each([[FRAMEWORK], [RESOURCES], [DATAFILE]])('a 401 on %s signs the user out and replaces nothing', async (url) => {
    const t = setup({ ...present, [`GET ${url}`]: response(401, {}) });
    await t.ctx.refreshAllSections();
    expect(t.ctx.loggedOut).toBe(1);
    expectNothingReplaced(t);
  });
});

describe('wizGenerateScenario (the path that wrote over the stored datafile)', () => {
  function setup(datafileAnswer) {
    const { fetch, calls } = fakeFetch({ [`GET ${DATAFILE}`]: datafileAnswer });
    const btn = { disabled: false, textContent: '' };
    const status = { innerHTML: '' };
    const ctx = page(['loadForEdit', 'wizGenerateScenario'], {
      fetch,
      loggedOut: 0,
      logout() { ctx.loggedOut++; },
      wizScenario: { type: 'SALE', passengers: { ADULT: 1 } },
      wizData: { framework: { osdmVersion: '3.8' } },
      emptyFramework: () => ({}),
      oscarToast() {},
      esc: (s) => String(s),
      wizGenCode: () => 'OTST_SALE_TEST',
      // The first thing the wizard does once it has a datafile to build on.
      wizGenPassengers: () => { throw new Error('REACHED_THE_BUILD_STEP'); },
      document: { getElementById: (id) => ({ 's3-gen-btn': btn, 's3-gen-status': status }[id] || null) },
    });
    return { ctx, calls, btn, status };
  }
  const writes = (calls) => calls.filter(c => !c.startsWith('GET '));

  test.each(FAILURES)('after %s nothing is built and nothing is written', async (_label, r, expected) => {
    const t = setup(r);
    await t.ctx.wizGenerateScenario();
    expect(t.calls).toEqual([`GET ${DATAFILE}`]);
    expect(writes(t.calls)).toEqual([]);
    expect(t.status.innerHTML).toContain(expected);
    expect(t.status.innerHTML).toContain('The scenario was not generated');
    expect(t.status.innerHTML).not.toContain('REACHED_THE_BUILD_STEP');
    expect(t.btn.disabled).toBe(false);
  });

  test('a 404 is "no datafile yet": the wizard goes on and starts a fresh file', async () => {
    const t = setup(response(404, {}));
    await t.ctx.wizGenerateScenario();
    expect(t.status.innerHTML).toContain('REACHED_THE_BUILD_STEP');
    expect(t.status.innerHTML).not.toContain('The scenario was not generated');
  });

  test('a loaded datafile: the wizard goes on and builds on it', async () => {
    const t = setup(response(200, { scenarios: [{ code: 'EXISTING' }], scenariosToRun: [] }));
    await t.ctx.wizGenerateScenario();
    expect(t.status.innerHTML).toContain('REACHED_THE_BUILD_STEP');
  });

  test('a 401 signs the user out; nothing is written', async () => {
    const t = setup(response(401, {}));
    await t.ctx.wizGenerateScenario();
    expect(t.ctx.loggedOut).toBe(1);
    expect(writes(t.calls)).toEqual([]);
  });
});

describe('extractFromDatafile (trains copied into Test Data on upload)', () => {
  const uploaded = {
    osdmVersion: '3.8',
    scenarios: [{ scenarioType: 'SALE' }],
    tripRequirements: [{
      id: 1, tripType: 'SEARCH',
      trip: { origin: 'urn:uic:stn:1', destination: 'urn:uic:stn:2', startDatetime: '%TRIP_DATE%T08:00:00+02:00', vehicleNumber: '123' },
    }],
  };
  function setup(resourcesAnswer) {
    const toasts = [];
    const { fetch, calls } = fakeFetch({
      [`PUT ${FRAMEWORK}`]: response(200, {}),
      [`GET ${RESOURCES}`]: resourcesAnswer,
      [`POST ${RESOURCES}`]: response(201, {}),
    });
    const ctx = page(['loadForEdit', 'extractFromDatafile'], {
      fetch,
      emptyFramework: () => ({}),
      oscarToast: (message, kind) => toasts.push([kind, message]),
      console: { log() {}, warn() {} },
    });
    return { ctx, calls, toasts };
  }
  const posts = (calls) => calls.filter(c => c === `POST ${RESOURCES}`).length;

  test('the existing list loads and is empty: the train is added', async () => {
    const t = setup(response(200, []));
    await t.ctx.extractFromDatafile(uploaded);
    expect(posts(t.calls)).toBe(1);
    expect(t.toasts).toEqual([]);
  });

  test.each(FAILURES)('after %s no train is added, and the user is told', async (_label, r, expected) => {
    const t = setup(r);
    await t.ctx.extractFromDatafile(uploaded);
    expect(posts(t.calls)).toBe(0);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0][0]).toBe('warning');
    expect(t.toasts[0][1]).toContain(expected);
    expect(t.toasts[0][1]).toContain('were not added to Test Data');
  });
});
