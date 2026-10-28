// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ui-scripts.test.js — the scripts under Oscar_Server/public, without a browser.
 *
 * 1. Every inline <script> block and every file under public/js compiles.
 *    ESLint ignores public/, and the inline-script lint only looks for a stray
 *    closing script tag, so until now nothing in CI would notice a syntax
 *    error in a page.
 * 2. The pure helpers rewritten for #525 (file-name and code clean-up, the
 *    report builder's JSON label) are pulled out of their page and run in a
 *    bare `vm` context. Their old regular expressions could backtrack
 *    quadratically; the tests pin what the helpers return and that a
 *    pathological input is now handled in linear time.
 *
 * A helper is located by its `function name(` line at column 0 and the next
 * line that is just `}`. That is how every top-level function in these files
 * is laid out; if one is ever reformatted, `loadFunction` fails loudly.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n');

// Walks the page the way the HTML parser does, as dashboard-pages.test.js does:
// a script element ends at the first "</script" followed by whitespace, "/" or ">".
function inlineScripts(html) {
  const blocks = [];
  const openRe = /<script\b([^>]*)>/gi;
  let position = 0;
  while (position < html.length) {
    openRe.lastIndex = position;
    const open = openRe.exec(html);
    if (!open) break;
    const attrs = open[1] || '';
    const start = open.index + open[0].length;
    const closeRe = /<\/script[\s/>]/gi;
    closeRe.lastIndex = start;
    const close = closeRe.exec(html);
    const end = close ? close.index : html.length;
    const tagEnd = close ? html.indexOf('>', end) : -1;
    position = tagEnd === -1 ? html.length : tagEnd + 1;
    if (/\bsrc\s*=/i.test(attrs)) continue;                                  // external file
    if (/\btype\s*=\s*["']?(?!text\/javascript|module)[\w/+-]+/i.test(attrs)) continue; // data block, not code
    blocks.push({
      code: html.slice(start, end),
      line: html.slice(0, open.index).split('\n').length,
      module: /\btype\s*=\s*["']?module/i.test(attrs),
    });
  }
  return blocks;
}

function loadFunction(rel, name, context = {}) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`${rel}: no top-level "function ${name}(" at column 0`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error(`${rel}: no closing brace at column 0 after function ${name}`);
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `${rel}#${name}` });
}

// Generous on purpose: the old patterns needed seconds on these inputs.
const LINEAR_BUDGET_MS = 500;
function elapsedMs(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

describe('every script under public/ compiles', () => {
  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  const jsFiles = fs.readdirSync(path.join(PUBLIC_DIR, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`);

  test('there is something to check', () => {
    expect(htmlFiles.length).toBeGreaterThan(10);
    expect(jsFiles).toContain('js/scenarios.js');
    // The walker must actually find the inline scripts, or the checks below pass on nothing.
    expect(htmlFiles.flatMap(f => inlineScripts(read(f))).length).toBeGreaterThan(10);
  });

  test.each(htmlFiles)('%s: inline scripts', (file) => {
    for (const block of inlineScripts(read(file))) {
      if (block.module) continue;   // import/export need a module loader; none of the pages uses one today
      expect(() => new vm.Script(block.code, { filename: `${file} (inline script at line ${block.line})` })).not.toThrow();
    }
  });

  test.each(jsFiles)('%s', (file) => {
    expect(() => new vm.Script(read(file), { filename: file })).not.toThrow();
  });
});

describe('js/scenarios.js — actions that nothing awaits (#526)', () => {
  // The click, change and timer handlers start async functions without awaiting
  // them. Sonar (S9383) types that as a bug: if the function rejects, the error
  // is lost. Each such call now ends in .catch(reportActionError). This reads
  // the source the way the rule does, for the named top-level async functions:
  // a call that starts a statement and is closed by ";" right after its ")".
  function bareAsyncCalls(source) {
    const lines = source.split('\n');
    const names = lines.map(l => /^async function ([\w$]+)\(/.exec(l)).filter(Boolean).map(m => m[1]);
    const call = new RegExp(String.raw`(?:^\s*|[;{}]\s*|\)\s+|:\s+)(${names.join('|')})\((?:[^()]|\([^()]*\))*\)\s*;`, 'g');
    const found = [];
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const m of line.matchAll(call)) found.push(`L${i + 1} ${m[1]}`);
    });
    return { names, found };
  }

  test('the check itself sees a bare call, and only a bare call', () => {
    const sample = [
      'async function save() {',
      '}',
      'async function load(x) {',
      '}',
      'function handler(e) {',
      '  save();',
      "  switch (a) { case 'x': e.stopPropagation(); load(Number.parseInt(v)); break; }",
      '  save().catch(report);',
      '  await save();',
      '  const p = load(1);',
      '  return save();',
      '  // save();',
      '}',
    ].join('\n');
    expect(bareAsyncCalls(sample)).toEqual({ names: ['save', 'load'], found: ['L6 save', 'L7 load'] });
  });

  test('no top-level async function of the page is called and left on its own', () => {
    const { names, found } = bareAsyncCalls(read('js/scenarios.js'));
    expect(names.length).toBeGreaterThan(15);
    expect(names).toEqual(expect.arrayContaining(['refreshAllSections', 'saveDatafile', 'wizGenerateScenario', 'loadDatafile']));
    expect(found).toEqual([]);
  });

  test('reportActionError logs the error and shows its message', () => {
    const toasts = [];
    const logged = [];
    const reportActionError = loadFunction('js/scenarios.js', 'reportActionError', {
      console: { error: (...args) => logged.push(args) },
      oscarToast: (message, kind) => toasts.push([message, kind]),
    });
    const failure = new Error('The test configuration could not be loaded: the server answered 500.');
    reportActionError(failure);
    reportActionError('plain text');
    reportActionError(undefined);
    expect(toasts).toEqual([
      ['The test configuration could not be loaded: the server answered 500.', 'error'],
      ['plain text', 'error'],
      ['undefined', 'error'],
    ]);
    expect(logged).toHaveLength(3);
    expect(logged[0][1]).toBe(failure);
  });
});

describe('js/scenarios.js — setTripFieldByPath', () => {
  // The path segments are strings. isNaN() converts before it tests;
  // Number.isNaN() does not, and would call every segment a number (#526).
  function setter(trip) {
    const context = { state: { tripRequirements: [trip] }, dirty: 0 };
    context.markDirty = () => { context.dirty++; };
    return { set: loadFunction('js/scenarios.js', 'setTripFieldByPath', context), context };
  }

  test('writes through names and numeric indexes', () => {
    const trip = { trip: { legs: [{ timedLeg: { start: { stopPlaceRef: 'old' } } }, { timedLeg: {} }] } };
    const { set, context } = setter(trip);
    set(0, 'trip.legs.0.timedLeg.start.stopPlaceRef', 'urn:uic:stn:8507000');
    set(0, 'trip.legs.1.timedLeg.service', 'IC 1');
    expect(trip.trip.legs[0].timedLeg.start.stopPlaceRef).toBe('urn:uic:stn:8507000');
    expect(trip.trip.legs[1].timedLeg.service).toBe('IC 1');
    expect(trip.trip.legs).toHaveLength(2);
    expect(context.dirty).toBe(2);
  });

  test('creates what is missing: an array before a number, an object before a name', () => {
    const trip = {};
    const { set } = setter(trip);
    set(0, 'trip.searchCriteria.via.0.viaPlace.stopPlaceRef', 'urn:uic:stn:8500010');
    expect(Array.isArray(trip.trip.searchCriteria.via)).toBe(true);
    expect(trip).toEqual({ trip: { searchCriteria: { via: [{ viaPlace: { stopPlaceRef: 'urn:uic:stn:8500010' } }] } } });
  });

  test('a numeric last segment sets an array element', () => {
    const trip = { tags: ['a', 'b'] };
    const { set } = setter(trip);
    set(0, 'tags.1', 'c');
    expect(trip.tags).toEqual(['a', 'c']);
  });

  test('a negative index is ignored', () => {
    const trip = { a: 1 };
    const { set, context } = setter(trip);
    set(-1, 'a', 2);
    expect(trip).toEqual({ a: 1 });
    expect(context.dirty).toBe(0);
  });
});

describe('js/esc.js — the one shared esc (tracker S11)', () => {
  // S11: every page's encoder was consolidated into js/esc.js. It is CommonJS-
  // requireable (the same dual-mode shape as scenario-access.js), so load it
  // directly rather than lifting a top-level function.
  const { esc } = require('../../public/js/esc.js');

  test('it keeps the form CodeQL recognises as an encoder', () => {
    // Sonar (S7781) asks for replaceAll('<', ...). #526 did that, and CodeQL then
    // reported escaped values reaching innerHTML as XSS: it knows an encoder by
    // replace() with a global regex. If this fails, read the comment in esc.js.
    const body = read('js/esc.js').split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    for (const pattern of [String.raw`.replace(/&/g,`, String.raw`.replace(/</g,`, String.raw`.replace(/>/g,`, String.raw`.replace(/"/g,`, String.raw`.replace(/'/g,`]) {
      expect(body).toContain(pattern);
    }
    expect(body).not.toContain('replaceAll');
  });

  test.each([
    ['<b onclick="x(\'y\')">a & b</b>', '&lt;b onclick=&quot;x(&#39;y&#39;)&quot;&gt;a &amp; b&lt;/b&gt;'],
    ['&&&', '&amp;&amp;&amp;'],
    ['<<>>""\'\'', '&lt;&lt;&gt;&gt;&quot;&quot;&#39;&#39;'],
    ['&lt;', '&amp;lt;'],
    ['plain text', 'plain text'],
    ['$& $1 $$', '$&amp; $1 $$'],
  ])('%j → %j', (input, expected) => {
    expect(esc(input)).toBe(expected);
  });

  test('null and undefined give an empty string; other values are converted', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(0)).toBe('0');
    expect(esc(false)).toBe('false');
  });
});

// S11: the dashboard is opened by a certifier of another tenant, and it renders
// tenant-controlled strings (api_base_used, submitted_by, env_name_used,
// deleted_by, scenario_code). A hostile value must come back escaped, not break
// out of the HTML. The renders are lifted and run with the real shared esc.
describe('dashboard.html — tenant strings are escaped (S11)', () => {
  const { esc } = require('../../public/js/esc.js');
  const XSS = '"><img src=x onerror=alert(1)>';
  const baseCtx = { esc, fmtDate: () => 'd', duration: () => '0s', shareLineFor: () => '',
    user: { id: 'me', role: 'administrator' }, selected: new Set(), compared: new Set(), canDelete: true };

  test('renderRunRow escapes api_base_used, submitted_by and the label', () => {
    const render = loadFunction('dashboard.html', 'renderRunRow', baseCtx);
    const html = render({ id: '00000000-1111-2222-3333-444444444444', status: 'FAILED',
      api_base_used: XSS, submitted_by: XSS, env_name_used: XSS, user_id: 'other', artifact_count: 0 }, {});
    expect(html).not.toContain('<img src=x onerror=');       // no breakout
    expect(html).toContain('&lt;img src=x onerror=');          // present, escaped
    expect(html).not.toContain('"><img');
  });

  test('renderAdminDeletedRuns escapes env_name_used, api_base_used and deleted_by', () => {
    let written = '';
    const el = { style: {}, set innerHTML(v) { written = v; }, get innerHTML() { return written; } };
    const doc = { getElementById: () => el };
    const render = loadFunction('dashboard.html', 'renderAdminDeletedRuns', { ...baseCtx, document: doc });
    render([{ id: '00000000-1111-2222-3333-444444444444', status: 'DELETED_BY_ADMIN',
      api_base_used: XSS, env_name_used: XSS, deleted_by: XSS }]);
    expect(written).not.toContain('<img src=x onerror=');
    expect(written).toContain('&lt;img src=x onerror=');
  });
});

describe('js/scenarios.js — overruleCodeChoices (#596)', () => {
  // The refusal probe needs a code the provider does not support, so while it
  // is on the picker offers every listed code, not only the declared ones.
  const choices = (sc, type = 'REFUND') => loadFunction('js/scenarios.js', 'overruleCodeChoices', {
    fwIropsCodesFor: () => ['CONNECTION_BROKEN', 'TECHNICAL_FAILURE'],
    WIZ_IROPS_MANDATORY: ['CONNECTION_BROKEN', 'STRIKE'],
    WIZ_IROPS_OPTIONAL: ['PAYMENT_FAILURE', 'STRIKE'],
  })(type, sc);

  test('the declared codes, with "none" first, when the probe is off or unset', () => {
    for (const sc of [undefined, {}, { overruleCodeExpectRejection: 'off' }]) {
      expect(choices(sc)).toEqual([null, 'CONNECTION_BROKEN', 'TECHNICAL_FAILURE']);
    }
  });

  test('every listed code, once each, when the probe is on', () => {
    expect(choices({ overruleCodeExpectRejection: 'on' })).toEqual([null, 'CONNECTION_BROKEN', 'STRIKE', 'PAYMENT_FAILURE']);
  });

  test('an exchange keeps the declared codes: the probe is a refund step', () => {
    expect(choices({ overruleCodeExpectRejection: 'on' }, 'EXCHANGE')).toEqual([null, 'CONNECTION_BROKEN', 'TECHNICAL_FAILURE']);
  });
});

describe('js/scenarios.js — fwIropsCodesFor', () => {
  // Reads the framework through two optional chains since #526. The answer
  // for a missing or odd framework must stay an empty list.
  const codesFor = (wizData, type) => loadFunction('js/scenarios.js', 'fwIropsCodesFor', { wizData })(type);

  test('returns the codes configured for the scenario type', () => {
    const wizData = { framework: { iropsCodes: { refund: ['DELAY', 'CANCELLED'], exchange: ['STRIKE'] } } };
    expect(codesFor(wizData, 'REFUND')).toEqual(['DELAY', 'CANCELLED']);
    expect(codesFor(wizData, 'exchange')).toEqual(['STRIKE']);
  });

  test.each([
    ['no working copy yet', null],
    ['no framework', {}],
    ['a framework with no IROPS codes', { framework: {} }],
    ['IROPS codes set to null', { framework: { iropsCodes: null } }],
    ['nothing for this type', { framework: { iropsCodes: { exchange: ['STRIKE'] } } }],
    ['a value that is not a list', { framework: { iropsCodes: { refund: 'DELAY' } } }],
  ])('%s → []', (_label, wizData) => {
    expect(codesFor(wizData, 'REFUND')).toEqual([]);
  });

  test('SALE and a missing type have no codes', () => {
    const wizData = { framework: { iropsCodes: { sale: ['X'], refund: ['DELAY'] } } };
    expect(codesFor(wizData, 'SALE')).toEqual([]);
    expect(codesFor(wizData, '')).toEqual([]);
    expect(codesFor(wizData, undefined)).toEqual([]);
  });
});

describe('js/scenarios.js — small helpers rewritten for #526', () => {
  // Expected values were taken from the functions as they were before the
  // rewrite (startsWith / includes in place of a regex test and indexOf).
  const decodeCode = loadFunction('js/scenarios.js', 'decodeCode');
  const egPlaceholder = loadFunction('js/scenarios.js', 'egPlaceholder');
  const isDefaultPurchaserValue = loadFunction('js/scenarios.js', 'isDefaultPurchaserValue', { PURCHASER_DEFAULT_PREFIX: 'Purchaser_' });
  const isAutoGeneratedFirstName = loadFunction('js/scenarios.js', 'isAutoGeneratedFirstName', { WIZ_RANDOM_FIRST_NAMES: ['Anna', 'Ben'] });

  test.each([
    ['OTST_SALE_SRCH_CRIT_1ADT_1LEG', 'Sale — Search criteria — 1 Adult — 1 Leg'],
    ['OTST_RFND_FULL_TRIP_SPEC_2ADT_1CHD_2LEG_SEAT', 'Refund — 2 Adults + 1 Child — 2 Legs — Seat selection'],
    ['SALE_SRCH_CRIT_1ADT_1LEG', 'Sale — Search criteria — 1 Adult — 1 Leg'],
    ['TUR_SALEOPT_RFND', 'TUR_SALEOPT_RFND'],
    ['NOTOTST_SALE_X', 'NOTOTST_SALE_X'],
    ['XOTST_SALE', 'XOTST_SALE'],
    ['OTST_', 'Sale'],
    ['', ''],
  ])('decodeCode(%j) → %j', (code, expected) => {
    expect(decodeCode(code)).toBe(expected);
  });

  test.each([
    ['Paris', 'e.g. Paris'],
    ['e.g. Paris', 'e.g. Paris'],
    ['e.g.Paris', 'e.g. e.g.Paris'],
    ['E.G. x', 'e.g. E.G. x'],
    [42, 'e.g. 42'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('egPlaceholder(%j) → %j', (placeholder, expected) => {
    expect(egPlaceholder(placeholder)).toBe(expected);
  });

  test.each([
    ['Purchaser_Smith', true],
    ['Purchaser_', true],
    ['purchaser_x', false],
    ['My Purchaser_', false],
    ['', false],
    [null, false],
    [5, false],
  ])('isDefaultPurchaserValue(%j) → %j', (value, expected) => {
    expect(isDefaultPurchaserValue(value)).toBe(expected);
  });

  test.each([
    ['Anna', true],
    ['Ben', true],
    ['anna', false],
    ['Zed', false],
    ['', false],
    [null, false],
  ])('isAutoGeneratedFirstName(%j) → %j', (name, expected) => {
    expect(isAutoGeneratedFirstName(name)).toBe(expected);
  });
});

describe('js/scenarios.js — functions whose nested conditionals were unfolded (#526)', () => {
  // Expected values were taken from the functions as they were before.
  const page = 'js/scenarios.js';
  const escHtml = require('../../public/js/esc.js').esc;   // S11: esc is shared now
  const optionValue = loadFunction(page, 'optionValue');

  test('optionValue: null and undefined are the empty option, anything else is itself', () => {
    expect(optionValue(null)).toBe('');
    expect(optionValue(undefined)).toBe('');
    expect(optionValue('')).toBe('');
    expect(optionValue(0)).toBe(0);
    expect(optionValue(false)).toBe(false);
    expect(optionValue('A')).toBe('A');
  });

  test.each([
    [{ f: null }, '<option value="" selected>none</option><option value="A" >A</option>'],
    [{ f: 'A' }, '<option value="" >none</option><option value="A" selected>A</option>'],
    [{}, '<option value="" selected>none</option><option value="A" >A</option>'],
    [{ f: 'B' }, '<option value="" >none</option><option value="A" >A</option>'],
  ])('buildSelect marks the stored value: %j', (scenario, options) => {
    const buildSelect = loadFunction(page, 'buildSelect', {
      esc: escHtml, optionValue, lbl: (o) => (o == null ? 'none' : String(o)), state: { scenarios: [scenario] },
    });
    expect(buildSelect(0, 'f', 'L', [null, 'A'])).toContain(options);
  });

  test('parseServiceToken turns bare station codes into URNs and leaves URNs alone', () => {
    const parse = loadFunction(page, 'parseServiceToken');
    expect(parse('IC100|IC|2026-01-01T08:00:00|10:00|8500010|urn:uic:stn:8400058')).toEqual({
      vehicleNumber: 'IC100', productCategory: 'IC', departureTime: '08:00:00', arrivalTime: '10:00',
      originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8400058',
    });
    expect(parse('7|RJ|1|2')).toEqual({
      vehicleNumber: '7', productCategory: 'RJ', departureTime: '1', arrivalTime: '2', originURN: '', destinationURN: '',
    });
    expect(parse('x|y|z|w|  URN:X:stn:9  |')).toMatchObject({ originURN: 'URN:X:stn:9', destinationURN: '' });
    expect(parse('a|b|c')).toBeNull();
    expect(parse('|b|c|d')).toBeNull();
  });

  test.each([
    ['no resources', undefined, { origin: '', destination: '' }],
    ['no train among them', [{ resource_type: 'JOURNEY', data: {} }], { origin: '', destination: '' }],
    ['a train', [{ resource_type: 'TRAIN', data: { originURN: 'A', destinationURN: 'B' } }], { origin: 'A', destination: 'B' }],
    ['a train stored as text', [{ resource_type: 'TRAIN', data: '{"originURN":"A"}' }], { origin: 'A', destination: '' }],
    ['a train with no data', [{ resource_type: 'TRAIN' }], { origin: '', destination: '' }],
  ])('_ttSeedOD: %s', (_label, resources, expected) => {
    const seed = loadFunction(page, '_ttSeedOD', { wizData: { resources }, normalizeTrainData: loadFunction(page, 'normalizeTrainData', { OscarTripApply: require('../../public/js/trip-apply') }) });
    expect(seed()).toEqual(expected);
  });

  test('renderDiscoveryDays: one line per day, the error only on a failed day', () => {
    const el = { innerHTML: '' };
    loadFunction(page, 'renderDiscoveryDays', { esc: escHtml })(el, [
      { status: 200, date: '2026-01-01', trips: 3, legs: 5, via: 'A', error: 'not shown' },
      { status: 500, date: '2026-01-02', error: 'boom <b>' },
      { status: 404, date: '2026-01-03' },
    ]);
    expect(el.innerHTML).toContain('✅ 2026-01-01</td><td style="padding:2px 8px;font-size:11.5px;color:#607d8b">3 trip(s), 5 leg(s) via A</td>');
    expect(el.innerHTML).toContain('⚠️ 2026-01-02</td><td style="padding:2px 8px;font-size:11.5px;color:#607d8b">HTTP 500 — boom &lt;b&gt;</td>');
    expect(el.innerHTML).toContain('⚠️ 2026-01-03</td><td style="padding:2px 8px;font-size:11.5px;color:#607d8b">HTTP 404</td>');
    expect(el.innerHTML).not.toContain('not shown');
  });
});

describe('js/scenarios.js — helpers moved out of their host function (#526)', () => {
  const page = 'js/scenarios.js';
  const escHtml = require('../../public/js/esc.js').esc;   // S11: esc is shared now
  const isArmed = loadFunction(page, 'isArmed');
  const returnModelUndeclared = loadFunction(page, 'returnModelUndeclared', {
    scenarioReturnModel: loadFunction(page, 'scenarioReturnModel'),
    fwReturnModels: loadFunction(page, 'fwReturnModels'),
  });
  // #713: the page's scope table, read from its source as the page writes it.
  const scopeLines = read(page).split('\n');
  const scopeStart = scopeLines.indexOf('const FW_PARTIAL_REFUND_SCOPES = [');
  const FW_PARTIAL_REFUND_SCOPES = vm.runInNewContext(
    scopeLines.slice(scopeStart, scopeLines.indexOf('];', scopeStart) + 1).join('\n').replace('const FW_PARTIAL_REFUND_SCOPES = ', ''));
  const fwPartialScopeDeclared = loadFunction(page, 'fwPartialScopeDeclared');
  const undeclaredPartialScopes = loadFunction(page, 'undeclaredPartialScopes', { isArmed, fwPartialScopeDeclared, FW_PARTIAL_REFUND_SCOPES });

  test('isArmed accepts the spellings datafiles use, and nothing else', () => {
    for (const v of [true, 'on', 'true', 'yes', 1]) expect(isArmed(v)).toBe(true);
    for (const v of [false, 'off', 'ON', 'no', '1', 0, 2, null, undefined, '']) expect(isArmed(v)).toBe(false);
  });

  test.each([
    ['partial refund by leg armed, flow not declared', [{ scenarioType: 'REFUND', partialRefundByLeg: 'on' }], ['SALE', 'REFUND_FULL'], 1],
    ['the flow is declared', [{ scenarioType: 'REFUND', partialRefundByPax: true }], ['REFUND_PARTIAL'], 0],
    ['nothing armed', [{ scenarioType: 'refund', partialRefundByLeg: 'off' }], [], 0],
    ['a SALE scenario is not counted', [{ scenarioType: 'SALE', partialRefundByLeg: 'on' }], [], 0],
    ['two of three', [{ scenarioType: 'Refund', partialRefundByPax: 'yes' }, { scenarioType: 'REFUND', partialRefundByLeg: 1 }, {}], [], 2],
    ['#595: by fulfillment armed, flow not declared', [{ scenarioType: 'REFUND', partialRefundByFulfillment: 'on' }], ['REFUND_FULL'], 1],
    ['#595: by fulfillment armed, flow declared', [{ scenarioType: 'REFUND', partialRefundByFulfillment: 'on' }], ['REFUND_PARTIAL'], 0],
  ])('fwUndeclaredArmedCount: %s', (_label, scenarios, salesFlows, expected) => {
    const count = loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, returnModelUndeclared, undeclaredPartialScopes, state: { scenarios }, wizData: { framework: { salesFlows } } });
    expect(count()).toBe(expected);
  });

  test('fwUndeclaredArmedCount with nothing loaded', () => {
    expect(loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, returnModelUndeclared, undeclaredPartialScopes, state: null, wizData: null })()).toBe(0);
  });

  test.each([
    ['#619: a return in a model not declared', [{ offerSearchCriteria: { returnOffsetDays: 2, returnModel: 'COMBINED' } }], ['SEPARATE'], 1],
    ['#619: SEPARATE is the model of a return that names none', [{ offerSearchCriteria: { returnOffsetDays: 0 } }], ['COMBINED'], 1],
    ['#619: a declared model', [{ offerSearchCriteria: { returnOffsetDays: '1', returnModel: 'COMBINED' } }], ['SEPARATE', 'COMBINED'], 0],
    ['#619: no return, nothing declared', [{ offerSearchCriteria: { returnModel: 'COMBINED' } }], [], 0],
    ['#619: a framework from before the declaration', [{ offerSearchCriteria: { returnOffsetDays: 2 } }], undefined, 0],
    ['#619: counted once with a partial refund too', [{ scenarioType: 'REFUND', partialRefundByLeg: 'on', offerSearchCriteria: { returnOffsetDays: 2 } }], [], 1],
  ])('fwUndeclaredArmedCount: %s', (_label, scenarios, returnModels, expected) => {
    const count = loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, returnModelUndeclared, undeclaredPartialScopes, state: { scenarios }, wizData: { framework: { salesFlows: [], returnModels } } });
    expect(count()).toBe(expected);
  });

  test('#713: the scope table is the server\'s', () => {
    const { PARTIAL_REFUND_SCOPES, gatingRules } = require('../../src/utils/frameworkGating');
    expect(FW_PARTIAL_REFUND_SCOPES.map(([scope]) => scope).sort()).toEqual([...PARTIAL_REFUND_SCOPES].sort());
    const ruleScopes = Object.fromEntries(gatingRules().filter((r) => r.scope).map((r) => [r.field, r.scope]));
    expect(Object.fromEntries(FW_PARTIAL_REFUND_SCOPES.map(([scope, field]) => [field, scope]))).toEqual(ruleScopes);
  });

  test.each([
    ['no list: every scope', { partialRefundByLeg: 'on', partialRefundByPax: 'on' }, undefined, []],
    ['fulfillment only, leg armed', { partialRefundByLeg: 'on' }, ['FULFILLMENT'], ['per leg']],
    ['fulfillment only, fulfillment armed', { partialRefundByFulfillment: true }, ['FULFILLMENT'], []],
    ['none declared, two armed', { partialRefundByPax: 'yes', partialRefundByFulfillment: 'on' }, [], ['per fulfillment', 'per passenger']],
    ['off is not armed', { partialRefundByLeg: 'off' }, [], []],
  ])('#713 undeclaredPartialScopes: %s', (_label, flags, scopes, expected) => {
    expect(undeclaredPartialScopes({ scenarioType: 'REFUND', ...flags }, { partialRefundScopes: scopes })).toEqual(expected);
  });

  test('#713 fwTogglePartialScope: the first click starts from every scope', () => {
    const wizData = { framework: {} };
    const el = { cls: new Set(['selected']), classList: { toggle(c, on) { if (on) el.cls.add(c); else el.cls.delete(c); } } };
    const toggle = loadFunction(page, 'fwTogglePartialScope', { wizData, FW_PARTIAL_REFUND_SCOPES });
    toggle(el, 'LEG');
    expect(wizData.framework.partialRefundScopes).toEqual(['FULFILLMENT', 'PASSENGER']);
    expect(el.cls.has('selected')).toBe(false);
    toggle(el, 'LEG');
    expect(wizData.framework.partialRefundScopes).toEqual(['FULFILLMENT', 'PASSENGER', 'LEG']);
    expect(el.cls.has('selected')).toBe(true);
  });

  test('#713 partialScopePanelHtml: open with REFUND_PARTIAL, a pill per scope, selected when declared', () => {
    const panel = loadFunction(page, 'partialScopePanelHtml', { FW_PARTIAL_REFUND_SCOPES, fwPartialScopeDeclared, esc: escHtml });
    const html = panel({ salesFlows: ['REFUND_PARTIAL'], partialRefundScopes: ['FULFILLMENT'] });
    expect(html).toContain('class="irops-panel open" id="partial-REFUND"');
    expect(html).toContain('<div class="pill selected" data-action="fw-partial-scope" data-val="FULFILLMENT">Per fulfillment</div>');
    expect(html).toContain('<div class="pill" data-action="fw-partial-scope" data-val="LEG">Per leg</div>');
    expect(panel({ salesFlows: [] })).toContain('class="irops-panel" id="partial-REFUND"');
    expect(panel({ salesFlows: [] }).match(/pill selected/g)).toHaveLength(3);
  });

  test('#713 undeclaredPartialScopes ignores anything but a refund', () => {
    expect(undeclaredPartialScopes({ scenarioType: 'EXCHANGE', partialRefundByLeg: 'on' }, { partialRefundScopes: [] })).toEqual([]);
    expect(undeclaredPartialScopes({ partialRefundByLeg: 'on' }, { partialRefundScopes: [] })).toEqual([]);
  });

  test.each([
    ['#713: a scope not declared, flow declared', [{ scenarioType: 'REFUND', partialRefundByLeg: 'on' }], ['FULFILLMENT'], 1],
    ['#713: the declared scope', [{ scenarioType: 'REFUND', partialRefundByFulfillment: 'on' }], ['FULFILLMENT'], 0],
    ['#713: no list, any scope', [{ scenarioType: 'REFUND', partialRefundByPax: 'on' }], undefined, 0],
  ])('fwUndeclaredArmedCount: %s', (_label, scenarios, partialRefundScopes, expected) => {
    const count = loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, returnModelUndeclared, undeclaredPartialScopes, state: { scenarios }, wizData: { framework: { salesFlows: ['REFUND_PARTIAL'], partialRefundScopes } } });
    expect(count()).toBe(expected);
  });

  test('#717 fillCalendarsSummary says what was filled and what was not', () => {
    const summary = loadFunction(page, 'fillCalendarsSummary');
    expect(summary({ updated: [], unresolved: [] })).toBe('Every train set already has its operating days.');
    expect(summary({ updated: [{ label: 'R', daysOfWeek: ['SAT', 'SUN'] }], unresolved: [{ label: 'M', reason: 'odd' }] }))
      .toBe('1 train set(s) given their days (R: SAT SUN). 1 left as they were (M: odd).');
    expect(summary({ updated: [], unresolved: [{ label: 'M', reason: 'odd' }] })).toBe('0 train set(s) given their days. 1 left as they were (M: odd).');
    expect(summary(null)).toBe('Every train set already has its operating days.');
  });

  test('armedCountBadge is amber when something is armed, grey when not', () => {
    const badge = loadFunction(page, 'armedCountBadge');
    const shape = 'display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700;';
    expect(badge(0, 4, 'armed')).toBe(`<span style="${shape}background:#eceff1;color:#90a4ae;margin-left:8px;vertical-align:middle">0 of 4 armed</span>`);
    expect(badge(2, 6)).toBe(`<span style="${shape}background:#FCC44D;color:#005A8A;margin-left:8px;vertical-align:middle">2 of 6</span>`);
  });

  test.each([
    [{ category: 'CHILD', firstName: 'ADULT_Marie' }, 'CHILD'],
    [{ firstName: 'senior_Anna' }, 'SENIOR'],
    [{ firstName: 'ACCOMP_PRM_Jo' }, 'ACCOMP_PRM'],
    [{ firstName: 'PRM_x' }, 'PRM'],
    [{ firstName: 'Anna' }, 'ADULT'],
    [{ firstName: 'DOG_Rex' }, 'ADULT'],
    [{}, 'ADULT'],
  ])('inferCategory(%j) → %j', (passenger, expected) => {
    expect(loadFunction(page, 'inferCategory')(passenger)).toBe(expected);
  });

  test('probeWarningHTML: one route, its probe date and its findings', () => {
    const line = loadFunction(page, 'probeWarningHTML', { esc: escHtml });
    expect(line({ label: 'A<B', probedAt: '2026-10-01T10:00:00Z', findings: ['f1', 'f<2'] }))
      .toBe('<div style="margin-bottom:6px"><strong>A&lt;B</strong> <span style="color:#a1887f">(probed 2026-10-01)</span><br>&nbsp;&nbsp;&bull; f1<br>&nbsp;&nbsp;&bull; f&lt;2</div>');
    expect(line({ label: 'x', findings: [] })).toBe('<div style="margin-bottom:6px"><strong>x</strong><br></div>');
  });
});

