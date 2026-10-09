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
    const ctx = page(['loadForEdit', 'loadedVersion', 'refreshAllSections'], {
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
    expect(t.ctx.datafileLoadedVersion).toBeUndefined();    // no ETag in this answer: a later save sends no version
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
    expect(t.ctx.datafileLoadedVersion).toBeNull();         // #540: the next save says "there was none"
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

// ── #549: an upload changes the data file and nothing else ───────────────────
describe('upload (handleFileUpload): the data file and nothing else', () => {
  const writesOf = (calls) => calls.filter(c => !c.startsWith('GET '));
  const UPLOADED = {
    osdmVersion: '3.8',
    scenarios: [{ code: 'A', scenarioType: 'SALE' }, { code: 'B', scenarioType: 'REFUND' }],
    tripRequirements: [{
      id: 1, tripType: 'SEARCH',
      trip: { origin: 'urn:uic:stn:1', destination: 'urn:uic:stn:2', startDatetime: '%TRIP_DATE%T08:00:00+02:00', vehicleNumber: '123' },
    }],
  };
  const NAMES = ['handleFileUpload', 'countScenarios', 'uploadConfirmText', 'uploadRefusalText', 'offerBuildFromUpload',
    'loadForEdit', 'frameworkFromDatafile', 'trainFromTrip', 'trainsFromDatafile'];

  function setup({ uploadAnswer = response(200, { scenarios_count: 2, previous: { scenarios_count: 5 } }),
    framework = response(200, { config: { osdmVersion: '3.9.0' } }), resources = response(200, [{ resource_type: 'TRAIN' }]),
    answers = [], fileText = JSON.stringify(UPLOADED), stored = { scenarios: [1, 2, 3, 4, 5] }, dirty = false } = {}) {
    const { fetch, calls } = fakeFetch({
      [`POST ${DATAFILE}`]: uploadAnswer,
      [`GET ${FRAMEWORK}`]: framework,
      [`GET ${RESOURCES}`]: resources,
      [`PUT ${FRAMEWORK}`]: response(200, {}),
      [`POST ${RESOURCES}`]: response(201, {}),
    });
    const input = { files: [{ name: 'mine.json', text: async () => fileText }], value: 'C:\\fakepath\\mine.json' };
    const ctx = page(NAMES, {
      fetch, state: stored, dirty, asked: [], messages: [], errors: [], toasts: [], reloads: 0, loggedOut: 0,
      confirm(text) { ctx.asked.push(text); return answers.length ? answers.shift() : true; },
      FormData: class { append() {} },
      emptyFramework: () => ({ fulfillmentTypes: ['ETICKET'] }),
      hidePanels() {}, logout() { ctx.loggedOut++; },
      loadDatafile: async () => { ctx.reloads++; },
      showMsg(m, ok) { ctx.messages.push([ok, m]); },
      showUploadError(m) { ctx.errors.push(m); },
      oscarToast(m, k) { ctx.toasts.push([k, m]); },
    });
    return { ctx, calls, input };
  }

  test('with a framework and trains: one request, the upload, and nothing written elsewhere', async () => {
    const t = setup();
    await t.ctx.handleFileUpload(t.input);
    expect(writesOf(t.calls)).toEqual([`POST ${DATAFILE}`]);
    expect(t.ctx.asked).toHaveLength(1);
    expect(t.ctx.asked[0]).toContain('Now: 5 scenario(s).');
    expect(t.ctx.asked[0]).toContain('After: 2 scenario(s).');
    expect(t.ctx.asked[0]).toContain('The Test Framework and Test Data are not changed.');
    expect(t.ctx.messages[0][1]).toContain('Restore previous file');
    expect(t.ctx.dirty).toBe(false);
    expect(t.input.value).toBe('');
  });

  test('cancelled at the confirmation: no request at all', async () => {
    const t = setup({ answers: [false] });
    await t.ctx.handleFileUpload(t.input);
    expect(t.calls).toEqual([]);
    expect(t.input.value).toBe('');
  });

  test('unsaved edits are named in the confirmation', async () => {
    const t = setup({ dirty: true, answers: [false] });
    await t.ctx.handleFileUpload(t.input);
    expect(t.ctx.asked[0]).toContain('edits that are not saved');
  });

  test('a refusal shows the reason and every problem, and nothing else happens', async () => {
    const t = setup({ uploadAnswer: response(400, { detail: 'This file is not a valid data file.', problems: ["'scenarios' is missing."], problems_truncated: true }) });
    await t.ctx.handleFileUpload(t.input);
    expect(t.calls).toEqual([`POST ${DATAFILE}`]);
    expect(t.ctx.errors).toEqual(["This file is not a valid data file.\n\n• 'scenarios' is missing.\n• … and more"]);
    expect(t.ctx.reloads).toBe(0);
  });

  test('a file that is not JSON goes to the server unconfirmed, and its refusal is shown', async () => {
    const t = setup({ fileText: '{ nope', uploadAnswer: response(400, { detail: 'Uploaded file is not valid JSON.' }) });
    await t.ctx.handleFileUpload(t.input);
    expect(t.ctx.asked).toEqual([]);
    expect(t.ctx.errors).toEqual(['Uploaded file is not valid JSON.']);
  });

  test('a company with no framework is offered one, built only on a yes', async () => {
    const yes = setup({ framework: response(404, {}) });
    await yes.ctx.handleFileUpload(yes.input);
    expect(writesOf(yes.calls)).toEqual([`POST ${DATAFILE}`, `PUT ${FRAMEWORK}`]);
    expect(yes.ctx.asked[1]).toContain('no Test Framework yet');
    expect(yes.ctx.toasts[0][0]).toBe('success');

    const no = setup({ framework: response(404, {}), answers: [true, false] });
    await no.ctx.handleFileUpload(no.input);
    expect(writesOf(no.calls)).toEqual([`POST ${DATAFILE}`]);
  });

  test('Test Data with no train is offered the trains of the file; with any train, nothing', async () => {
    const t = setup({ resources: response(200, [{ resource_type: 'PASSENGER' }]) });
    await t.ctx.handleFileUpload(t.input);
    expect(writesOf(t.calls)).toEqual([`POST ${DATAFILE}`, `POST ${RESOURCES}`]);
    expect(t.ctx.asked[1]).toContain('1 train(s) in Test Data');
  });

  test.each(FAILURES)('after %s of the framework or test data, nothing is offered or written', async (_label, r) => {
    const t = setup({ framework: r, resources: r });
    await t.ctx.handleFileUpload(t.input);
    expect(writesOf(t.calls)).toEqual([`POST ${DATAFILE}`]);
    expect(t.ctx.asked).toHaveLength(1);
  });

  test('a failed creation is reported, not swallowed', async () => {
    const t = setup({ framework: response(404, {}) });
    t.ctx.fetch = fakeFetch({
      [`POST ${DATAFILE}`]: response(200, { scenarios_count: 2, previous: null }),
      [`GET ${FRAMEWORK}`]: response(404, {}),
      [`GET ${RESOURCES}`]: response(200, []),
      [`PUT ${FRAMEWORK}`]: response(500, {}),
      [`POST ${RESOURCES}`]: new TypeError('Failed to fetch'),
    }).fetch;
    await t.ctx.handleFileUpload(t.input);
    expect(t.ctx.toasts).toEqual([['warning', 'Not created: the Test Framework, 1 of 1 train(s). The data file itself was uploaded.']]);
  });

  test('the framework built from a file: version, flows, passenger types, the rest at the default', () => {
    const ctx = page(['frameworkFromDatafile'], { emptyFramework: () => ({ fulfillmentTypes: ['ETICKET'], salesFlows: [] }) });
    const fw = ctx.frameworkFromDatafile({ ...UPLOADED, passengersList: [{ passengers: [{ type: 'PERSON' }, { type: 'DOG' }] }] });
    expect(JSON.parse(JSON.stringify(fw))).toEqual({ fulfillmentTypes: ['ETICKET'], osdmVersion: '3.8', salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT', 'DOG'] });
  });
});

describe('Download JSON (downloadJson): the server\'s file, never the page\'s copy', () => {
  function setup(answer) {
    const { fetch, calls } = fakeFetch({ [`GET ${DATAFILE}/download`]: answer });
    const ctx = page(['downloadJson', 'downloadFileName'], {
      fetch, isTester: false, dirty: true, saved: [], messages: [], loggedOut: 0,
      state: { scenarios: ['what the page holds'] },
      saveBlob(blob, name) { ctx.saved.push([blob, name]); },
      showMsg(m, ok) { ctx.messages.push([ok, m]); },
      logout() { ctx.loggedOut++; },
    });
    return { ctx, calls };
  }
  const file = (status, bytes, disposition) => ({ ...response(status, {}), blob: async () => bytes,
    headers: { get: h => (h === 'Content-Disposition' ? disposition : null) } });

  test('saves what the server sends, under the name it gives', async () => {
    const t = setup(file(200, 'stored bytes', 'attachment; filename="acme-datafile-2026-10-09.json"'));
    await t.ctx.downloadJson();
    expect(t.calls).toEqual([`GET ${DATAFILE}/download`]);
    expect(t.ctx.saved).toEqual([['stored bytes', 'acme-datafile-2026-10-09.json']]);
    expect(t.ctx.messages[0][1]).toContain('not yet saved on this page are not in it');
  });

  test('a refusal is shown, and nothing is saved', async () => {
    const t = setup(response(404, { detail: 'No data file uploaded yet.' }));
    await t.ctx.downloadJson();
    expect(t.ctx.saved).toEqual([]);
    expect(t.ctx.messages).toEqual([[false, 'Download failed: No data file uploaded yet.']]);
  });

  test('a name that is not a plain file name is not used', () => {
    const ctx = page(['downloadFileName'], {});
    expect(ctx.downloadFileName('attachment; filename="../x/y.json"', 'datafile.json')).toBe('datafile.json');
    expect(ctx.downloadFileName(null, 'datafile.json')).toBe('datafile.json');
  });
});

// ── #540: a save names the version of the file it was made from ──────────────
describe('stale-save guard (the version a save sends back)', () => {
  const withEtag = (status, body, tag) => ({ ...response(status, body), headers: { get: (h) => (h === 'ETag' ? tag : null) } });

  test('loadForEdit keeps the ETag of a loaded file as its version', async () => {
    const ctx = page(['loadForEdit'], { fetch: fakeFetch({ [`GET ${DATAFILE}`]: withEtag(200, { scenarios: [] }, '"v1"') }).fetch });
    const out = await ctx.loadForEdit(DATAFILE, 'The test configuration');
    expect(out).toEqual({ state: 'loaded', value: { scenarios: [] }, version: '"v1"' });
  });

  test('loadedVersion / datafileSaveHeaders: If-Match for a loaded file, If-None-Match for none, nothing when unknown', () => {
    const ctx = page(['loadedVersion', 'datafileSaveHeaders'], {});
    expect(ctx.loadedVersion({ state: 'loaded', version: '"v1"' })).toBe('"v1"');
    expect(ctx.loadedVersion({ state: 'loaded' })).toBeUndefined();
    expect(ctx.loadedVersion({ state: 'none' })).toBeNull();
    expect(ctx.loadedVersion({ state: 'failed' })).toBeUndefined();
    expect({ ...ctx.datafileSaveHeaders('"v1"') }).toEqual({ 'Content-Type': 'application/json', 'If-Match': '"v1"' });
    expect({ ...ctx.datafileSaveHeaders(null) }).toEqual({ 'Content-Type': 'application/json', 'If-None-Match': '*' });
    expect({ ...ctx.datafileSaveHeaders(undefined) }).toEqual({ 'Content-Type': 'application/json' });
  });

  function saving(putAnswer) {
    const sent = [];
    const { fetch, calls } = fakeFetch({
      [`PUT ${DATAFILE}/json`]: (opts) => { sent.push(opts.headers); return putAnswer; },
      [`GET ${DATAFILE}`]: withEtag(200, { scenarios: [], scenariosToRun: [] }, '"v2"'),
    });
    const ctx = page(['saveDatafile', 'datafileSaveHeaders', 'staleSaveMessage'], {
      fetch, state: { scenarios: [], scenariosToRun: [] }, dirty: true, isTestManager: false,
      datafileLoadedVersion: '"v1"', errors: [], confirmed: 0, refreshed: 0,
      setSaveBtnState() {}, hidePanels() {}, logout() {}, incrementVersion: (v) => v,
      showSaveError(m) { ctx.errors.push(m); }, showSaveConfirm() { ctx.confirmed++; },
      refreshAllSections: async () => { ctx.refreshed++; },
    });
    return { ctx, calls, sent };
  }

  test('saveDatafile sends the version it loaded', async () => {
    const t = saving(response(200, { to_run: [] }));
    await t.ctx.saveDatafile();
    expect(t.sent[0]['If-Match']).toBe('"v1"');
    expect(t.ctx.confirmed).toBe(1);
    expect(t.ctx.dirty).toBe(false);
  });

  test('a 412 is shown as "changed since loaded", the edits stay, and nothing is re-read', async () => {
    const t = saving(response(412, { detail: 'The data file has changed since this page loaded it.' }));
    await t.ctx.saveDatafile();
    expect(t.calls).toEqual([`PUT ${DATAFILE}/json`]);
    expect(t.ctx.errors).toHaveLength(1);
    expect(t.ctx.errors[0]).toContain('changed since this page loaded it');
    expect(t.ctx.errors[0]).toContain('Download unsaved edits');
    expect(t.ctx.dirty).toBe(true);
    expect(t.ctx.refreshed).toBe(0);
  });

  test('every data file save in the page sends a version', () => {
    const text = SOURCE.join('\n');
    const puts = text.split("fetch('/v1/company/datafile/json'").slice(1).map(s => s.slice(0, 200));
    expect(puts).toHaveLength(3);
    for (const p of puts) expect(p).toMatch(/headers: datafileSaveHeaders\(/);
    expect(text).toContain('headers: datafileSaveHeaders(loadedVersion(dfLoad))');           // the wizard: its own load
    expect(text).toContain('datafileLoadedVersion = loadedVersion(dfLoad);');                  // refreshAllSections
  });
});
