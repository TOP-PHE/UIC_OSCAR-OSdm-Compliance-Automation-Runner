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

describe('js/scenarios.js — esc', () => {
  // The page's HTML encoder: every occurrence must be encoded, "&" first.
  const esc = loadFunction('js/scenarios.js', 'esc');

  test('it keeps the form CodeQL recognises as an encoder', () => {
    // Sonar (S7781) asks for replaceAll('<', ...). #526 did that, and CodeQL then
    // reported escaped values reaching innerHTML as XSS: it knows an encoder by
    // replace() with a global regex. If this fails, read the comment in esc().
    const lines = read('js/scenarios.js').split('\n');
    const start = lines.indexOf('function esc(s) {');
    const body = lines.slice(start, lines.indexOf('}', start)).filter(l => !l.trim().startsWith('//')).join('\n');
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
  const escHtml = loadFunction(page, 'esc');
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
    const seed = loadFunction(page, '_ttSeedOD', { wizData: { resources }, normalizeTrainData: loadFunction(page, 'normalizeTrainData') });
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
  const escHtml = loadFunction(page, 'esc');
  const isArmed = loadFunction(page, 'isArmed');

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
  ])('fwUndeclaredArmedCount: %s', (_label, scenarios, salesFlows, expected) => {
    const count = loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, state: { scenarios }, wizData: { framework: { salesFlows } } });
    expect(count()).toBe(expected);
  });

  test('fwUndeclaredArmedCount with nothing loaded', () => {
    expect(loadFunction(page, 'fwUndeclaredArmedCount', { isArmed, state: null, wizData: null })()).toBe(0);
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