describe('js/scenarios.js — random test data (#542)', () => {
  // Names, phone numbers and dates of birth of generated passengers. They come
  // from crypto.getRandomValues() through randomInt(); CodeQL reports
  // Math.random() feeding such fields as a weak generator.
  const page = 'js/scenarios.js';
  // A generator that hands out a fixed list of 32-bit values, then repeats it.
  function withValues(values) {
    let i = 0;
    const crypto = { getRandomValues: (array) => { array[0] = values[i++ % values.length]; return array; } };
    const randomInt = loadFunction(page, 'randomInt', { crypto, Uint32Array });
    return { randomInt, calls: () => i };
  }

  test('randomInt stays in range and uses the cryptographic generator', () => {
    const { randomInt, calls } = withValues([0, 1, 9, 10, 4294967295]);
    expect([randomInt(10), randomInt(10), randomInt(10), randomInt(10), randomInt(10)]).toEqual([0, 1, 9, 0, 5]);
    expect(calls()).toBe(5);
  });

  test('randomInt of nothing is 0 and asks for no random value', () => {
    const { randomInt, calls } = withValues([7]);
    expect([randomInt(0), randomInt(-3), randomInt(undefined), randomInt(Number.NaN)]).toEqual([0, 0, 0, 0]);
    expect(calls()).toBe(0);
    expect(randomInt(1)).toBe(0);
  });

  test('randomPick takes the element the generator points at', () => {
    const { randomInt } = withValues([2, 3, 0]);
    const randomPick = loadFunction(page, 'randomPick', { randomInt });
    expect([randomPick(['a', 'b', 'c']), randomPick(['a', 'b', 'c']), randomPick(['a', 'b', 'c'])]).toEqual(['c', 'a', 'a']);
    expect(randomPick([])).toBeUndefined();
  });

  test('genPhone is a plus sign and ten digits', () => {
    const { randomInt } = withValues([3, 14, 15, 92, 65, 35, 89, 79, 32, 38]);
    expect(loadFunction(page, 'genPhone', { randomInt })()).toBe('+3452559928');
  });

  test.each([
    ['the youngest allowed, first day', [0, 0, 0], (y) => `${y - 60}-01-01`],
    ['the oldest allowed, last month and day', [42, 11, 27], (y) => `${y - 18}-12-28`],
    ['in between', [5, 6, 14], (y) => `${y - 55}-07-15`],
  ])('genDateOfBirth for ages 18 to 60: %s', (_label, values, expected) => {
    const { randomInt } = withValues(values);
    const year = new Date().getFullYear();
    expect(loadFunction(page, 'genDateOfBirth', { randomInt, Date })(18, 60)).toBe(expected(year));
  });

  test('a single age and an impossible range both give a valid date', () => {
    const { randomInt } = withValues([123456, 3, 9]);
    const year = new Date().getFullYear();
    expect(loadFunction(page, 'genDateOfBirth', { randomInt, Date })(30, 30)).toBe(`${year - 30}-04-10`);
    expect(loadFunction(page, 'genDateOfBirth', { randomInt, Date })(40, 30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the page no longer uses Math.random', () => {
    expect(read(page)).not.toContain('Math.random');
  });
});

describe('no page draws an id from Math.random (#841)', () => {
  // Sonar S2245 on report-builder.html; the rule of #542 and #758 everywhere.
  const pages = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))
    .concat(fs.readdirSync(path.join(PUBLIC_DIR, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`));

  test.each(pages)('%s', (rel) => {
    expect(read(rel)).not.toContain('Math.random(');
  });
});

describe('report-builder.html — jsonBlockLabel', () => {
  const jsonBlockLabel = loadFunction('report-builder.html', 'jsonBlockLabel');
  const label = (message) => jsonBlockLabel({ message });

  test.each([
    ['[JSON:Offer] {"offerId":"x"}', 'Offer'],
    ['[JSON:Booking request]', 'Booking request'],
    ['[JSON:Refund offer]   \n', 'Refund offer'],
    ['  [JSON:Trimmed first]  ', 'Trimmed first'],
  ])('explicit marker: %j → %j', (message, expected) => {
    expect(label(message)).toBe(expected);
  });

  test.each([
    ['Request body: {', 'Request body'],
    ['Selected offer {', 'Selected offer'],
    ['passengers:   [', 'passengers'],
    ['payload = [', 'payload ='],
  ])('text before the brace: %j → %j', (message, expected) => {
    expect(label(message)).toBe(expected);
  });

  test.each([
    ['no brace here'],
    ['key: value, then {'],
    ['{"starts":"with a brace"}'],
    ['[JSON:label] first line\nsecond line'],
    [''],
    [undefined],
  ])('falls back to "object": %j', (message) => {
    expect(label(message)).toBe('object');
  });

  test('a long run of spaces with no brace is rejected in linear time', () => {
    const message = 'label' + ' '.repeat(50000) + 'x';
    let out;
    expect(elapsedMs(() => { out = label(message); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(out).toBe('object');
  });
});

describe('file-name and code clean-up helpers', () => {
  const rb = loadFunction('report-builder.html', '_rbSanitiseFilename');
  const msg = loadFunction('run-detail.html', '_msgSanitiseFilename');
  const trimUnderscores = loadFunction('js/scenarios.js', 'trimUnderscores');
  const wizNormaliseCustomCode = loadFunction('js/scenarios.js', 'wizNormaliseCustomCode');

  test.each([
    ['OTST SALE/1: GET *offers?', 'OTST_SALE_1_GET_offers'],
    ['  leading and trailing  ', 'leading_and_trailing'],
    ['__a__b__', 'a_b'],
    ['a\\b|c<d>e"f', 'a_b_c_d_e_f'],
    ['///', ''],
    ['', ''],
  ])('both file-name sanitisers: %j → %j', (input, expected) => {
    expect(rb(input)).toBe(expected);
    expect(msg(input)).toBe(expected);
  });

  test('the sanitisers accept a missing value', () => {
    expect(rb(null)).toBe('');
    expect(rb(undefined)).toBe('');
    expect(msg(null)).toBe('');
  });

  test.each([
    ['__A__B__', 'A__B'],
    ['A', 'A'],
    ['___', ''],
    ['', ''],
    ['_A', 'A'],
    ['A_', 'A'],
  ])('trimUnderscores keeps the inside as it is: %j → %j', (input, expected) => {
    expect(trimUnderscores(input)).toBe(expected);
  });

  test.each([
    [' my code-1 ', 'MY_CODE_1'],
    ['__x__y__', 'X_Y'],
    ['sale / refund', 'SALE_REFUND'],
    ['***', ''],
    [null, ''],
  ])('wizNormaliseCustomCode: %j → %j', (input, expected) => {
    expect(wizNormaliseCustomCode(input)).toBe(expected);
  });

  test('a long run of underscores in the middle costs one pass', () => {
    const s = 'a' + '_'.repeat(200000) + 'b';
    let out;
    expect(elapsedMs(() => { out = trimUnderscores(s); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(out).toBe(s);
  });
});

describe('admin.html — autoSlug', () => {
  function slugOf(name) {
    const els = { 'new-co-name': { value: name }, 'new-co-slug': { value: 'unset' } };
    loadFunction('admin.html', 'autoSlug', { document: { getElementById: (id) => els[id] } })();
    return els['new-co-slug'].value;
  }

  test.each([
    ['Société Générale — Test!', 'societe-generale-test'],
    ['  SBB CFF FFS  ', 'sbb-cff-ffs'],
    ['--already--dashed--', 'already-dashed'],
    ['ČD / CHAPS', 'cd-chaps'],
    ['!!!', ''],
  ])('%j → %j', (name, expected) => {
    expect(slugOf(name)).toBe(expected);
  });
});

describe('run-detail.html — friendlyArtifactBase', () => {
  function baseFor(run) {
    return loadFunction('run-detail.html', 'friendlyArtifactBase', {
      currentRun: run,
      parseServerTs: (s) => new Date(s),
    })();
  }

  test('sandbox, date and scenario, with unsafe characters collapsed', () => {
    expect(baseFor({ env_name_used: 'OTST_Bileto_Env', started_at: '2026-10-05T10:00:00Z', scenario_code: 'OTST SALE/1' }))
      .toBe('Bileto_2026-10-05_OTST-SALE-1');
  });

  test('a name cut at 120 characters does not end on a separator', () => {
    // 18 characters of prefix + 99 X = 117, then "-.-" lands on 118-120.
    const scenario = 'X'.repeat(99) + '-.-' + 'Y'.repeat(40);
    const base = baseFor({ env_name_used: 'OTST_Bileto_Env', started_at: '2026-10-05T10:00:00Z', scenario_code: scenario });
    expect(base).toBe('Bileto_2026-10-05_' + 'X'.repeat(99));
  });

  test('nothing usable falls back to "sandbox_run"', () => {
    expect(baseFor(null)).toBe('sandbox_run');
  });
});

// ── #527: the pages ───────────────────────────────────────────────────────────
// Nested conditionals in the pages were taken apart; where the value depends on
// nothing but its inputs it became a top-level function, pinned here.

describe('pages — helpers taken out of nested conditionals (#527)', () => {
  test('admin.html configInputType: a sensitive value is a password field, even when numeric', () => {
    const configInputType = loadFunction('admin.html', 'configInputType');
    expect([[true, true], [true, false], [false, true], [false, false]].map(([sensitive, num]) => configInputType(sensitive, num)))
      .toEqual(['password', 'password', 'number', 'text']);
  });

  describe('compare.html diffErrorHtml', () => {
    const esc = require('../../public/js/esc.js').esc;   // S11: esc is shared now
    const diffErrorHtml = loadFunction('compare.html', 'diffErrorHtml', { esc });

    test("run B's error is shown, escaped, whatever the category", () => {
      expect(diffErrorHtml({ category: 'ADDED', run_a: { error: 'a' }, run_b: { error: '<b> & more' } }))
        .toBe('<div class="diff-error">&lt;b&gt; &amp; more</div>');
    });

    test("run A's error is shown only for a removed item", () => {
      expect(diffErrorHtml({ category: 'REMOVED', run_a: { error: 'gone' }, run_b: null })).toBe('<div class="diff-error">gone</div>');
      expect(diffErrorHtml({ category: 'PASSED_TO_FAILED', run_a: { error: 'gone' }, run_b: {} })).toBe('');
    });

    test('no error, an empty error or a missing run gives nothing', () => {
      for (const item of [{ category: 'REMOVED' }, { category: 'REMOVED', run_a: { error: '' }, run_b: { error: '' } }, { category: 'REMOVED', run_a: null, run_b: undefined }]) {
        expect(diffErrorHtml(item)).toBe('');
      }
    });
  });

  test('dashboard.html deleteModalVariant: tester wording for every role but Test Manager and administrator', () => {
    const deleteModalVariant = loadFunction('dashboard.html', 'deleteModalVariant');
    expect(['test_manager', 'administrator', 'company_user', 'certification_user', undefined, ''].map(deleteModalVariant))
      .toEqual(['test_manager', 'administrator', 'tester', 'tester', 'tester', 'tester']);
  });

  test('dashboard.html batchSummaryStatus', () => {
    const summary = loadFunction('dashboard.html', 'batchSummaryStatus');
    const of = (...statuses) => summary(statuses.map(status => ({ status })));
    expect(of('COMPLETED', 'FAILED', 'RUNNING')).toBe('FAILED');     // a failure wins
    expect(of('COMPLETED', 'RUNNING', 'QUEUED')).toBe('RUNNING');
    expect(of('RUNNING', 'QUEUED')).toBe('RUNNING');                 // running, nothing done yet
    expect(of('COMPLETED', 'COMPLETED')).toBe('COMPLETED');
    expect(of('QUEUED', 'QUEUED')).toBe('QUEUED');
    expect(of('COMPLETED', 'QUEUED')).toBe('RUNNING');               // partly done
    expect(of('CANCELLED', 'QUEUED')).toBe('QUEUED');
  });

  describe('report-builder.html', () => {
    test('httpStatusClass: by hundreds, s0 below 200 or without a status', () => {
      const httpStatusClass = loadFunction('report-builder.html', 'httpStatusClass');
      const cases = [[null, 's0'], [undefined, 's0'], [0, 's0'], [199, 's0'], [200, 's2'], [299, 's2'], [300, 's3'], [399, 's3'],
        [400, 's4'], [499, 's4'], [500, 's5'], [599, 's5'], [600, 's5'], ['404', 's4'], ['abc', 's0']];
      for (const [status, expected] of cases) expect([status, httpStatusClass(status)]).toEqual([status, expected]);
    });

    test('initialHttpTab: the first of response body, request body and response headers that has content', () => {
      const initialHttpTab = loadFunction('report-builder.html', 'initialHttpTab');
      const got = [];
      for (const res of [true, false]) for (const req of [true, false]) for (const hdr of [true, false]) got.push(initialHttpTab(res, req, hdr));
      expect(got).toEqual(['response', 'response', 'response', 'response', 'request', 'request', 'resHeaders', 'reqHeaders']);
    });

    test('runScenarioLabel: the scenario code, else the scenario names spaced out, else the environment or a short id', () => {
      const label = loadFunction('report-builder.html', 'runScenarioLabel');
      expect(label({ scenario_code: 'OTST_X', scenario_names: 'A,B' })).toBe('OTST_X');
      expect(label({ scenario_names: 'A,B,C' })).toBe('A, B, C');
      expect(label({ scenario_names: 'One' })).toBe('One');
      expect(label({ env_name_used: 'ENV', id: '1234567890' })).toBe('ENV');
      expect(label({ id: '1234567890' })).toBe('12345678');
    });

    test('looksLikeJsonOpener and looksLikeJsonContinuation', () => {
      const opener = loadFunction('report-builder.html', 'looksLikeJsonOpener');
      const continuation = loadFunction('report-builder.html', 'looksLikeJsonContinuation');
      for (const s of ['Selected Offer: {', 'items = [', 'key: {   ', '[JSON:offer] anything']) expect([s, opener(s)]).toEqual([s, true]);
      for (const s of ['plain text', '{', '}', 'a: b', '', null]) expect([s, opener(s)]).toEqual([s, false]);
      for (const s of ['  indented', '}', '],', '} ,  ']) expect([s, continuation(s)]).toEqual([s, true]);
      for (const s of ['{', 'text', '} x', '', null]) expect([s, continuation(s)]).toEqual([s, false]);
    });

    test('_rbSanitiseFilename still turns a slash and a backslash into an underscore', () => {
      const rb = loadFunction('report-builder.html', '_rbSanitiseFilename');
      expect(rb('a/b\\c:d')).toBe('a_b_c_d');
    });
  });

  test('resultBadgeHtml is the same in report-builder.html and run-detail.html', () => {
    for (const page of ['report-builder.html', 'run-detail.html']) {
      const badge = loadFunction(page, 'resultBadgeHtml');
      expect(badge('PASS')).toBe('<span class="a-pass">PASS</span>');
      expect(badge('FAIL')).toBe('<span class="a-fail">FAIL</span>');
      for (const other of ['SKIP', undefined, 'pass', '']) expect(badge(other)).toBe('<span style="color:#90a4ae">SKIP</span>');
    }
  });

  test('run-detail.html safeJsonForInlineScript breaks every closing script tag, whatever its case', () => {
    const safe = loadFunction('run-detail.html', 'safeJsonForInlineScript');
    expect(safe('{"a":"</script><SCRIPT>x</ScRiPt>"}')).toBe('{"a":"<\\/script><SCRIPT>x<\\/ScRiPt>"}');
    expect(safe('</div> and </ script>')).toBe('</div> and </ script>');
  });
});

// What #527 left as it was, with the reason. A later clean-up should not undo these.
describe('pages — written this way on purpose (#527)', () => {
  // CodeQL recognises replace(/x/g, …) as an HTML encoder. Rewritten with
  // replaceAll and a string it no longer did, and reported the escaped values
  // reaching innerHTML as XSS (see js/scenarios.js — esc, #526).
  // S11 consolidated every page's encoder into js/esc.js (its replace(/x/g) form
  // is pinned above). A page must no longer define its own encoder, and must not
  // reintroduce one in the replaceAll(string) shape CodeQL fails to recognise.
  test.each([
    ['admin.html'], ['compare.html'], ['report-builder.html'], ['run-detail.html'], ['welcome.html'], ['js/scenarios.js'], ['nav.js'], ['js/findings.js'],
  ])('%s has no inline HTML encoder of its own (shared from js/esc.js)', (page) => {
    const src = read(page);
    expect(src).not.toMatch(/\.replaceAll\(\s*['"][&<>"']['"]\s*,\s*'&(amp|lt|gt|quot|#39);'\)/);
    // the full 5-char replace-chain encoder only lives in js/esc.js now
    const encoderChain = /\.replace\(\/&\/g,\s*'&amp;'\)[\s\S]{0,120}\.replace\(\/'\/g,\s*'&#39;'\)/;
    expect(encoderChain.test(src)).toBe(false);
  });

  // The tab kind is the source of an open code-scanning alert on the innerHTML
  // a few lines below. Reading it through dataset could hide that flow from
  // CodeQL without fixing it.
  test('report-builder.html switchHttpTab reads the tab kind with getAttribute', () => {
    const src = read('report-builder.html');
    const start = src.indexOf('function switchHttpTab(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain("var kind = tabEl.getAttribute('data-http-tab');");
    expect(body).not.toContain('dataset.httpTab');
  });

  // Inside an inline script the closing tag has to be written with a backslash,
  // or the HTML parser ends the script there. Sonar reports it as a needless escape.
  test('run-detail.html writes the closing script tag of the payload with a backslash', () => {
    expect(read('run-detail.html')).toContain('${safeJsonForInlineScript(pretty)}<\\/script>`');
  });
});

// #594: the two return fields of Test Config. Their values are the data file
// schema's, the stored value is selected, and the input delegate stores both.
describe('Test Config return model and fulfillments (#594)', () => {
  const source = read('js/scenarios.js');
  const constant = (name) => vm.runInNewContext(`(${new RegExp(`^const ${name} = (\\[[\\s\\S]*?\\]);$`, 'm').exec(source)[1]})`);
  const schema = require('../../../Bruno_Collection/json_validator/datafile.schema.json');
  const criteria = JSON.stringify(schema).match(/"returnModel":\{[^}]*\}|"returnFulfillments":\{[^}]*\}/g).map((s) => JSON.parse(`{${s}}`));
  const enumOf = (field) => criteria.find((c) => c[field])[field].enum;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const optionValue = (v) => (v == null ? '' : v);
  const fwReturnModels = loadFunction('js/scenarios.js', 'fwReturnModels');
  const context = {
    esc, optionValue, fwReturnModels, wizData: null,
    returnFieldsLocked: loadFunction('js/scenarios.js', 'returnFieldsLocked'),
    returnModelChoices: loadFunction('js/scenarios.js', 'returnModelChoices'),
    returnModelUndeclared: loadFunction('js/scenarios.js', 'returnModelUndeclared', {
      fwReturnModels, scenarioReturnModel: loadFunction('js/scenarios.js', 'scenarioReturnModel'),
    }),
    RETURN_MODEL_OPTIONS: constant('RETURN_MODEL_OPTIONS'),
    RETURN_FULFILLMENT_OPTIONS: constant('RETURN_FULFILLMENT_OPTIONS'),
  };
  const render = loadFunction('js/scenarios.js', 'buildReturnModelFields', context);
  const withFramework = (framework, fn) => {
    context.wizData = { framework };
    try { return fn(); } finally { context.wizData = null; }
  };
  const optionValues = (html) => [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

  test('every option is a value the data file schema accepts', () => {
    for (const [value] of context.RETURN_MODEL_OPTIONS) expect(enumOf('returnModel')).toContain(value);
    for (const [value] of context.RETURN_FULFILLMENT_OPTIONS) expect(enumOf('returnFulfillments')).toContain(value);
  });

  test('the stored value is the selected option; nothing stored selects the default', () => {
    const selected = (html) => [...html.matchAll(/<option value="([^"]*)" selected>/g)].map((m) => m[1]);
    expect(selected(render(0, { returnModel: 'COMBINED', returnFulfillments: 'PER_DIRECTION' }))).toEqual(['COMBINED', 'PER_DIRECTION']);
    expect(selected(render(0, {}))).toEqual(['SEPARATE', '']);
    expect(selected(render(0, { returnModel: 'SEPARATE', returnFulfillments: null }))).toEqual(['SEPARATE', '']);
  });

  test('#619: the picker offers only the declared models', () => {
    const html = withFramework({ returnModels: ['COMBINED'] }, () => render(0, { returnOffsetDays: 2, returnModel: 'COMBINED' }));
    expect(optionValues(html).slice(0, 1)).toEqual(['COMBINED']);
    expect(html).not.toContain('not declared');
    expect(html).not.toContain(' disabled');
  });

  test("#619: a scenario's own model stays, marked, when it is not declared", () => {
    const html = withFramework({ returnModels: ['COMBINED'] }, () => render(0, { returnOffsetDays: 2 }));
    expect(optionValues(html).slice(0, 2)).toEqual(['SEPARATE', 'COMBINED']);
    expect(html).toContain('<option value="SEPARATE" selected>⚠ Separate directions');
    expect(html).toContain('This return model is not declared in the Test Framework');
  });

  test('#619: no model declared locks the fields of a scenario without a return, not of one with', () => {
    const none = withFramework({ returnModels: [] }, () => render(0, {}));
    expect(none.match(/" disabled>/g)).toHaveLength(2);
    const has = withFramework({ returnModels: [] }, () => render(0, { returnOffsetDays: 1 }));
    expect(has).not.toContain(' disabled');
  });

  test('#619: a framework from before the declaration restricts nothing', () => {
    const html = withFramework({ salesFlows: ['SALE'] }, () => render(0, { returnOffsetDays: 1 }));
    expect(optionValues(html).slice(0, 2)).toEqual(['SEPARATE', 'COMBINED']);
    expect(html).not.toContain('not declared');
  });

  test('#619: the framework editor flags COMBINED below OSDM 3.7', () => {
    const note = loadFunction('js/scenarios.js', 'returnModelVersionNote');
    expect(note({ osdmVersion: '3.6.0', returnModels: ['COMBINED'] })).toContain('needs OSDM 3.7 or later');
    expect(note({ osdmVersion: '3.6', returnModels: ['SEPARATE', 'COMBINED'] })).toContain('declares 3.6');
    expect(note({ osdmVersion: '3.7.0', returnModels: ['COMBINED'] })).toBe('');
    expect(note({ osdmVersion: '4.0', returnModels: ['COMBINED'] })).toBe('');
    expect(note({ osdmVersion: '3.6.0', returnModels: ['SEPARATE'] })).toBe('');
    expect(note({ osdmVersion: '3.6.0' })).toBe('');
  });

  test('#619: the framework editor stores the declaration and keeps the note current', () => {
    expect(source).toContain("case 'fw-return-model':\n      fwToggleSimplePill(el, 'returnModels', el.dataset.val); refreshReturnVersionNote(); saveFrameworkDebounced(); break;");
    expect(source).toContain("wizData.framework.osdmVersion = v;\n      refreshReturnVersionNote();");
    const fwModels = vm.runInNewContext(`(${/^const FW_RETURN_MODELS = (\[[\s\S]*?\]);$/m.exec(source)[1]})`);
    expect(fwModels.map(([v]) => v)).toEqual(context.RETURN_MODEL_OPTIONS.map(([v]) => v));
  });

  test('the input delegate stores both fields on the offer criteria', () => {
    expect(source).toContain("case 'set-offer-return-model':\n      setOfferField(Number.parseInt(el.dataset.idx), 'returnModel', el.value || null); break;");
    expect(source).toContain("case 'set-offer-return-fulfillments':\n      setOfferField(Number.parseInt(el.dataset.idx), 'returnFulfillments', el.value || null); break;");
  });
});

// #595: the per-fulfillment axis of a partial refund in Test Config.
describe('Test Config partial refund per fulfillment (#595)', () => {
  const source = read('js/scenarios.js');
  const ENUMS = vm.runInNewContext(`({ partialRefundByFulfillment: ['off', 'on'], partialRefundFulfillmentSelection: ['first', 'last', 'outbound', 'inbound'] })`);
  const isArmed = loadFunction('js/scenarios.js', 'isArmed');
  const buildSelect = (idx, field, label, options) => `[${field}:${options.join('|')}]`;
  const render = loadFunction('js/scenarios.js', 'buildRefundByFulfillmentFields', { ENUMS, isArmed, buildSelect });

  test('the ENUMS of the page are the ones the data file schema accepts', () => {
    const schema = require('../../../Bruno_Collection/json_validator/datafile.schema.json');
    const props = JSON.stringify(schema);
    expect(source).toContain("partialRefundFulfillmentSelection: ['first', 'last', 'outbound', 'inbound']");
    expect(props).toContain('"partialRefundFulfillmentSelection"');
    expect(props).toContain('"partialRefundByFulfillment"');
  });

  test('off: only the switch; on: the target, with outbound/inbound only for a return', () => {
    expect(render(0, { partialRefundByFulfillment: 'off' }, false)).not.toContain('partialRefundFulfillmentSelection');
    expect(render(0, { partialRefundByFulfillment: 'on' }, false)).toContain('[partialRefundFulfillmentSelection:first|last]');
    expect(render(0, { partialRefundByFulfillment: 'on', offerSearchCriteria: { returnOffsetDays: 2 } }, false))
      .toContain('[partialRefundFulfillmentSelection:first|last|outbound|inbound]');
    expect(render(0, { partialRefundByFulfillment: true }, true)).toContain('outbound|inbound');
  });

  test('on together with per-leg or per-passenger: says those are not used', () => {
    expect(render(0, { partialRefundByFulfillment: 'on', partialRefundByPax: 'on' }, false)).toContain('not used');
    expect(render(0, { partialRefundByFulfillment: 'off', partialRefundByPax: 'on' }, false)).not.toContain('not used');
  });
});

describe('#699 the maximum number of passengers in the Test Framework', () => {
  const fwMaxPassengers = loadFunction('js/scenarios.js', 'fwMaxPassengers');

  test('a whole number from 1 to 999; empty is "not declared"; anything else is refused', () => {
    expect(fwMaxPassengers('9')).toBe(9);
    expect(fwMaxPassengers(' 19 ')).toBe(19);
    expect(fwMaxPassengers('999')).toBe(999);
    expect(fwMaxPassengers('')).toBeNull();
    expect(fwMaxPassengers(undefined)).toBeNull();
    for (const bad of ['0', '1000', '-3', '2.5', 'ten', '1e2']) expect(fwMaxPassengers(bad)).toBeUndefined();
  });

  test('the field is labelled, and its change goes through fwMaxPassengers', () => {
    const src = read('js/scenarios.js');
    expect(src).toContain('<label class="fw-subsection-label" for="fw-max-passengers"');
    expect(src).toContain('id="fw-max-passengers"');
    expect(src).toMatch(/case 'fw-max-pax': \{\s*\/\/[^\n]*\n\s*const value = fwMaxPassengers\(el\.value\);/);
  });
});

describe('#704 the sales horizon in the Test Framework, and the departure date of a scenario', () => {
  const fwSalesHorizonDays = loadFunction('js/scenarios.js', 'fwSalesHorizonDays');

  test('a whole number of days from 1 to 1000; empty is "not declared"; anything else is refused', () => {
    expect(fwSalesHorizonDays('90')).toBe(90);
    expect(fwSalesHorizonDays(' 1 ')).toBe(1);
    expect(fwSalesHorizonDays('1000')).toBe(1000);
    expect(fwSalesHorizonDays('')).toBeNull();
    expect(fwSalesHorizonDays(undefined)).toBeNull();
    for (const bad of ['0', '1001', '-3', '2.5', 'ten', '1e2', '12345']) expect(fwSalesHorizonDays(bad)).toBeUndefined();
  });

  test('the fields are labelled or hinted, and their changes go through their checks', () => {
    const src = read('js/scenarios.js');
    expect(src).toContain('<label class="fw-subsection-label" for="fw-sales-horizon"');
    expect(src).toContain('id="fw-sales-horizon"');
    expect(src).toMatch(/case 'fw-sales-horizon': \{\s*\/\/[^\n]*\n\s*const value = fwSalesHorizonDays\(el\.value\);/);
    expect(src).toContain('data-action="set-scenario-departure-days"');
    expect(src).toMatch(/case 'set-scenario-departure-days': \{[\s\S]{0,400}n >= -366 && n <= 1000/);
    expect(src).toContain("departureExpectRejection:          ['off', 'on']");
  });
});

describe('#705 a passenger\'s age on the day of travel, in the passenger editor', () => {
  const paxAgeValue = loadFunction('js/scenarios.js', 'paxAgeValue');

  test('years 0 to 120, days -366 to 366; empty clears; anything else is refused', () => {
    expect(paxAgeValue('bornYearsBeforeTravel', '15')).toBe(15);
    expect(paxAgeValue('bornYearsBeforeTravel', ' 0 ')).toBe(0);
    expect(paxAgeValue('bornYearsBeforeTravel', '')).toBeNull();
    expect(paxAgeValue('bornDaysAfter', '-1')).toBe(-1);
    expect(paxAgeValue('bornDaysAfter', '366')).toBe(366);
    for (const bad of ['-1', '121', '2.5', 'x', '1e2']) expect(paxAgeValue('bornYearsBeforeTravel', bad)).toBeUndefined();
    for (const bad of ['367', '-367', '1.5']) expect(paxAgeValue('bornDaysAfter', bad)).toBeUndefined();
  });

  test('the fields are labelled, and their changes go through their checks', () => {
    const src = read('js/scenarios.js');
    expect(src.match(/data-action="set-pax-age"/g)).toHaveLength(2);
    expect(src).toContain('data-action="set-pax-expected-type"');
    // Handled before the change switch (Sonar S1479 caps its cases).
    expect(src).toContain("const action = el.dataset.action;\n  if (changePaxAge(action, el) || changePassengerUpdate(action, el) || changeFwList(action, el) || changeOfferOptionDiscovery(action, el) || changeFareAge(action, el) || changeOfferCombination(action, el) || changeCurrencies(action, el) || changeMandatoryReservationForm(action, el) || changeOsdmVersion(action, el) || changeExchange(action, el)) return;");
    const fn = src.slice(src.indexOf('function changePaxAge('), src.indexOf('function setPaxField('));
    expect(fn).toContain("PAX_EXPECTED_TYPES.has(el.value) ? el.value : null");
    expect(fn).toContain("const value = paxAgeValue(field, el.value);");
  });
});

describe('#709 the passenger update in the Test Framework', () => {
  test('a labelled checkbox, checked unless the framework says false, handled before the change switch', () => {
    const src = read('js/scenarios.js');
    expect(src).toContain('<label class="fw-subsection-label" for="fw-passenger-update"');
    expect(src).toContain(`<input type="checkbox" id="fw-passenger-update" data-action="fw-passenger-update" \${fw.passengerUpdate === false ? '' : 'checked'}>`);
    const fn = src.slice(src.indexOf('function changePassengerUpdate('), src.indexOf('function setPaxField('));
    expect(fn).toContain('if (el.checked) delete wizData.framework[key];');
    expect(fn).toContain('else wizData.framework[key] = false;');
    expect(src).not.toContain("case 'fw-passenger-update'");
  });

  test('#809 the purchaser after the booking: a labelled checkbox, set by the same handler', () => {
    const src = read('js/scenarios.js');
    expect(src).toContain('<label class="fw-subsection-label" for="fw-purchaser-after-booking"');
    expect(src).toContain(`<input type="checkbox" id="fw-purchaser-after-booking" data-action="fw-purchaser-after-booking" \${fw.purchaserAfterBooking === false ? '' : 'checked'}>`);
    expect(src).toContain("const FW_STEP_FLAGS = { 'fw-passenger-update': 'passengerUpdate', 'fw-purchaser-after-booking': 'purchaserAfterBooking' };");
    const vm = require('node:vm');
    const ctx = { wizData: { framework: {} }, saves: 0 };
    ctx.saveFrameworkDebounced = () => { ctx.saves += 1; };
    vm.createContext(ctx);
    const flags = src.split('\n').find((l) => l.startsWith('const FW_STEP_FLAGS'));
    vm.runInContext(`${flags}\n${src.slice(src.indexOf('function changePassengerUpdate('), src.indexOf('function setPaxField('))}\nthis.change = changePassengerUpdate;`, ctx);
    expect(ctx.change('fw-purchaser-after-booking', { checked: false })).toBe(true);
    expect(ctx.wizData.framework).toEqual({ purchaserAfterBooking: false });
    ctx.change('fw-passenger-update', { checked: false });
    ctx.change('fw-purchaser-after-booking', { checked: true });
    expect(ctx.wizData.framework).toEqual({ passengerUpdate: false });
    expect(ctx.change('toString', { checked: false })).toBe(false);
    expect(ctx.saves).toBe(3);
  });
});

describe('#730 Find journeys says when it searched, with what, and why it found nothing', () => {
  const summary = loadFunction('js/scenarios.js', 'journeyFinderSummary', {
    journeyFinderEmptyReasons: loadFunction('js/scenarios.js', 'journeyFinderEmptyReasons'),
  });
  const q = { origin: 'urn:uic:stn:8101081', destination: 'urn:uic:stn:8001071', maxLegs: 3, minTransfer: 5, maxWait: 180, at: '14:05:12' };
  const plan = (stats, extra = {}) => ({ journeys: [], total: 0, truncated: false, stats, ...extra });
  const first = 'Searched at 14:05:12: urn:uic:stn:8101081 → urn:uic:stn:8001071, 2 or 3 legs, transfer 5–180 min.';

  test('every answer starts with the time and the search', () => {
    expect(summary(plan({ services: 1, trainSets: 1, fromOrigin: 1, toDestination: 1 }), q)[0]).toBe(first);
    expect(summary(plan({}), { ...q, maxLegs: 2 })[0]).toContain(', 2 legs,');
    expect(summary({ journeys: [], error: 'Give an origin and a destination.' }, q)).toEqual([first, 'Give an origin and a destination.']);
  });

  test('journeys found', () => {
    const found = { journeys: [{}, {}], total: 7, truncated: true, stats: {} };
    expect(summary(found, q)).toEqual([first, '7 journey(s) found (the 2 shortest of 7).', 'The search stopped early: some journeys may be missing.']);
  });

  test('nothing found: the reason', () => {
    expect(summary(plan({ services: 0, unsavedTrainSets: 2 }), q).slice(1)).toEqual([
      'No journey found: Test Data has no saved train set with timed services.',
      '2 train set(s) not saved yet were not used: click Save Train first.',
    ]);
    const lines = summary(plan({ services: 12, trainSets: 3, fromOrigin: 0, toDestination: 0 }), q).slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('No journey found: no train service leaves urn:uic:stn:8101081 among the 12 services of 3 saved train set(s). A train set from a nearby station has another stop place code.');
    expect(lines[1]).toContain('no train service reaches urn:uic:stn:8001071');
    expect(summary(plan({ services: 12, trainSets: 3, fromOrigin: 4, toDestination: 2 }), q)[1])
      .toBe('No journey found: 4 service(s) leave the origin and 2 reach the destination, but none connect within the transfer limits. Add the trains in between, or allow a longer wait.');
  });
});

describe('#733 the place lookup offers Test Data stop places first', () => {
  const planner = require('../../public/js/journey-planner.js');
  const esc = require('../../public/js/esc.js').esc;
  const merge = loadFunction('js/scenarios.js', 'mergePlaceLookups', { OscarJourneyPlanner: planner });
  const item = loadFunction('js/scenarios.js', 'placeLookupItemHtml', { esc });
  const failure = loadFunction('js/scenarios.js', 'placesDownloadFailure');

  test('Test Data places first, cached ones not already listed after, at most the limit', () => {
    const local = [{ id: 'urn:uic:stn:8101003', name: 'Wien Hbf', trainSets: ['a'], fromTestData: true }];
    const cached = [{ id: 'urn:uic:stn:008101003', name: 'Wien Hbf' }, { id: 'urn:uic:stn:8101081', name: 'Wien Meidling' }, null];
    expect(merge(local, cached).map((p) => p.id)).toEqual(['urn:uic:stn:8101003', 'urn:uic:stn:8101081']);
    expect(merge(local, cached, 1)).toHaveLength(1);
  });

  test('a Test Data row shows its train sets; a nameless one shows its code; text is escaped', () => {
    const html = item({ id: 'urn:uic:stn:1', name: '', trainSets: ['A<b>', 'B', 'C'], fromTestData: true }, 0, true);
    expect(html).toContain('Test Data · A&lt;b&gt;, B +1');
    expect(html).toContain('<div style="color:#263238">urn:uic:stn:1</div>');
    expect(html).toContain('background:#e8f4fb');
    expect(item({ id: 'u', name: 'N' }, 1, false)).not.toContain('Test Data');
  });

  test('a provider without GET /places is told apart from a failure', () => {
    expect(failure({ vendor_status: 501, detail: 'x' }, 502)).toBe('The provider does not offer the list of stop places (GET /places answered HTTP 501). The origin/destination lookup offers the stop places of your Test Data instead.');
    expect(failure({ vendor_status: 500, detail: 'GET /places returned HTTP 500' }, 502)).toBe('Places download failed: GET /places returned HTTP 500');
    expect(failure({}, 400)).toBe('Places download failed: HTTP 400');
  });
});

describe('js/scenarios.js — the Distribution section (#936)', () => {
  const page = 'js/scenarios.js';
  const escHtml = require('../../public/js/esc.js').esc;
  const lines = read(page).split('\n');
  const start = lines.indexOf('const FW_DISTRIBUTION_MODES = [');
  const FW_DISTRIBUTION_MODES = vm.runInNewContext(
    lines.slice(start, lines.indexOf('];', start) + 1).join('\n').replace('const FW_DISTRIBUTION_MODES = ', ''));
  const fwDistributionModes = loadFunction(page, 'fwDistributionModes', { FW_DISTRIBUTION_MODES });
  const toggledDistributionModes = loadFunction(page, 'toggledDistributionModes', { FW_DISTRIBUTION_MODES, fwDistributionModes });

  test('the page\'s modes are the server\'s', () => {
    const { DISTRIBUTION_MODES } = require('../../src/utils/distributionModes');
    expect(FW_DISTRIBUTION_MODES.map(([mode]) => mode)).toEqual([...DISTRIBUTION_MODES]);
  });

  test('nothing declared reads as product only, as on the server', () => {
    const { declaredDistributionModes } = require('../../src/utils/distributionModes');
    for (const fw of [{}, { distributionModes: [] }, { distributionModes: ['FARE', 'PRODUCT'] }, { distributionModes: ['X'] }, null]) {
      expect(fwDistributionModes(fw)).toEqual(declaredDistributionModes(fw));
    }
  });

  test('a click adds or removes a mode, in order, and never leaves none', () => {
    expect(toggledDistributionModes({}, 'FARE')).toEqual(['PRODUCT', 'FARE']);
    expect(toggledDistributionModes({ distributionModes: ['FARE'] }, 'PRODUCT')).toEqual(['PRODUCT', 'FARE']);
    expect(toggledDistributionModes({ distributionModes: ['PRODUCT', 'FARE'] }, 'PRODUCT')).toEqual(['FARE']);
    expect(toggledDistributionModes({}, 'PRODUCT')).toBeNull();
    expect(toggledDistributionModes({ distributionModes: ['FARE'] }, 'FARE')).toBeNull();
  });

  test('the section: one option per mode, selected when declared', () => {
    const panel = loadFunction(page, 'distributionPanelHtml', { FW_DISTRIBUTION_MODES, fwDistributionModes, esc: escHtml, faresPanelHtml: () => '' });
    const html = panel({});
    expect(html).toContain('🧭 Distribution');
    expect(html).toContain('class="aftersales-opt selected" data-action="fw-distribution-mode" data-val="PRODUCT"');
    expect(html).toContain('class="aftersales-opt" data-action="fw-distribution-mode" data-val="FARE"');
    expect(panel({ distributionModes: ['PRODUCT', 'FARE'] }).match(/aftersales-opt selected/g)).toHaveLength(2);
  });

  test('a click on the last mode changes nothing and says why; another is saved', () => {
    const saved = [];
    const note = { textContent: '' };
    const options = ['PRODUCT', 'FARE'].map((val) => ({ dataset: { val }, cls: new Set(), classList: { toggle(c, on) { if (on) this.owner.cls.add(c); else this.owner.cls.delete(c); } } }));
    for (const o of options) o.classList.owner = o;
    const wizData = { framework: {} };
    const document = { getElementById: () => note, querySelectorAll: () => options };
    const click = loadFunction(page, 'clickDistributionMode', { wizData, document, toggledDistributionModes, saveFrameworkDebounced: () => saved.push(1) });
    expect(click('fw-pill', options[0])).toBe(false);
    expect(click('fw-distribution-mode', options[0])).toBe(true);
    expect(wizData.framework.distributionModes).toBeUndefined();
    expect(note.textContent).toContain('at least one mode');
    expect(saved).toHaveLength(0);
    expect(click('fw-distribution-mode', options[1])).toBe(true);
    expect(wizData.framework.distributionModes).toEqual(['PRODUCT', 'FARE']);
    expect([...options[1].cls]).toEqual(['selected']);
    expect(note.textContent).toBe('');
    expect(saved).toHaveLength(1);
  });

  test('the click is handled before the click switch, and the section is drawn after the OSDM version', () => {
    const source = read(page);
    expect(source).toContain('if (clickDistributionMode(action, el)) return;');
    expect(source.indexOf('${distributionPanelHtml(fw)}')).toBeGreaterThan(source.indexOf('data-action="wiz-osdm-version"'));
  });
});

describe('js/scenarios.js — the Fares panel (#937)', () => {
  const page = 'js/scenarios.js';
  const escHtml = require('../../public/js/esc.js').esc;
  const lines = read(page).split('\n');
  const constant = (name) => {
    const start = lines.indexOf(`const ${name} = {`);
    return vm.runInNewContext(`(${lines.slice(start, lines.indexOf('};', start) + 1).join('\n').replace(`const ${name} = `, '').replace(/;$/, '')})`);
  };
  const FW_FARE_LISTS = constant('FW_FARE_LISTS');
  const FW_FARE_LABELS = constant('FW_FARE_LABELS');
  const FW_FARE_MAX_FREE_AGE = 30;
  const fares = require('../../src/utils/fareDeclarations');
  const fwFareList = loadFunction(page, 'fwFareList', { FW_FARE_LISTS });
  const toggledFareList = loadFunction(page, 'toggledFareList', { FW_FARE_LISTS, fwFareList });
  const fareAgeOf = loadFunction(page, 'fareAgeOf', { FW_FARE_MAX_FREE_AGE });

  test('the page\'s lists and age limit are the server\'s', () => {
    expect(FW_FARE_LISTS.clusters.values).toEqual([...fares.FARE_CLUSTERS]);
    expect(FW_FARE_LISTS.combinationModels.values).toEqual([...fares.COMBINATION_MODELS]);
    expect(FW_FARE_LISTS.reservations.values).toEqual([...fares.FARE_RESERVATIONS]);
    expect(FW_FARE_LISTS.salesFlows.values).toEqual([...fares.FARE_SALES_FLOWS]);
    expect(Object.keys(FW_FARE_LISTS).every((k) => fares.FARE_KEYS.includes(k))).toBe(true);
    expect(read(page)).toContain(`const FW_FARE_MAX_FREE_AGE = ${fares.MAX_FREE_UNDER_AGE};`);
  });

  test('a list absent reads as on the server', () => {
    expect(fwFareList({}, 'clusters')).toEqual(fares.declaredFareClusters({}));
    expect(fwFareList({}, 'reservations')).toEqual([]);
    expect(fwFareList({}, 'salesFlows')).toEqual(['SALE']);
    expect(fwFareList({ fares: { combinationModels: ['COMBINING'] } }, 'combinationModels')).toEqual(['COMBINING']);
  });

  test('a click adds or removes a value, in order; SALE stays', () => {
    expect(toggledFareList({}, 'clusters', 'PROMO')).toEqual(['BUSINESS', 'FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX']);
    expect(toggledFareList({ fares: { clusters: ['NON_FLEX'] } }, 'clusters', 'FULL_FLEX')).toEqual(['FULL_FLEX', 'NON_FLEX']);
    expect(toggledFareList({}, 'salesFlows', 'REFUND_FULL')).toEqual(['SALE', 'REFUND_FULL']);
    expect(toggledFareList({}, 'salesFlows', 'SALE')).toEqual(['SALE']);
    for (const key of Object.keys(FW_FARE_LISTS)) {
      const fw = { fares: { [key]: toggledFareList({}, key, FW_FARE_LISTS[key].values[1] || FW_FARE_LISTS[key].values[0]) } };
      expect(fares.fareDeclarationsProblem(fw.fares)).toBeNull();
    }
  });

  test('the free age keeps a whole number 1 to 30 only', () => {
    expect(fareAgeOf('6')).toBe(6);
    expect(fareAgeOf(' 12 ')).toBe(12);
    for (const bad of ['', '0', '31', '6.5', '-1', 'x', null]) expect(fareAgeOf(bad)).toBeNull();
    expect(fares.fareDeclarationsProblem({ freeUnderAge: fareAgeOf('6') })).toBeNull();
  });

  test('the panel is hidden unless FARE is declared, and shows what is declared', () => {
    const fwDistributionModes = loadFunction(page, 'fwDistributionModes', { FW_DISTRIBUTION_MODES: [['PRODUCT'], ['FARE']] });
    const panel = loadFunction(page, 'faresPanelHtml', { FW_FARE_LISTS, FW_FARE_LABELS, FW_FARE_MAX_FREE_AGE, fwFareList, fwDistributionModes, esc: escHtml });
    expect(panel({})).toContain('id="fw-fares-panel" style="margin-top:10px;border-top:1px solid #e0e0e0;padding-top:8px" hidden');
    const html = panel({ distributionModes: ['FARE'], fares: { clusters: ['NON_FLEX'], statedRefundFee: true, freeUnderAge: 6 } });
    expect(html).not.toContain(' hidden>');
    expect(html).toContain('class="pill selected" data-action="fw-fare-pill" data-key="clusters" data-val="NON_FLEX"');
    expect(html).toContain('class="pill" data-action="fw-fare-pill" data-key="clusters" data-val="PROMO"');
    expect(html).toContain('class="pill selected" data-action="fw-fare-fee"');
    expect(html).toContain('value="6"');
    expect(html).toContain('<label for="fw-fare-free-age">');
  });

  test('a click and the age are saved, handled before their switches', () => {
    const saved = [];
    const opt = { dataset: { key: 'clusters', val: 'PROMO' }, classList: { toggle() {} } };
    const wizData = { framework: {} };
    const document = { querySelectorAll: () => [opt] };
    const click = loadFunction(page, 'clickFarePanel', { wizData, document, FW_FARE_LISTS, toggledFareList, saveFrameworkDebounced: () => saved.push(1) });
    expect(click('fw-pill', opt)).toBe(false);
    expect(click('fw-fare-pill', opt)).toBe(true);
    expect(wizData.framework.fares.clusters).toEqual(['BUSINESS', 'FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX']);
    expect(click('fw-fare-fee', { classList: { toggle() {} } })).toBe(true);
    expect(wizData.framework.fares.statedRefundFee).toBe(true);
    const change = loadFunction(page, 'changeFareAge', { wizData, fareAgeOf, saveFrameworkDebounced: () => saved.push(1) });
    const input = { value: '7' };
    expect(change('fw-fare-free-age', input)).toBe(true);
    expect(wizData.framework.fares.freeUnderAge).toBe(7);
    input.value = 'x';
    change('fw-fare-free-age', input);
    expect(wizData.framework.fares.freeUnderAge).toBeUndefined();
    expect(input.value).toBe('');
    expect(saved).toHaveLength(4);
    const source = read(page);
    expect(source).toContain('if (clickFarePanel(action, el)) return;');
    expect(source).toContain('changeFareAge(action, el) ||');
    expect(source).toContain('${faresPanelHtml(fw)}');
  });
});

// #227 part 2: the offer request options settings in the Test Framework editor.
describe('the offer request options settings', () => {
  const run = (value, action, stored) => {
    const wizData = { framework: stored === undefined ? {} : { offerOptionDiscovery: stored } };
    let saved = 0;
    const applyOfferOptionCeiling = loadFunction('js/scenarios.js', 'applyOfferOptionCeiling');
    const change = loadFunction('js/scenarios.js', 'changeOfferOptionDiscovery', { wizData, applyOfferOptionCeiling, saveFrameworkDebounced: () => { saved += 1; } });
    const el = { value };
    const handled = change(action, el);
    return { handled, fw: wizData.framework, saved, el };
  };

  test('the ceiling is kept from 3 to 200, an empty field removes it, anything else is put back', () => {
    expect(run('40', 'fw-option-max-requests').fw).toEqual({ offerOptionDiscovery: { maxRequests: 40 } });
    expect(run('', 'fw-option-max-requests', { maxRequests: 40 }).fw).toEqual({});
    const wrong = run('2', 'fw-option-max-requests', { maxRequests: 40 });
    expect(wrong).toMatchObject({ handled: true, saved: 0, fw: { offerOptionDiscovery: { maxRequests: 40 } } });
    expect(wrong.el.value).toBe(40);
    expect(run('7.5', 'fw-option-max-requests').fw).toEqual({});
    expect(run('201', 'fw-option-max-requests').handled).toBe(true);
  });

  test('made-up values are the default; skip is stored', () => {
    expect(run('skip', 'fw-option-invalid-values').fw).toEqual({ offerOptionDiscovery: { invalidValues: 'skip' } });
    expect(run('random', 'fw-option-invalid-values', { invalidValues: 'skip', maxRequests: 9 }).fw).toEqual({ offerOptionDiscovery: { maxRequests: 9 } });
    expect(run('x', 'fw-other').handled).toBe(false);
  });

  test('the section draws both settings and both code lists', () => {
    const FW_LISTS = { corporate: { key: 'corporateCodes' }, promotion: { key: 'promotionCodes' } };
    const fwListHtml = (list) => `<list ${FW_LISTS[list].key}>`;
    const html = loadFunction('js/scenarios.js', 'fwOfferOptionsHtml', { fwListHtml })({ offerOptionDiscovery: { maxRequests: 12, invalidValues: 'skip' } });
    expect(html).toContain('value="12"');
    expect(html).toContain('<option value="skip" selected>');
    expect(html).toContain('<list corporateCodes>');
    expect(html).toContain('<list promotionCodes>');
  });
});

// #227 part 3: the Report Builder's offer request options section.
describe('the Report Builder offer request options section', () => {
  const page = 'report-builder.html';
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
  const OFFER_OPTION_RESULTS = { honoured: 'Supported, kept to', error: 'Error' };
  const offerOptionResultLabel = loadFunction(page, 'offerOptionResultLabel', { OFFER_OPTION_RESULTS });
  const offerOptionDeclaredLabel = loadFunction(page, 'offerOptionDeclaredLabel');
  const html = loadFunction(page, 'offerOptionRunHtml', { escHtml, offerOptionResultLabel, offerOptionDeclaredLabel });

  test('every text of the report is escaped, and results and declarations are named', () => {
    const out = html({
      scenario_code: 'SIM_<b>',
      report: {
        version: '3.8.0', used: 5, budget: 30, seed: 7, mandatory: { ok: false, message: '<i>none</i>' },
        options: [{ option: 'embed<x>', value: '"v"', source: 'random', status: 500, result: 'error', declared: true, message: '<script>' }],
        combinations: [{ options: ['a', 'b'], status: 200, result: 'honoured' }],
        all: { count: 2, status: 200, result: 'toString' },
      },
    });
    for (const tag of ['<b>', '<i>', '<x>', '<script>']) expect(out.includes(tag)).toBe(false);
    expect(out).toContain('NOT answered — &#60;i&#62;');
    expect(out).toContain('<td>Error</td><td>Declared</td>');
    expect(out).toContain('a + b: HTTP 200, Supported, kept to');
    expect(out).toContain('Every supported option (2): HTTP 200, toString');
    expect(offerOptionDeclaredLabel(false)).toBe('Declared not supported');
    expect(offerOptionDeclaredLabel(undefined)).toBe('');
  });

  test('the section is drawn after the capability matrix and exported to the CSV', () => {
    const source = read(page);
    expect(source).toContain('renderOfferOptions(reportData.offer_options || []);');
    expect(source).toContain("['--- OFFER REQUEST OPTIONS ---'],");
  });
});

// #956 parts 2 and 3: the Report Builder's Test Framework coverage section.
describe('the Report Builder coverage section', () => {
  const page = 'report-builder.html';
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
  // A top-level `const NAME = { … };` of the page, evaluated.
  const loadConst = (name) => {
    const lines = read(page).split('\n');
    const start = lines.findIndex((l) => l.startsWith(`const ${name} = {`));
    const end = lines.findIndex((l, i) => i > start && l === '};');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n').replace(`const ${name} = `, '').replace(/;$/, '')})`);
  };
  const COVERAGE_STATES = loadConst('COVERAGE_STATES');
  const COVERAGE_DECLARATIONS = loadConst('COVERAGE_DECLARATIONS');
  const CAPABILITY_RESULTS = loadConst('CAPABILITY_RESULTS');
  const POINT_KINDS = loadConst('POINT_KINDS');
  const CHANGE_LABELS = loadConst('CHANGE_LABELS');
  // Every function of the section (up to coverageTitle(), which reads the
  // page), lifted into one context so that each finds the others.
  const sectionNames = (() => {
    const src = read(page);
    const from = src.indexOf('/* ── Test Framework coverage (#956)');
    const to = src.indexOf('\nfunction coverageTitle(');
    return [...src.slice(from, to).matchAll(/^function (\w+)\(/gm)].map((m) => m[1]);
  })();
  const ctx = { escHtml, encodeURIComponent, COVERAGE_STATES, COVERAGE_DECLARATIONS, CAPABILITY_RESULTS, POINT_KINDS, CHANGE_LABELS };
  for (const name of sectionNames) ctx[name] = loadFunction(page, name, ctx);
  const { coverageRunIdOf, coverageFailedHtml, coverageHtml, mdCell, coverageMarkdown, capabilityHtml, capabilityPointLinks,
    capabilityPointRows, toggleCoveragePoint, publishedListHtml, comparisonHtml, publishedHtml, capabilityPointsHtml, capabilitySentence,
    capabilityOptionsHtml, capabilityCombinationText, capabilityRefusalFormsHtml, capabilityPointHtml, capabilityPositionText, capabilityPositionChoices,
    capabilityPositionButtonHtml, capabilityPositionFormHtml, capabilityPointLine, coverageFilePrefix, coverageFileName, downloadFileName } = ctx;

  const answer = {
    days: 30, framework: true, datafile: true,
    summary: { declared: 2, covered: 1, passed: 0, failed: 1, neverRun: 0, notCovered: 1, toRunAgain: 1, latestRunAt: '2026-10-24 10:05:00' },
    functions: [
      { id: 'salesFlow:SALE', group: 'Sales <flows>', label: 'Sale | <b>', state: 'failed', toRunAgain: true,
        scenarios: [{ code: 'S_<i>', result: 'failed', toRunAgain: true, run: { passed: 7, failed: 3, at: '2026-10-24' } }],
        findings: [{ title: 'Refused\nby <x>', category: 'provider_deviation', status: 'open', scenarioCode: 'S_<i>' }] },
      { id: 'salesFlow:REFUND_FULL', group: 'Sales <flows>', label: 'Full refund', state: 'not-covered', toRunAgain: false, scenarios: [], findings: [] },
    ],
    matrix: [
      { flow: 'SALE', flowLabel: 'Sale <s>', group: 'Whole flow', label: 'Sale (every scenario)', result: 'failed', declaration: 'declared', toRunAgain: true,
        counts: { scenarios: 2, passed: 1, withDefects: 0, failed: 1, neverRun: 0 }, scenarios: ['S_<i>', 'T'],
        failedScenarios: [{ code: 'S_<i>', result: 'failed', runId: '0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b', step: '02. POST <b>', check: 'Status <x>' },
          { code: 'T', result: 'defects', runId: 'not-a-uuid"><script>' }], findings: [{ title: 'F <z>', category: 'open', status: 'open' }] },
      { flow: 'SALE', flowLabel: 'Sale <s>', group: 'Currencies', label: 'PLN <c>', result: 'not-declared', declaration: 'not-declared', toRunAgain: false,
        counts: { scenarios: 1, passed: 1, failed: 0, neverRun: 0 }, scenarios: ['T'], findings: [] },
      { flow: 'REFUND_FULL', flowLabel: 'Full refund', group: 'Whole flow', label: 'Full refund (every scenario)', result: 'passed', providerNotSupported: 1, declaration: 'every-value',
        counts: { scenarios: 1, passed: 1, failed: 0, neverRun: 0 }, scenarios: ['R'], findings: [] },
    ],
    notDeclared: [{ code: 'X<y>', warnings: ['currency:PLN'] }],
  };

  test('the results are the server\'s, named alike', () => {
    const { RESULT_TEXT } = require('../../src/utils/coverageMatrix');
    const { DECLARATION_TEXT } = require('../../src/utils/coverageWorkbook');
    expect({ ...COVERAGE_STATES }).toEqual({ ...RESULT_TEXT });
    expect({ ...COVERAGE_DECLARATIONS }).toEqual({ ...DECLARATION_TEXT });
  });

  test('by flow and element: the flow in the first column once, every text escaped', () => {
    const out = coverageHtml(answer, 'matrix');
    for (const tag of ['<b>', '<i>', '<s>', '<c>', '<z>', '<y>']) expect(out.includes(tag)).toBe(false);
    expect(out.split('Sale &#60;s&#62;').length).toBe(2);
    expect(out).toContain('<th>Flow</th><th>Element tested</th><th>Result</th><th>Test Framework</th>');
    expect(out).toContain('cov-not-declared">Not supported (not declared)');
    expect(out).toContain('cov-passed">Passed</span><br><small class="cov-provider">the provider says &#34;not supported&#34; in 1 scenario(s)</small>');
    expect(out).toContain('<td>Every value declared</td>');
    expect(out).toContain('1 of 2 scenario(s) passed (0 with defects, 1 failed, 0 never run)<ul class="cov-list cov-failed-list">'
      + '<li><a href="/run-detail.html?id=0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b">S_&#60;i&#62;</a>: <strong>Failed</strong> at 02. POST &#60;b&#62; — Status &#60;x&#62;</li>'
      + '<li>T: <strong>Passed with defects</strong></li></ul><details><summary>Scenarios</summary>');
    expect(coverageRunIdOf('javascript:alert(1)')).toBe('');
    expect(coverageFailedHtml([])).toBe('');
  });

  test('by function: every text escaped; a group heads its rows once', () => {
    const out = coverageHtml(answer, 'functions');
    for (const tag of ['<b>', '<i>', '<x>', '<y>', '<flows>']) expect(out.includes(tag)).toBe(false);
    expect(out.split('Sales &#60;flows&#62;').length).toBe(2);
    expect(out).toContain('S_&#60;i&#62;: Failed (7 passed, 3 failed, 2026-10-24), to run again');
    expect(out).toContain('cov-not-covered">No scenario');
    expect(out).toContain('2 function(s) declared');
    expect(out).toContain('runs of the last 30 day(s), latest run 2026-10-24 10:05:00.');
    expect(coverageHtml({ ...answer, framework: false, datafile: false, functions: [], matrix: [], notDeclared: [] }, 'functions')).toContain('No data file is stored');
  });

  test('the Markdown keeps one row per element and per function, whatever the texts hold', () => {
    const md = coverageMarkdown(answer, 'Gamma | test');
    expect(md.startsWith('# Test Framework coverage — Gamma \\| test\n')).toBe(true);
    expect(md).toContain('| Sale \\<s> | Currencies: PLN \\<c> | Not supported (not declared) | Not declared | 1 of 1 scenario(s) passed (0 with defects, 0 failed, 0 never run) |  |');
    expect(md).toContain('S_\\<i> (Failed at 02. POST \\<b>); T (Passed with defects)');
    expect(md).toContain('| Sale \\| \\<b> | Failed, to run again | S_\\<i>: Failed (7 passed, 3 failed, 2026-10-24), to run again | Refused by \\<x> (provider_deviation, open, S_\\<i>) |');
    expect(md).toContain('| Full refund | No scenario |  |  |');
    expect(md).toContain('- X\\<y>: currency:PLN');
    expect(md).not.toContain('\n\n\n');
    expect(md.match(/^### Sales/gm)).toHaveLength(1);
    expect(mdCell(null)).toBe('');
    expect(mdCell('a\r\nb\rc')).toBe('a b c');
    expect(mdCell('a\\|b')).toBe('a\\\\\\|b');
  });

  test('the server modules\' own answer draws: every state and every run', () => {
    const C = require('../../src/utils/frameworkCoverage');
    const M = require('../../src/utils/coverageMatrix');
    const input = {
      framework: { salesFlows: ['SALE', 'REFUND_FULL'] },
      datafile: { scenarios: [{ code: 'A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 }],
        tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: {} }], passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }] },
      runs: { A: { id: 'r', status: 'COMPLETED', queued_at: '2026-10-24 10:00:00', completed_at: '2026-10-24 10:05:00', total: 4, failed: 0 } },
    };
    const report = { days: 365, framework: true, datafile: true, ...C.coverageOf(input), ...M.coverageMatrixOf(input) };
    const byFunction = coverageHtml(report, 'functions');
    expect(byFunction).toContain('A: Passed (4 passed, 0 failed, 2026-10-24 10:05:00)');
    expect(byFunction).toContain('No scenario');
    const byElement = coverageHtml(report, 'matrix');
    expect(byElement).toContain('<td><strong>Sale</strong></td><td><small class="cov-group">Whole flow</small><br>Sale (every scenario)</td><td><span class="cov-state cov-passed">Passed</span>');
    expect(byElement).toContain('Passenger types</small><br>Adult');
    expect(coverageMarkdown(report, 'P')).toContain('### Sales flows');
  });

  test('the card is shown to members only, asks the coverage routes, and draws the view chosen', () => {
    const source = read(page);
    expect(source).toContain("if (!isPlatformUser) {\n  document.getElementById('coverage-card').style.display = 'block';");
    expect(source).toContain("fetch('/v1/company/coverage?days=' + encodeURIComponent(");
    expect(source).toContain("fetch('/v1/company/coverage/download?days=' + encodeURIComponent(");
    expect(source).toContain("body.innerHTML = coverageHtml(data, document.getElementById('coverage-view').value);");
    expect(source).toContain('<option value="capabilities" selected>By capability</option><option value="matrix">By flow and element</option>');
  });

  // #972 part 3: the coverage by capability.
  const UUID = '0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
  const byCapability = {
    summary: { tested: 2, passed: 0, deviation: 1, points: 1, blocked: 0, notSupported: 0, notTested: 1, outOfScope: 0,
      expectedRefusals: { total: 1, refused: 0, deviation: 0, notRefused: 1, notRun: 0 },
      pointsToLookAt: { total: 2, provider: 1, accepted: 0, questions: 0, oscar: 1, truncated: false }, declaredWithoutScenario: 1, apart: 1 },
    capabilities: [
      { id: 'sale', group: 'Sale <g>', label: 'Sale <l>', optional: false, result: 'points', declaration: 'declared',
        tests: [{ key: 'K', entry: 'OTST_<e>', purpose: 'P <p>', result: 'points', forms: [
          { code: 'C_<1>', form: 'SEARCH', result: 'points', runId: UUID, step: '02. <s>', check: 'X <c>', toRunAgain: true },
          { code: 'C2', form: 'TRIP_IDS', result: 'not-run', toRunAgain: null }] }],
        provenBy: { count: 3, codes: ['A'] }, sideProblems: [{ code: 'Z<z>', result: 'points' }], points: [1, 'x', 2.5] },
      { id: 'fulfilment.documents', group: 'Sale <g>', label: 'Documents', optional: true, result: 'deviation', declaration: null,
        tests: [], provenBy: { count: 1, codes: ['A'] }, sideProblems: [], points: [] },
    ],
    expectedRefusals: [{ key: 'NHF_<r>', entry: null, purpose: 'Must <refuse>', capability: 'refund.full', capabilityLabel: 'Full <refund>',
      result: 'not-refused', forms: [{ code: 'NHF_<r>', result: 'not-refused', runId: 'bad"><x>' }], points: [2] }],
    points: [
      { number: 1, kind: 'provider', source: 'check', capability: 'sale', capabilityLabel: 'Sale <l>', step: '02. <s>', steps: ['02. <s>', '05. <t>'],
        check: 'X <c>', status: 500, problemCode: 'P<q>', blocking: true, occurrences: 2, tests: [{ key: 'K', entry: 'OTST_<e>', codes: ['C_<1>'] }],
        runs: [{ runId: UUID, code: 'C_<1>' }, { runId: 'nope', code: 'C2' }], firstSeen: '2026-10-20', lastSeen: '2026-10-26',
        observed: { text: 'Got <n> instead', at: '2026-10-26', code: 'C_<1>' },
        finding: { id: 'f', title: 'T <f>', category: 'provider_deviation', status: 'open' }, possibleFinding: null, expectedRefusal: false },
      { number: 2, kind: 'oscar', source: 'check', capability: 'refund.full', capabilityLabel: 'Full <refund>', step: '14. <u>', steps: ['14. <u>'],
        check: '[OSCAR request] <o>', status: 200, problemCode: null, blocking: false, occurrences: 1, tests: [{ key: 'NHF_<r>', entry: null, codes: ['NHF_<r>'] }],
        runs: [], firstSeen: '2026-10-21', lastSeen: '2026-10-21', finding: null,
        possibleFinding: { id: 'g', title: 'Maybe <m>', category: 'open', status: 'open' }, expectedRefusal: true },
    ],
    apart: [{ code: 'A_2', entry: 'A' }], notTested: [{ id: 'x', group: 'Cards', label: 'Card <k>', state: 'not-covered' }],
  };
  const TAGS = ['<g>', '<l>', '<e>', '<p>', '<1>', '<s>', '<c>', '<z>', '<r>', '<refuse>', '<refund>', '<x>', '<t>', '<q>', '<f>', '<m>', '<k>', '<u>', '<o>', '<n>'];

  test('the results and kinds are the server\'s, named alike', () => {
    const { RESULT_TEXT } = require('../../src/utils/capabilityCoverage');
    const { KIND_ORDER } = require('../../src/utils/coveragePoints');
    expect({ ...CAPABILITY_RESULTS }).toEqual({ ...RESULT_TEXT });
    expect(Object.keys(POINT_KINDS)).toEqual([...KIND_ORDER]);
  });

  test('by capability: the rows, the refusals and the numbered points, every text escaped', () => {
    const out = coverageHtml({ ...answer, byCapability }, 'capabilities');
    for (const tag of TAGS) expect(out.includes(tag)).toBe(false);
    expect(out).toContain('2 capability(ies) tested: 0 passed, 1 passed with deviation, 1 passed with points, 0 blocked, 0 not supported by the provider');
    expect(out).toContain('2 point(s) to look at: 1 for the provider, 0 accepted deviation(s), 0 not supported, 0 question(s), 1 of OSCAR');
    expect(out.split('<tr><th colspan="4">Sale &#60;g&#62;</th></tr>').length).toBe(2);
    expect(out).toContain('<td>Sale &#60;l&#62; — Declared</td><td>1 test(s), 1 form(s) run · proven on the way by 3 run(s)<details><summary>Tests</summary>');
    expect(out).toContain('<a href="/run-detail.html?id=' + UUID + '">C_&#60;1&#62;</a> (SEARCH): Passed with points at 02. &#60;s&#62; — X &#60;c&#62;, to run again');
    expect(out).toContain('<details><summary>Problems on the way</summary><ul class="cov-list"><li>Z&#60;z&#62;: Passed with points</li>');
    expect(out).toContain('cov-points">Passed with points</span></td><td><a href="#cov-point-1" data-cov-point="1" aria-expanded="false">#1</a></td>');
    expect(out).toContain('<td>Documents (optional)</td>');
    expect(out).toContain('cov-deviation">Passed with deviation');
    expect(out).toContain('<td><strong>NHF_&#60;r&#62;</strong><br><small>Must &#60;refuse&#62;</small></td><td>Full &#60;refund&#62;</td>');
    expect(out).not.toContain('bad"');
    expect(out).toContain('<li id="cov-point-1"><strong>#1</strong> Sale &#60;l&#62; <span class="cov-state cov-blocked">Blocking</span><br>02. &#60;s&#62;, 05. &#60;t&#62; (HTTP 500, P&#60;q&#62;)'
      + '<br><strong>Expected:</strong> X &#60;c&#62;<br><strong>Seen:</strong> Got &#60;n&#62; instead<br><small>Found in OTST_&#60;e&#62; (C_&#60;1&#62;), from 2026-10-20 to 2026-10-26, 2 times</small>');
    expect(out).toContain('Finding: T &#60;f&#62; (provider_deviation, open)');
    expect(out).toContain('Runs: <a href="/run-detail.html?id=' + UUID + '">C_&#60;1&#62;</a>, C2');
    expect(out).toContain('<h4 class="cov-heading">Points to look at (2)</h4><h5 class="cov-subheading">For the provider (1)</h5>');
    expect(out).toContain('<h5 class="cov-subheading">OSCAR&#39;s own points (not counted against the provider) (1)</h5>');
    expect(out).toContain('(expected refusal)');
    expect(out).toContain('Possibly finding: Maybe &#60;m&#62; (open, open)');
    expect(out).toContain('Declared functions without a scenario run (1)');
    expect(out).toContain('<li>A_2 (A)</li>');
    expect(capabilityPointLinks([1, 'x', 2.5, -1])).toBe('<a href="#cov-point-1" data-cov-point="1" aria-expanded="false">#1</a>');
    expect(capabilityHtml({ points: [] })).toContain('<div class="cov-note">None.</div>');
  });

  test('a point number opens that point under its row, and closes it (#984)', () => {
    const out = coverageHtml({ ...answer, byCapability }, 'capabilities');
    // Under the row naming it, hidden, without the id the list at the end keeps.
    expect(out).toContain('#1</a></td></tr><tr class="cov-point-detail" data-cov-detail="1" hidden><td colspan="4"><ul class="cov-points-list">'
      + '<li><strong>#1</strong> Sale &#60;l&#62; <span class="cov-state cov-blocked">Blocking</span>');
    expect(out).toContain('#2</a></td></tr><tr class="cov-point-detail" data-cov-detail="2" hidden><td colspan="5"><ul class="cov-points-list"><li><strong>#2</strong>');
    expect(out.match(/id="cov-point-1"/g)).toHaveLength(1);
    expect(out.match(/id="cov-point-2"/g)).toHaveLength(1);
    expect(capabilityPointRows([1, 9, 'x'], byCapability.points, 4).match(/<tr /g)).toHaveLength(1);
    expect(capabilityPointRows(null, null, 4)).toBe('');

    const fakeRow = (cls, covDetail) => ({ classList: { contains: (c) => c === cls }, dataset: { covDetail }, hidden: true, nextElementSibling: null });
    const first = fakeRow('cov-point-detail', '1');
    const second = fakeRow('cov-point-detail', '2');
    first.nextElementSibling = second;
    second.nextElementSibling = fakeRow('group', undefined);
    const tr = { nextElementSibling: first };
    const attrs = {};
    const link = { dataset: { covPoint: '2' }, closest: (s) => (s === 'tr' ? tr : null), setAttribute: (k, v) => { attrs[k] = v; } };
    let prevented = 0;
    const click = { target: { closest: (s) => (s === 'a[data-cov-point]' ? link : null) }, preventDefault: () => { prevented += 1; } };
    toggleCoveragePoint(click);
    expect([first.hidden, second.hidden, attrs['aria-expanded'], prevented]).toEqual([true, false, 'true', 1]);
    toggleCoveragePoint(click);
    expect([second.hidden, attrs['aria-expanded'], prevented]).toEqual([true, 'false', 2]);
    // A number with no row under it is left to its link, to the list.
    link.dataset.covPoint = '7';
    toggleCoveragePoint(click);
    expect([first.hidden, second.hidden, prevented]).toEqual([true, true, 2]);
    expect(() => toggleCoveragePoint({ target: { closest: () => null } })).not.toThrow();
    expect(() => toggleCoveragePoint({ target: {} })).not.toThrow();
    // The live coverage and a published report both listen.
    const source = read(page);
    expect(source).toContain("document.getElementById('coverage-body').addEventListener('click', toggleCoveragePoint);");
    expect(source).toContain("document.getElementById('published-body').addEventListener('click', toggleCoveragePoint);");
  });

  test('the Markdown starts with the capabilities, then the two views as detail (G4)', () => {
    const md = coverageMarkdown({ ...answer, byCapability }, 'G');
    expect(md.match(/^# /gm)).toHaveLength(1);
    expect(md.match(/^## [A-Z].*$/gm)).toEqual(['## By capability', '## Expected refusals', '## Points to look at',
      '## Declared functions without a scenario run', '## Scenarios set apart (neither in the run list nor run)',
      '## By flow and element', '## By function declared', '## Scenarios testing what the Test Framework does not declare']);
    expect(md).toContain('| Sale \\<l> — Declared | 1 test(s), 1 form(s) run · proven on the way by 3 run(s) | Passed with points | #1 |');
    expect(md).toContain('| NHF_\\<r> | Full \\<refund> | Not refused | NHF_\\<r>: Not refused | #2 |');
    expect(md).toContain('- #1 Sale \\<l>, blocking — 02. \\<s>, 05. \\<t> (HTTP 500, P\\<q>). Expected: X \\<c>. Seen: Got \\<n> instead.'
      + ' Found in OTST_\\<e> (C_\\<1>), from 2026-10-20 to 2026-10-26, 2 times. Finding: T \\<f> (provider_deviation, open).');
    expect(md).toContain('## Points to look at\n\n### For the provider\n');
    expect(md).toContain('### OSCAR\'s own points (not counted against the provider)');
    expect(md).toContain('### Sales \\<flows>');
    expect(md).not.toContain('\n\n\n');
  });

  test('by function: a function\'s scenarios are folded, those not passed shown (G3)', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ code: 'S' + i, result: i < 12 ? 'failed' : 'passed', run: { passed: 1, failed: 1, at: 'd' } }));
    const out = coverageHtml({ ...answer, functions: [{ ...answer.functions[0], scenarios: many }] }, 'functions');
    expect(out).toContain('1 of 13 scenario(s) passed (0 with defects, 12 failed, 0 never run)<ul class="cov-list cov-failed-list">');
    expect(out).toContain('<li>… and 2 more</li></ul><details><summary>Scenarios</summary>');
    expect(out.match(/<li>S\d+: /g)).toHaveLength(10 + 13);
  });

  // #972 part 4: the published reports.
  const ID = '0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
  const listed = (extra) => ({ id: ID, number: 3, days: 30, createdAt: '2026-10-26 10:00:00', createdBy: 'tm@x', summary: { tested: 4, passed: 2, pointsToLookAt: { total: 5 } }, ...extra });

  test('published reports: the change names are the workbook\'s', () => {
    const { CHANGE_TEXT } = require('../../src/utils/coverageWorkbook');
    expect({ ...CHANGE_LABELS }).toEqual({ ...CHANGE_TEXT });
  });

  test('published reports: each state offers its own actions, every text escaped', () => {
    const buttons = (html) => [...html.matchAll(/data-report-action="(\w+)"/g)].map((m) => m[1]);
    expect(buttons(publishedListHtml([listed()], true))).toEqual(['view', 'excel', 'share']);
    expect(buttons(publishedListHtml([listed({ sharedAt: 'd', sharedBy: 's' })], true))).toEqual(['view', 'excel', 'withdraw']);
    expect(buttons(publishedListHtml([listed({ sharedAt: 'd', withdrawnAt: 'w' })], true))).toEqual(['view', 'excel']);
    // The certifier only reads.
    expect(buttons(publishedListHtml([listed({ sharedAt: 'd', company: 'P <p>', distributor: 'D <d>' })], false))).toEqual(['view', 'excel']);
    const out = publishedListHtml([listed({ sharedAt: 'd', company: 'P <p>', distributor: 'D <d>', createdBy: 'a<b>' }), listed({ id: 'x"><y>' })], false);
    for (const tag of ['<p>', '<d>', '<b>', '<y>']) expect(out.includes(tag)).toBe(false);
    expect(out).toContain('<td><strong>#3</strong><br><small>D &#60;d&#62; — P &#60;p&#62;</small></td>');
    expect(out).toContain('4 capability(ies) tested: 2 passed, 0 with deviation, 0 with points, 0 blocked · 5 point(s) to look at');
    expect(out.match(/<tr><td>/g)).toHaveLength(1);
    expect(publishedListHtml([listed({ number: '3"><z>' })], true)).toContain('data-report-number="0"');
    expect(publishedListHtml([], true)).toContain('No report published yet');
    expect(publishedListHtml(null, false)).toContain('No report has been shared with you yet.');
  });

  test('published reports: the comparison, and the report under it', () => {
    expect(comparisonHtml(null)).toContain('nothing to compare with');
    const c = {
      previous: { id: 'p', number: 2, sharedAt: '2026-10-20' }, counts: { fixed: 1, still: 1, new: 0, notRetested: 0 },
      points: { fixed: [{ previousNumber: 4, capabilityLabel: 'Sale <s>', steps: ['07. <x>'], check: 'C <c>' }],
        still: [{ number: 1, previousNumber: 2, capabilityLabel: 'Sale', steps: ['02.'], check: 'D' }], new: [], notRetested: [] },
      capabilities: [{ id: 'sale', label: 'Sale <s>', before: 'points', now: 'passed' }, { id: 'x', label: 'X', before: null, now: 'blocked' }],
    };
    const out = comparisonHtml(c);
    for (const tag of ['<s>', '<x>', '<c>']) expect(out.includes(tag)).toBe(false);
    expect(out).toContain('Since published report #2 (shared 2026-10-20): 1 fixed, 1 still open, 0 new, 0 not run again.');
    expect(out).toContain('<li>Sale &#60;s&#62;: Passed with points → Passed</li><li>X: not in the report → Blocked</li>');
    expect(out).toContain('<summary>Fixed (1)</summary><ul class="cov-list"><li>#4 of the previous report Sale &#60;s&#62; — 07. &#60;x&#62;: C &#60;c&#62;</li>');
    expect(out).toContain('<li>#1 (was #2) Sale — 02.: D</li>');
    expect(out).not.toContain('New (0)');
    const page = publishedHtml({ ...listed({ sharedAt: 'd', company: 'P' }), comparison: c, report: { ...answer, byCapability } }, 'capabilities');
    expect(page).toContain('Published report #3 of P, frozen on 2026-10-26 10:00:00 (runs of the last 30 day(s)). Shared with the certifier d.');
    expect(page).toContain('2 capability(ies) tested');
  });

  test('published reports: the server\'s own comparison draws', () => {
    const { comparisonOf } = require('../../src/utils/coverageReports');
    const point = (number, key, check) => ({ number, keys: [key], kind: 'provider', capability: 'sale', capabilityLabel: 'Sale', steps: ['07.'], check, tests: [{ key: 'T', codes: ['A'] }] });
    const r = (points) => ({ byCapability: { capabilities: [{ id: 'sale', label: 'Sale', result: 'points', tests: [{ forms: [{ code: 'A', runId: ID }] }] }], expectedRefusals: [], points } });
    const out = comparisonHtml(comparisonOf(r([point(1, 'b', 'New one')]), { id: 'p', number: 1, sharedAt: 's', report: r([point(1, 'a', 'Old one')]) }));
    expect(out).toContain('1 fixed, 0 still open, 1 new, 0 not run again.');
    expect(out).toContain('#1 of the previous report Sale — 07.: Old one');
  });

  test('published reports: the card is for Test Managers and certifiers; only an id that is a UUID reaches an address', () => {
    const source = read(page);
    expect(source).toContain("if (canPublish || isCertifier) {\n  document.getElementById('published-card').style.display = 'block';");
    expect(source).toContain("const canPublish = userRole === 'test_manager';");
    expect(source).toContain("return isCertifier ? '/v1/certifier/coverage-reports' : '/v1/company/coverage/reports';");
    expect(source).toContain("var id = coverageRunIdOf(button.dataset.reportId);");
    expect(source).toContain("fetch(publishedBase() + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })");
    expect(source).toContain("document.getElementById('coverage-publish-btn').disabled = false;");
  });

  test('the server\'s own coverage by capability draws', () => {
    const { capabilityCoverageOf } = require('../../src/utils/capabilityCoverage');
    const report = capabilityCoverageOf({
      framework: { salesFlows: ['SALE'] },
      datafile: { scenarios: [{ code: 'A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 }],
        tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: {} }], passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }] },
      runs: { A: { id: UUID, status: 'FAILED', completed_at: '2026-10-24 10:05:00',
        steps: ['01. POST Get Offer', '02. POST Create Booking', '06. POST Obtaining Fulfillments from Booking'].map((n) => ({ request_name: n, http_status: 200 })),
        checks: [{ request_name: '02. POST Create Booking', assertion_name: 'Booking price is 12.50', category: 'business_logic', severity: 'major', http_status: 200,
          error_msg: 'expected 12.4 to equal 12.5' }] } },
    });
    const out = capabilityHtml(report);
    expect(out).toContain('<td>Sale: pre-booking and confirmation — Declared</td>');
    expect(out).toContain('cov-points">Passed with points</span></td><td><a href="#cov-point-1" data-cov-point="1" aria-expanded="false">#1</a></td>');
    // A 2xx status is not printed: the answer was a success. What the run saw is the check's failure text (#990).
    expect(out).toContain('<li id="cov-point-1"><strong>#1</strong> Sale: pre-booking and confirmation<br>02. POST Create Booking<br><strong>Expected:</strong> Booking price is N'
      + '<br><strong>Seen:</strong> expected 12.4 to equal 12.5<br><small>');
    // A test outside the catalogue is named by its code, once.
    expect(out).toContain('Found in A, on 2026-10-24 10:05:00');
  });

  // #1002: an export's file name starts with the provider's.
  describe('the export file names (#1002)', () => {
    const { fileNamePrefix } = require('../../src/utils/fileNames');
    const { SAMPLES } = require('../helpers/file-name-samples');

    test('the page makes the same start as the server', () => {
      for (const [name, prefix] of SAMPLES) {
        expect(coverageFilePrefix(name)).toBe(prefix);
        expect(coverageFilePrefix(name)).toBe(fileNamePrefix(name));
      }
      expect(coverageFilePrefix('a'.repeat(59) + ' b')).toBe(fileNamePrefix('a'.repeat(59) + ' b'));
      expect(coverageFileName('ČD Test', 'oscar-coverage-2026-10-27.md')).toBe('CD-Test-oscar-coverage-2026-10-27.md');
      expect(coverageFileName('', 'oscar-coverage-2026-10-27.md')).toBe('oscar-coverage-2026-10-27.md');
    });

    test('a workbook takes the server\'s name, when it is a plain file name', () => {
      const answer = (value) => ({ headers: { get: (h) => (h === 'Content-Disposition' ? value : null) } });
      expect(downloadFileName(answer('attachment; filename="Prov-P1-oscar-coverage-report-1.xlsx"'), 'x.xlsx')).toBe('Prov-P1-oscar-coverage-report-1.xlsx');
      expect(downloadFileName(answer('attachment; filename="../evil.xlsx"'), 'x.xlsx')).toBe('x.xlsx');
      expect(downloadFileName(answer('attachment; filename="a b.xlsx"'), 'x.xlsx')).toBe('x.xlsx');
      expect(downloadFileName(answer(null), 'x.xlsx')).toBe('x.xlsx');
      expect(downloadFileName({}, 'x.xlsx')).toBe('x.xlsx');
    });

    test('the three downloads use them', () => {
      const source = read(page);
      expect(source).toContain("a.download = downloadFileName(res, coverageFileName(coverageTitle(), 'oscar-coverage-' + new Date().toISOString().slice(0, 10) + '.xlsx'));");
      expect(source).toContain("a.download = coverageFileName(coverageTitle(), 'oscar-coverage-' + new Date().toISOString().slice(0, 10) + '.md');");
      expect(source).toContain("a.download = downloadFileName(res, 'oscar-coverage-report-' + number + '.xlsx');");
      expect(source).not.toContain("a.download = 'oscar-coverage");
    });
  });

  // #994: the provider's position on a point.
  describe('a position on a point (#994)', () => {
    const PP = require('../../src/utils/pointPositions');
    const K = require('../../src/utils/capabilities');
    const positions = { choices: PP.choices(), alwaysRequired: [...K.ALWAYS_REQUIRED] };
    const ID = '0123456789abcdef0123456789abcdef';
    const point = (extra = {}) => ({
      ...byCapability.points[0], id: ID, kind: 'provider', capability: 'fulfilment.documents', capabilityLabel: 'Documents <d>', expectedRefusal: false,
      finding: { id: 'f', title: 'T <f>', category: 'not_supported', status: 'discussing',
        position: { value: 'notSupported', label: 'Not supported: optional, not a blocker', by: 'ana<a>', role: 'tester', at: '2026-10-27 09:00:00', comment: 'Mobile <only>' } },
      ...extra,
    });
    const keys = (p) => capabilityPositionChoices(p, positions).map((c) => c.key);

    test('the position is said on its point, signed and escaped, in the page and in the Markdown', () => {
      expect(capabilityPositionText(point().finding.position))
        .toBe('Position: Not supported: optional, not a blocker — ana<a> (tester), 2026-10-27 09:00:00: Mobile <only>');
      // A published report names the role and the date only.
      expect(capabilityPositionText({ value: 'fix', label: 'Agreed, we will fix it', role: 'Test Manager', at: '2026-10-27' }))
        .toBe('Position: Agreed, we will fix it — (Test Manager), 2026-10-27');
      expect(capabilityPositionText(null)).toBe('');
      const out = capabilityPointHtml(point(), true, positions);
      expect(out).toContain('<br><small>Position: Not supported: optional, not a blocker — ana&#60;a&#62; (tester), 2026-10-27 09:00:00: Mobile &#60;only&#62;</small>');
      expect(out).not.toContain('<only>');
      expect(capabilityPointLine(point())).toContain(' Position: Not supported: optional, not a blocker — ana<a> (tester), 2026-10-27 09:00:00: Mobile <only>.');
    });

    test('the choices are those the server takes: "not supported" never under the sale, the offers by search, nor for an expected refusal', () => {
      expect(keys(point())).toEqual(PP.choices().map((c) => c.key));
      for (const def of K.CAPABILITIES) {
        for (const expectedRefusal of [false, true]) {
          const p = point({ capability: def.id, expectedRefusal });
          const taken = PP.choices().map((c) => c.key).filter((key) => PP.positionRefusal(p, key) === null);
          expect(keys(p)).toEqual(taken);
        }
      }
      expect(keys(point({ capability: 'sale' }))).not.toContain('notSupported');
      // None on a known deviation, a point OSCAR owns, an id that is not one, or a published report.
      expect(keys(point({ source: 'known-deviation' }))).toEqual([]);
      expect(keys(point({ kind: 'oscar', finding: null }))).toEqual([]);
      expect(keys(point({ kind: 'oscar', finding: { category: 'oscar_issue' } }))).toContain('fix');
      expect(keys(point({ id: '"><x>' }))).toEqual([]);
      expect(capabilityPositionChoices(point(), undefined)).toEqual([]);
    });

    test('the button and the form', () => {
      expect(capabilityPositionButtonHtml(point(), positions))
        .toBe('<br><button type="button" class="btn btn-secondary btn-sm" data-cov-position="' + ID + '">Change the position</button>');
      expect(capabilityPositionButtonHtml(point({ finding: null }), positions)).toContain('>Take a position</button>');
      expect(capabilityPositionButtonHtml(point(), undefined)).toBe('');
      const form = capabilityPositionFormHtml(point({ capability: 'sale' }), { ...positions, choices: [...positions.choices, { key: 'x"', label: 'L <l>' }] });
      expect(form).toContain('<form class="cov-position-form" data-cov-position-form="' + ID + '">');
      expect(form).toContain('<option value="fix">Agreed, we will fix it</option>');
      expect(form).not.toContain('value="notSupported"');
      expect(form).toContain('<option value="x&#34;">L &#60;l&#62;</option>');
      expect(form).toContain('<textarea name="comment" rows="3" maxlength="4000" required></textarea>');
    });

    test('the live coverage offers a position on every point, under its row and in the list; a published report on none', () => {
      const points = [point({ number: 1 })];
      const live = capabilityHtml({ ...byCapability, points, positions });
      expect(live.split('data-cov-position="' + ID + '"').length).toBe(3);
      expect(capabilityHtml({ ...byCapability, points })).not.toContain('data-cov-position=');
      expect(capabilityPointsHtml(points)).not.toContain('data-cov-position=');
      expect(capabilityHtml({ ...byCapability, points: [point({ number: 1, kind: 'unsupported' })], positions }))
        .toContain('<h5 class="cov-subheading">Not supported by the provider (not counted against it) (1)</h5>');
    });

    test('the page sends the position and draws the coverage again at its point', () => {
      const source = read(page);
      expect(source).toContain("document.getElementById('coverage-body').addEventListener('click', toggleCoveragePosition);");
      expect(source).toContain("document.getElementById('coverage-body').addEventListener('submit', function(e) { saveCoveragePosition(e).catch(function() {}); });");
      expect(source).toContain("var res = await fetch('/v1/company/coverage/positions', {\n      method: 'POST',");
      expect(source).toContain('return { point: id, days: coverageData.days, position: form.elements.position.value, comment: form.elements.comment.value };');
      expect(source).toContain('      body: JSON.stringify(asked)');
      // The server's sentence ends with its own full stop.
      expect(source).toContain("msg.textContent = capabilitySentence('Not saved: ' + ((data && data.detail) || ('HTTP ' + res.status)));");
      expect(capabilitySentence('Not saved: it cannot be "not supported".')).toBe('Not saved: it cannot be "not supported".');
    });
  });

  // #995: the offer request options' results, from the server module's own answer.
  describe('the offer request options (#995)', () => {
    const C = require('../../src/utils/offerOptionCoverage');
    const { COMBINATION_WORDS } = require('../../src/utils/coverageWorkbook');
    const report = {
      version: '3.8.0', budget: 30, used: 6, mandatory: { ok: true, message: '2 offer(s)' },
      options: [
        { option: 'offerSearchCriteria.currency', value: 'EUR <e>', source: 'declared', declared: true, status: 200, result: 'honoured', message: 'kept <k>' },
        { option: 'passenger.gender', declared: false, status: 200, result: 'ignored-silent', message: 'silent' },
        { option: 'embed<x>', status: 501, result: 'not-implemented' },
      ],
      combinations: [
        { options: ['offerSearchCriteria.currency', 'embed<x>'], status: 400, result: 'refused', message: 'COMBO <c>' },
        { options: ['offerSearchCriteria.currency', 'passenger.gender'], status: 200, result: 'no-offer-said', message: 'NO <n>' },
      ],
      all: { count: 3, status: 200, result: 'accepted' },
    };
    const entries = C.offerOptionCoverageOf([{ code: 'OPT_<o>', run: { id: UUID, completed_at: '2026-10-26 20:22:07' }, report }]);
    const data = C.withOfferOptions({ ...byCapability, capabilities: [...byCapability.capabilities,
      { id: 'offers.requestOptions', group: 'Offers', label: 'Optional parameters of the offer request', result: 'points', tests: [], provenBy: { count: 0 }, sideProblems: [], points: [] }] }, entries);

    test('the page\'s words are the server\'s', () => {
      const lines = read(page).split('\n');
      const start = lines.findIndex((l) => l.startsWith('var OFFER_OPTION_RESULTS = {'));
      const end = lines.findIndex((l, i) => i > start && l === '};');
      const pageWords = vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n').replace('var OFFER_OPTION_RESULTS = ', '').replace(/;$/, '')})`);
      expect({ ...pageWords }).toEqual({ ...C.RESULT_TEXT });
      expect(Object.keys(COMBINATION_WORDS).sort()).toEqual(Object.keys(C.COMBINATION_TEXT).sort());
      for (const state of Object.keys(COMBINATION_WORDS)) expect(capabilityCombinationText({ state })).toBe(COMBINATION_WORDS[state]);
    });

    test('each run is folded under its summary: the mandatory request, every parameter, the combinations', () => {
      const out = capabilityHtml(data);
      for (const t of ['<e>', '<k>', '<x>', '<c>', '<n>', '<o>']) expect(out.includes(t)).toBe(false);
      expect(out).toContain('<h4 class="cov-heading">Optional parameters of the offer request (1 run(s))</h4>');
      expect(out).toContain('<details class="cov-options"><summary><a href="/run-detail.html?id=' + UUID + '">OPT_&#60;o&#62;</a>, 2026-10-26 20:22:07<br><small>'
        + 'mandatory parameters only: answered · 3 parameter(s): 1 supported, 1 ignored, 1 refused or not implemented'
        + ' · 2 combination(s): 0 answered, 1 without offer, 1 refused · every supported parameter at once: answered</small></summary>');
      expect(out).toContain('<div class="cov-note">Mandatory parameters only: answered — 2 offer(s)</div>');
      expect(out).toContain('<tr><td>offerSearchCriteria.currency</td><td>EUR &#60;e&#62; (declared)</td><td>200</td><td>Supported, kept to</td><td>Declared</td><td>kept &#60;k&#62;</td></tr>');
      expect(out).toContain('<tr><td>passenger.gender</td><td></td><td>200</td><td>Ignored, not said</td><td>Declared not supported</td><td>silent</td></tr>');
      expect(out).toContain('<tr><td>embed&#60;x&#62;</td><td></td><td>501</td><td>Not implemented</td><td>Not declared</td><td></td></tr>');
      expect(out).toContain('<li>offerSearchCriteria.currency + embed&#60;x&#62;: Refused (a point) (HTTP 400) — COMBO &#60;c&#62;</li>');
      expect(out).toContain('<li>offerSearchCriteria.currency + passenger.gender: No offer (HTTP 200) — NO &#60;n&#62;</li>');
      expect(out).toContain('<li>Every supported parameter at once (3): Answered (HTTP 200)</li>');
      // Between the expected refusals and the points, and the latest run's summary under the capability.
      expect(out.indexOf('Expected refusals')).toBeLessThan(out.indexOf('Optional parameters of the offer request ('));
      expect(out.indexOf('Optional parameters of the offer request (')).toBeLessThan(out.indexOf('Points to look at'));
      expect(out).toContain('<td>Optional parameters of the offer request</td><td>No test<br><small>mandatory parameters only: answered · 3 parameter(s)');
      expect([capabilityOptionsHtml([]), capabilityOptionsHtml(null), capabilityHtml(byCapability).includes('cov-options')]).toEqual(['', '', false]);
      const bare = capabilityOptionsHtml([{ code: 'B', runId: 'nope', text: 't', parameters: [], combinations: [] }]);
      expect(bare).toContain('<summary>B<br><small>t</small></summary><div class="cov-note">Mandatory parameters only: not in the report</div></details>');
    });

    test('the Markdown has the same, one table per run', () => {
      const md = coverageMarkdown({ ...answer, byCapability: data }, 'G');
      expect(md).toContain('\n## Optional parameters of the offer request\n\n### OPT_\\<o>, 2026-10-26 20:22:07\n\nmandatory parameters only: answered · 3 parameter(s)');
      expect(md).toContain('\nMandatory parameters only: answered — 2 offer(s)\n\n| Parameter | Value sent | HTTP | Result | Test Framework | Detail |\n|---|---|---|---|---|---|\n');
      expect(md).toContain('| offerSearchCriteria.currency | EUR \\<e> (declared) | 200 | Supported, kept to | Declared | kept \\<k> |');
      expect(md).toContain('\n\n- offerSearchCriteria.currency + embed\\<x>: Refused (a point) (HTTP 400) — COMBO \\<c>\n');
      expect(md).toContain('- Every supported parameter at once (3): Answered (HTTP 200)');
      expect(md).toContain('| Optional parameters of the offer request | No test · mandatory parameters only: answered · 3 parameter(s)');
      expect(md.indexOf('## Expected refusals')).toBeLessThan(md.indexOf('## Optional parameters of the offer request'));
      expect(md.indexOf('## Optional parameters of the offer request')).toBeLessThan(md.indexOf('## Points to look at'));
      expect(md).not.toContain('\n\n\n');
    });
  });

  test('an expected refusal\'s forms: the counts, those not refused by step, every form folded (#996)', () => {
    const form = (code, result, step) => ({ code, form: 'SEARCH', result, runId: UUID, step, check: step ? `Check at <${step}>` : undefined });
    const refused = Array.from({ length: 9 }, (_, i) => form(`NHF_<a>${i}`, 'refused'));
    const all = capabilityRefusalFormsHtml(refused);
    expect(all.startsWith('9 form(s): 9 refused as expected<details><summary>Forms</summary><ul class="cov-list"><li>')).toBe(true);
    expect(all).not.toContain('cov-failed-list');
    expect(all.match(/<li>/g)).toHaveLength(9);
    expect(all.includes('<a>')).toBe(false);
    // The counts keep one order, whatever order the forms come in. The forms not
    // refused are one line per step (three at most), never one line per form.
    const steps = ['14. GET <s>', '14. GET <s>', '14. GET <s>', '14. GET <s>', '14. GET <s>', '14. GET <s>', '02. POST', '02. POST', '02. POST', '13. PATCH', '10. POST', undefined];
    const mixed = capabilityRefusalFormsHtml([form('C', 'not-run'), ...steps.map((s, i) => form(`B${i}`, 'not-refused', s)), ...refused.slice(0, 2)]);
    expect(mixed).toContain('15 form(s): 2 refused as expected, 12 not refused, 1 not run<ul class="cov-list cov-failed-list">'
      + '<li>Not refused at 14. GET &#60;s&#62; (6 form(s))</li><li>Not refused at 02. POST (3 form(s))</li><li>Not refused at 13. PATCH (1 form(s))</li>'
      + '<li>… and 2 more step(s)</li></ul><details>');
    const open = mixed.split('<details>')[0];
    for (const hidden of ['NHF_', 'B0', '>C<', 'Check at']) expect(open).not.toContain(hidden);
    expect(mixed.split('<details>')[1].match(/<li>/g)).toHaveLength(15);
    expect(capabilityRefusalFormsHtml([form('A', 'not-refused')])).toContain('<li>Not refused (1 form(s))</li></ul>');
    // #1027: a form stopped before it asked is blocked, counted after the forms not refused.
    expect(capabilityRefusalFormsHtml([form('Z', 'not-run'), form('Y', 'blocked', '01. POST'), ...refused.slice(0, 1)]))
      .toContain('3 form(s): 1 refused as expected, 1 blocked, 1 not run<details>');
    expect(ctx.capabilitySummaryText({ expectedRefusals: { total: 3, refused: 1, deviation: 0, notRefused: 0, blocked: 2, notRun: 0 } }, 30))
      .toContain('expected refusals: 1 of 3 refused (0 accepted deviation, 0 not refused, 2 blocked, 0 not run)');
    expect([capabilityRefusalFormsHtml([]), capabilityRefusalFormsHtml(null)]).toEqual(['-', '-']);
    // In the table, the column holds the folded forms.
    const out = capabilityHtml({ expectedRefusals: [{ key: 'NHF_X', capabilityLabel: 'Sale', result: 'refused', forms: refused, points: [] }], points: [] });
    expect(out).toContain('<td>9 form(s): 9 refused as expected<details><summary>Forms</summary>');
  });

  test('a known deviation is one line; a point of a report published before #990 has no "Seen"', () => {
    const base = { number: 1, kind: 'accepted', capability: 'sale', capabilityLabel: 'Sale', steps: ['02. <b>'], status: 202, problemCode: null, occurrences: 1, tests: [], runs: [] };
    const deviation = capabilityPointsHtml([{ ...base, source: 'known-deviation', check: 'Known deviation: answered HTTP 202', note: 'Later <x>' }]);
    expect(deviation).toContain('<br>02. &#60;b&#62;: Known deviation: answered HTTP 202<br><small>Later &#60;x&#62;</small>');
    expect(deviation).not.toContain('Expected:');
    const before = capabilityPointsHtml([{ ...base, kind: 'provider', source: 'check', check: 'Price <c>', status: 200 }]);
    expect(before).toContain('<br>02. &#60;b&#62;<br><strong>Expected:</strong> Price &#60;c&#62;<br><small>Found in no test');
    expect(before).not.toContain('Seen:');
    // Only a line's own label is set in bold; the rest of it is text.
    const label = capabilityPointsHtml([{ ...base, kind: 'provider', source: 'check', check: 'Seen: <b>', status: 200, observed: { text: 'Expected: <i>' } }]);
    expect(label).toContain('<br><strong>Expected:</strong> Seen: &#60;b&#62;<br><strong>Seen:</strong> Expected: &#60;i&#62;<br>');
    expect([capabilitySentence('a'), capabilitySentence('b.'), capabilitySentence('c…'), capabilitySentence('d?')]).toEqual(['a.', 'b.', 'c…', 'd?']);
  });
});

// #959: the "Exchange to" section of an EXCHANGE scenario.
describe('scenarios.js — what an exchange is for (#959)', () => {
  const S = 'js/scenarios.js';
  const exchangeBlockOf = loadFunction(S, 'exchangeBlockOf');
  const withExchangeValue = loadFunction(S, 'withExchangeValue', { exchangeBlockOf });
  const withExchangeCriterion = loadFunction(S, 'withExchangeCriterion', { exchangeBlockOf, withExchangeValue });
  const lines = read(S).split('\n');
  const constOf = (name) => vm.runInNewContext(lines.find(l => l.startsWith(`const ${name} = `)).replace(/^const \w+ = /, '').replace(/;$/, ''));
  const EXCHANGE_TIME = constOf('EXCHANGE_TIME');
  const exchangeInputValue = loadFunction(S, 'exchangeInputValue', { EXCHANGE_TIME });
  const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  test('the criteria are those the collection takes', () => {
    const { CRITERIA_KEYS } = require('../../../Bruno_Collection/library-bruno/exchangeTrip.js');
    expect(constOf('EXCHANGE_CRITERIA_KEYS')).toEqual(CRITERIA_KEYS);
  });

  test('a value set or removed; nothing left = no block', () => {
    expect(withExchangeValue({}, 'dateOffsetDays', 1)).toEqual({ dateOffsetDays: 1 });
    expect(withExchangeValue({ exchange: { dateOffsetDays: 1, time: '12:00' } }, 'time', null)).toEqual({ dateOffsetDays: 1 });
    expect(withExchangeValue({ exchange: { time: '12:00' } }, 'time', '')).toBeNull();
    expect(withExchangeValue({ exchange: 'odd' }, 'time', '12:00')).toEqual({ time: '12:00' });
  });

  test('a criterion ticked and unticked; empty lists and criteria go', () => {
    const one = withExchangeCriterion({}, 'travelClasses', 'FIRST', true);
    expect(one).toEqual({ offerSearchCriteria: { travelClasses: ['FIRST'] } });
    const two = withExchangeCriterion({ exchange: one }, 'flexibilities', 'NON_FLEXIBLE', true);
    expect(two.offerSearchCriteria).toEqual({ travelClasses: ['FIRST'], flexibilities: ['NON_FLEXIBLE'] });
    expect(withExchangeCriterion({ exchange: one }, 'travelClasses', 'FIRST', true)).toEqual(one);   // never twice
    expect(withExchangeCriterion({ exchange: one }, 'travelClasses', 'FIRST', false)).toBeNull();
    expect(withExchangeCriterion({ exchange: { ...one, dateOffsetDays: 2 } }, 'travelClasses', 'FIRST', false)).toEqual({ dateOffsetDays: 2 });
  });

  test('typed values: what the collection takes, else ignored mid-edit', () => {
    const ok = (value) => ({ valid: true, value });
    expect(exchangeInputValue('dateOffsetDays', ' 3 ')).toEqual(ok(3));
    expect(exchangeInputValue('dateOffsetDays', '-60')).toEqual(ok(-60));
    expect(exchangeInputValue('dateOffsetDays', '61').valid).toBe(false);
    expect(exchangeInputValue('dateOffsetDays', '1.5').valid).toBe(false);
    expect(exchangeInputValue('time', '12:05')).toEqual(ok('12:05'));
    expect(exchangeInputValue('time', '12:0').valid).toBe(false);
    expect(exchangeInputValue('time', '24:00').valid).toBe(false);
    expect(exchangeInputValue('tripRequirementId', '7')).toEqual(ok(7));
    expect(exchangeInputValue('tripRequirementId', '')).toEqual(ok(null));
    expect(exchangeInputValue('other', '1').valid).toBe(false);
  });

  test('the trips a scenario names include its exchange\'s', () => {
    const scenarioTripIds = loadFunction(S, 'scenarioTripIds', { exchangeBlockOf });
    expect(scenarioTripIds({ tripRequirementId: 1 })).toEqual([1]);
    expect(scenarioTripIds({ tripRequirementId: 1, exchange: { tripRequirementId: 2 } })).toEqual([1, 2]);
    expect(scenarioTripIds(undefined)).toEqual([undefined]);
  });

  function section(sc, trips) {
    const exchangeTripLabel = loadFunction(S, 'exchangeTripLabel');
    const ctx = { esc: escHtml, lbl: (v) => v, ENUMS: { travelClass: ['FIRST', 'SECOND'], serviceClass: ['STANDARD'], flexibilities: ['FULL_FLEXIBLE'] } };
    ctx.exchangeCriterionHtml = loadFunction(S, 'exchangeCriterionHtml', ctx);
    return loadFunction(S, 'buildExchangeSection', {
      ...ctx, exchangeBlockOf, exchangeTripLabel,
      state: { tripRequirements: trips },
      getTrip: (id) => trips.find(t => t.id === id),
    })(0, sc);
  }
  const TRIPS = [
    { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002' } },
    { id: 2, tripType: 'SPECIFICATION', legs: [{ origin: 'urn:uic:stn:0000003', destination: 'urn:uic:stn:4' }, { origin: 'x', destination: 'urn:uic:stn:0000001' }] },
  ];

  test('drawn for an exchange only, with every trip, the choice and the ticks', () => {
    expect(section({ scenarioType: 'REFUND', tripRequirementId: 1 }, TRIPS)).toBe('');
    const html = section({ scenarioType: 'EXCHANGE', tripRequirementId: 1,
      exchange: { tripRequirementId: 2, dateOffsetDays: 1, offerSearchCriteria: { travelClasses: ['FIRST'] } } }, TRIPS);
    expect(html).toContain('<option value="2" selected>#2 0000003 → 0000001 (SPECIFICATION)</option>');
    expect(html).toContain('<option value="1" >#1 0000001 → 0000002 (SEARCH)</option>');
    expect(html).toContain('value="1"\n          placeholder="leave empty = the sale\'s day"');
    expect(html).toMatch(/checked data-action="toggle-exchange-criterion" data-idx="0" data-field="travelClasses" data-val="FIRST"/);
    expect(html).toContain('A trip specification takes the times of its legs');
    expect(section({ scenarioType: 'EXCHANGE', tripRequirementId: 1 }, TRIPS)).toContain("(the sale's trip)");
  });

  test('a trip id the data file does not hold is shown, not dropped', () => {
    const html = section({ scenarioType: 'EXCHANGE', tripRequirementId: 1, exchange: { tripRequirementId: 9 } }, TRIPS);
    expect(html).toContain('<option value="9" selected>#9 (not in the data file)</option>');
  });

  test('a trip label is text: a stop place holding markup is escaped when drawn', () => {
    const html = section({ scenarioType: 'EXCHANGE', tripRequirementId: 1 },
      [{ id: 3, tripType: 'SEARCH', trip: { origin: '<b>x', destination: 'y' } }]);
    expect(html).toContain('#3 &lt;b&gt;x → y (SEARCH)');
    expect(html).not.toContain('<b>x');
  });

  test('the handler stores the block, removes it when empty, and ignores a value mid-edit', () => {
    const scenarios = [{ code: 'X', scenarioType: 'EXCHANGE', tripRequirementId: 1 }];
    let dirty = 0;
    let redrawn = 0;
    const change = loadFunction(S, 'changeExchange', {
      state: { scenarios }, markDirty: () => { dirty++; }, reRenderScenarioDetail: () => { redrawn++; },
      withExchangeValue, withExchangeCriterion, exchangeInputValue,
    });
    const el = (action, field, value, extra = {}) => ({ dataset: { idx: '0', field, ...extra }, value, ...(action === 'toggle-exchange-criterion' ? { checked: value } : {}) });
    expect(change('set-scenario-text', el('x', 'y', 'z'))).toBe(false);
    expect(change('set-exchange-field', el('set-exchange-field', 'time', '12:'))).toBe(true);
    expect(scenarios[0].exchange).toBeUndefined();
    expect(dirty).toBe(0);
    change('set-exchange-field', el('set-exchange-field', 'time', '12:30'));
    change('set-exchange-field', el('set-exchange-field', 'tripRequirementId', '2'));
    change('toggle-exchange-criterion', el('toggle-exchange-criterion', 'travelClasses', true, { val: 'FIRST' }));
    expect(scenarios[0].exchange).toEqual({ time: '12:30', tripRequirementId: 2, offerSearchCriteria: { travelClasses: ['FIRST'] } });
    expect(redrawn).toBe(2);
    change('set-exchange-field', el('set-exchange-field', 'time', ''));
    change('set-exchange-field', el('set-exchange-field', 'tripRequirementId', ''));
    change('toggle-exchange-criterion', el('toggle-exchange-criterion', 'travelClasses', false, { val: 'FIRST' }));
    expect('exchange' in scenarios[0]).toBe(false);
    expect(dirty).toBe(6);
  });

  test('the wiring: drawn after the trip, handled by the change and input listeners, trips in use follow it', () => {
    const source = read(S);
    expect(source).toContain('${buildTripSection(idx, sc, trip)}\n\n  <!-- #959: what an exchange is for -->\n  ${buildExchangeSection(idx, sc)}');
    expect(source).toContain('  if (changeExchange(action, el)) return;\n');
    expect(source).toContain('|| changeExchange(action, el)) return;');
    expect(source).toContain('scenarioTripIds(sc).includes(trip.id) && isReadOnlyForMe(sc)');
    expect(source).toContain('...scenarioTripIds(s), s.passengersListId');
  });
});
