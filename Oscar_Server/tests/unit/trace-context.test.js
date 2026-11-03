// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #1070: the W3C Trace Context of every OSDM request. The Test Framework's
 * settings (public/js/trace-context.js, shared by the page and the server),
 * the collection's flow (library-bruno/traceContext.js: one trace per sale,
 * from each "01. POST Get Offer"), the two held alike, and the wiring.
 */

const fs = require('node:fs');
const path = require('node:path');
const TC = require('../../public/js/trace-context.js');
const BT = require('../../../Bruno_Collection/library-bruno/traceContext.js');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

// ── The Test Framework's settings ───────────────────────────────────────────

describe('trace context settings (public/js/trace-context.js)', () => {
  test('absent = a sampled traceparent and no tracestate', () => {
    expect(TC.settingsOf({})).toEqual({ send: true, sampled: true, tracestate: '' });
    expect(TC.settingsOf(null)).toEqual({ send: true, sampled: true, tracestate: '' });
    expect(TC.settingsOf({ traceContext: [] })).toEqual({ send: true, sampled: true, tracestate: '' });
    expect(TC.runSettingsOf({})).toEqual({ send: true, flags: '01', tracestate: [] });
  });

  test('the preview uses W3C\'s own example ids', () => {
    expect(TC.preview({})).toEqual({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', tracestate: '', problem: null });
    expect(TC.preview({ traceContext: { sampled: false, tracestate: 'processid={{uuid}}' } })).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'processid=4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
      problem: null,
    });
    expect(TC.preview({ traceContext: { send: false } }).traceparent).toBe('');
  });

  test.each([
    'processid={{uuid}}',
    'processid={{ UUID }}',
    'a={{traceId}},b={{parentId}}',
    'vendor@sys=x{{parentId}}, other=plain value',
    'k=v',
    '  k=v  ',
    '',
  ])('accepted tracestate template %p', (tracestate) => {
    expect(TC.traceContextProblem({ tracestate })).toBeNull();
  });

  test.each([
    ['processid={{uid}}', '"{{uid}}" is not a value OSCAR fills in'],
    ['processid = {{uuid}}', 'is not a tracestate key'],
    ['Processid={{uuid}}', 'is not a tracestate key'],
    ['1abc=x', 'is not a tracestate key'],
    ['a@b@c=x', 'is not a tracestate key'],
    ['a@B=x', 'is not a tracestate key'],
    [`a@${'s'.repeat(15)}=x`, 'is not a tracestate key'],
    ['a=b=c', 'is not a tracestate value'],
    ['a=', 'is not a tracestate value'],
    ['a=x\ty', 'is not a tracestate value'],
    ['a=é', 'is not a tracestate value'],
    [`a=${'v'.repeat(257)}`, 'is not a tracestate value'],
    ['a=1,,b=2', 'an empty member'],
    ['a=1,', 'an empty member'],
    ['a=1,a=2', 'names "a" twice'],
    ['novalue', 'is not a tracestate member'],
    ['a=x}}', 'A "}}" with no "{{"'],
    ['a={{uuid', 'A "{{" with no "}}"'],
    ['a={{ {{uuid}}', 'is not a value OSCAR fills in'],
    [Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(','), '33 members'],
    [Array.from({ length: 30 }, (_, i) => `k${i}={{uuid}}`).join(','), 'characters long once filled in'],
    ['k=' + 'v'.repeat(520), 'characters long; 512 at most'],
  ])('refused tracestate template %p', (tracestate, says) => {
    expect(TC.traceContextProblem({ tracestate })).toContain(says);
  });

  test.each([
    ['a list', ['x'], 'is an object'],
    ['text', 'on', 'is an object'],
    ['an unknown setting', { sample: true }, 'no setting "sample"'],
    ['send as text', { send: 'yes' }, '"send" is true or false'],
    ['sampled as a number', { sampled: 1 }, '"sampled" is true or false'],
    ['tracestate as a list', { tracestate: ['a=b'] }, 'tracestate is text'],
  ])('refused trace context: %s', (_label, traceContext, says) => {
    expect(TC.traceContextProblem(traceContext)).toContain(says);
  });

  test('none, or the defaults written out, are accepted', () => {
    expect(TC.traceContextProblem(undefined)).toBeNull();
    expect(TC.traceContextProblem(null)).toBeNull();
    expect(TC.traceContextProblem({ send: true, sampled: false, tracestate: '' })).toBeNull();
  });

  test('a run gets the template parsed, with no "{{" left for Bruno to fill in', () => {
    const run = TC.runSettingsOf({ traceContext: { sampled: false, tracestate: 'processid={{uuid}},oscar=p{{parentId}}' } });
    expect(run).toEqual({
      send: true, flags: '00',
      tracestate: [['t', 'processid='], ['v', 'uuid'], ['t', ',oscar=p'], ['v', 'parentId']],
    });
    expect(JSON.stringify(run)).not.toMatch(/\{\{|\}\}/);
  });

  test('a stored tracestate that is refused is left out of a run, never sent half-right', () => {
    expect(TC.runSettingsOf({ traceContext: { tracestate: 'a = b' } }).tracestate).toEqual([]);
    expect(TC.headersFor({ tracestate: 'a = b' }, TC.SAMPLE.uuid, TC.SAMPLE.parentId)).toEqual({ traceparent: expect.any(String) });
  });

  test('isTraceparent follows W3C version 00', () => {
    expect(TC.isTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(true);
    expect(TC.isTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBe(false);
    expect(TC.isTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBe(false);
    expect(TC.isTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01')).toBe(false);
    expect(TC.isTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(false);
    expect(TC.isTraceparent('cafebabe-0815')).toBe(false);
  });
});

// ── The collection's flow ───────────────────────────────────────────────────

function fakeBru(vars = {}) {
  const env = { ...vars };
  return {
    env,
    getEnvVar: (k) => env[k],
    setEnvVar: (k, v) => { env[k] = v; },
    deleteEnvVar: (k) => { delete env[k]; },
  };
}

function fakeReq(name, headers = {}) {
  const h = { ...headers };
  return {
    headers: h,
    getName: () => name,
    getHeaders: () => h,
    setHeader: (k, v) => { h[k] = v; },
    deleteHeader: (k) => { delete h[k]; },
  };
}

const traceIdIn = (traceparent) => traceparent.split('-')[1];
const parentIdIn = (traceparent) => traceparent.split('-')[2];

describe('one trace per sale flow (library-bruno/traceContext.js)', () => {
  let logs;
  let bru;
  beforeEach(() => {
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((m) => logs.push(String(m)));
    bru = fakeBru();
    globalThis.bru = bru;   // validationLogger reads the logging level from it
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete globalThis.bru;
  });

  const send = (name, headers) => {
    const req = fakeReq(name, headers);
    BT.applyTraceContext(req, bru);
    return req.headers;
  };

  test('each offer search starts a trace that the sale\'s requests carry, each with its own parent-id', () => {
    const setUp = send('00. GET System Version Check');
    const sale = ['01. POST Get Offer', '02. POST Create Booking', '06. POST Obtaining Fulfillments from Booking', '10. POST Refund Offers'].map((n) => send(n));
    const again = send('01. POST Get Offer');
    const after = send('02. POST Create Booking');

    for (const h of [setUp, ...sale, again, after]) expect(h.traceparent).toMatch(TRACEPARENT);
    // The system information reads before the sale are a trace of their own.
    expect(traceIdIn(setUp.traceparent)).not.toBe(traceIdIn(sale[0].traceparent));
    expect(new Set(sale.map((h) => traceIdIn(h.traceparent))).size).toBe(1);
    expect(new Set(sale.map((h) => parentIdIn(h.traceparent))).size).toBe(sale.length);
    // A new offer search (loop-back, expiry sub-run, retry) starts a new trace.
    expect(traceIdIn(again.traceparent)).not.toBe(traceIdIn(sale[0].traceparent));
    expect(traceIdIn(after.traceparent)).toBe(traceIdIn(again.traceparent));
    // The run log says where each trace starts, with its id.
    const starts = logs.filter((l) => l.includes('🔗 Trace'));
    expect(starts).toHaveLength(3);
    expect(starts[1]).toContain(`Trace ${traceIdIn(sale[0].traceparent)} starts at 01. POST Get Offer`);
    expect(starts.every((l) => l.startsWith('[INFO]'))).toBe(true);
  });

  test('the trace id is the flow\'s UUID, which a tracestate template may name', () => {
    bru.setEnvVar(BT.SETTINGS_VAR, JSON.stringify(TC.runSettingsOf({ traceContext: { tracestate: 'processid={{uuid}},p={{parentId}}' } })));
    const h = send('01. POST Get Offer');
    const uuid = bru.env[BT.TRACE_VAR];
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(traceIdIn(h.traceparent)).toBe(uuid.split('-').join(''));
    expect(h.tracestate).toBe(`processid=${uuid},p=${parentIdIn(h.traceparent)}`);
    expect(TC.tracestateProblem(h.tracestate)).toBeNull();
  });

  test('Bruno may give the settings back as an object', () => {
    bru.setEnvVar(BT.SETTINGS_VAR, { send: true, flags: '00', tracestate: [['t', 'k=v']] });
    expect(send('01. POST Get Offer')).toEqual({ traceparent: expect.stringMatching(/-00$/), tracestate: 'k=v' });
  });

  test('a token request is OAuth, not OSDM: no trace, and no flow opened', () => {
    expect(send('Simulator Access Token')).toEqual({});
    expect(bru.env[BT.TRACE_VAR]).toBeUndefined();
    expect(BT.isTokenRequest('00. GET System Version Check')).toBe(false);
  });

  test('a standalone run (no settings) sends a sampled traceparent and no tracestate', () => {
    const h = send('01. POST Get Offer');
    expect(Object.keys(h)).toEqual(['traceparent']);
    expect(h.traceparent).toMatch(/-01$/);
  });

  test('settings that are not the runner\'s fall back to the defaults', () => {
    for (const raw of ['not json', '[1]', JSON.stringify({ tracestate: [['v', 'access_token']] })]) {
      expect(BT.settingsFrom(raw)).toEqual({ send: true, flags: '01', tracestate: [] });
    }
  });

  test('a framework that sends none: no header, and a dedicated one goes as it is', () => {
    bru.setEnvVar(BT.SETTINGS_VAR, JSON.stringify(TC.runSettingsOf({ traceContext: { send: false } })));
    expect(send('01. POST Get Offer')).toEqual({});
    expect(send('02. POST Create Booking', { traceparent: 'fixed' })).toEqual({ traceparent: 'fixed' });
    expect(bru.env[BT.TRACE_VAR]).toBeUndefined();
  });

  test('a dedicated traceparent of API Config is replaced, said once per run; a dedicated tracestate stays when the framework has none', () => {
    const first = send('01. POST Get Offer', { TraceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', tracestate: 'processid=abc' });
    const second = send('02. POST Create Booking', { traceparent: 'fixed' });
    expect(Object.keys(first).sort((a, b) => a.localeCompare(b))).toEqual(['traceparent', 'tracestate']);
    expect(first.traceparent).toMatch(TRACEPARENT);
    expect(first.tracestate).toBe('processid=abc');
    expect(second.traceparent).toMatch(TRACEPARENT);
    const warnings = logs.filter((l) => l.startsWith('[WARNING]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dedicated header traceparent of API Config is replaced');
  });

  test('the framework\'s tracestate replaces a dedicated one', () => {
    bru.setEnvVar(BT.SETTINGS_VAR, JSON.stringify(TC.runSettingsOf({ traceContext: { tracestate: 'processid={{uuid}}' } })));
    const h = send('01. POST Get Offer', { tracestate: 'processid=abc' });
    expect(h.tracestate).toBe(`processid=${bru.env[BT.TRACE_VAR]}`);
    expect(logs.find((l) => l.startsWith('[WARNING]'))).toContain('tracestate');
  });

  test('a request a script sends carries the sale\'s trace with a parent-id of its own', () => {
    const offer = send('01. POST Get Offer');
    const sent = BT.withTrace({ Accept: 'application/json', TRACEPARENT: 'copied' });
    expect(sent.Accept).toBe('application/json');
    expect(sent.TRACEPARENT).toBeUndefined();
    expect(traceIdIn(sent.traceparent)).toBe(traceIdIn(offer.traceparent));
    expect(parentIdIn(sent.traceparent)).not.toBe(parentIdIn(offer.traceparent));
  });

  test('a script-sent request with no sale open starts a trace without a log line', () => {
    const sent = BT.withTrace({});
    expect(sent.traceparent).toMatch(TRACEPARENT);
    expect(bru.env[BT.TRACE_VAR].split('-').join('')).toBe(traceIdIn(sent.traceparent));
    expect(logs).toEqual([]);
  });

  test('a trace never stops a script-sent request', () => {
    const broken = { getEnvVar: () => undefined };   // no setEnvVar
    expect(BT.withTrace({ Accept: 'application/json' }, broken)).toEqual({ Accept: 'application/json' });
  });

  test('parent-ids are 16 hex digits and never all zero; the flow start is the offer request only', () => {
    for (let i = 0; i < 200; i++) {
      const id = BT.newParentId();
      expect(id).toMatch(/^[89ab][0-9a-f]{15}$/);
    }
    expect(BT.isFlowStart(' 01. post get offer ')).toBe(true);
    for (const other of ['01b. POST Get Return Offer', '01c. POST Get Offer without Cards', '01d. POST Get Offer Individual', 'POST Offer-Req param chk', '']) {
      expect(BT.isFlowStart(other)).toBe(false);
    }
  });

  test('without node:crypto, ids still come out W3C-shaped and never twice', () => {
    jest.isolateModules(() => {
      jest.doMock('node:crypto', () => { throw new Error('no crypto in this sandbox'); });
      const isolated = require('../../../Bruno_Collection/library-bruno/traceContext.js');
      const ids = Array.from({ length: 50 }, () => isolated.newUuid());
      expect(new Set(ids).size).toBe(50);
      for (const id of ids) expect(TC.isTraceparent(`00-${isolated.traceIdOf(id)}-${isolated.newParentId()}-01`)).toBe(true);
    });
    jest.dontMock('node:crypto');
  });
});

// ── The page, the server and the collection give the same headers ───────────

describe('the collection fills in what the server parsed, as the server does', () => {
  test.each([
    {},
    { traceContext: { sampled: false } },
    { traceContext: { send: false } },
    { traceContext: { tracestate: 'processid={{uuid}}' } },
    { traceContext: { tracestate: 'a={{traceId}}, b@sys=x{{PARENTID}}y ,c=plain' } },
  ])('framework %j', (framework) => {
    const uuid = '0af76519-16cd-43dd-8448-eb211c80319c';
    const parentId = 'b7ad6b7169203331';
    const viaRun = BT.headersFor(BT.settingsFrom(JSON.stringify(TC.runSettingsOf(framework))), uuid, parentId);
    expect(viaRun).toEqual(TC.headersFor(TC.settingsOf(framework), uuid, parentId));
  });

  test('both hold the same placeholders', () => {
    const source = fs.readFileSync(path.join(LIB, 'traceContext.js'), 'utf8');
    expect(source).toContain(`const PLACEHOLDERS = new Set(${JSON.stringify(TC.PLACEHOLDERS).replaceAll('"', "'").replaceAll(',', ', ')});`);
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────

describe('wiring', () => {
  const collection = fs.readFileSync(path.join(LIB, '..', 'opencollection.yml'), 'utf8');
  const before = collection.slice(collection.indexOf('type: before-request'), collection.indexOf('type: after-response'));

  test('the collection sets the trace on every request it sends, after the dedicated headers', () => {
    const trace = before.indexOf('traceContext.js").applyTraceContext(req, bru)');
    expect(trace).toBeGreaterThan(before.indexOf('__extraHeaders'));
    expect(trace).toBeLessThan(before.indexOf('end RUNSCRIPT'));
    // The fixed SBB values are gone.
    expect(before).not.toMatch(/setHeader\('trace(parent|state)'/);
  });

  test('the flow is cleared at the scenario start only, never by the parser or the expiry sub-run', () => {
    const startList = before.slice(before.indexOf('const _deleteList'), before.indexOf('_deleteList.forEach'));
    expect(startList).toContain('"__traceUuid"');
    for (const file of ['scenarioParser.js', 'expiredFlow.js']) {
      expect(fs.readFileSync(path.join(LIB, file), 'utf8')).not.toContain('__traceUuid');
    }
  });

  test('every request a script sends to the provider carries the trace', () => {
    const offenders = [];
    for (const file of fs.readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(LIB, file), 'utf8');
      let at = source.indexOf('bru.sendRequest(');
      while (at >= 0) {
        const call = source.slice(at, at + 700);
        if (call.includes("getEnvVar('api_base')") || call.includes('getEnvVar("api_base")') || call.includes('tripsCollectionPath')) {
          if (!call.includes('withTrace(')) offenders.push(`${file} at ${at}`);
        }
        at = source.indexOf('bru.sendRequest(', at + 1);
      }
    }
    expect(offenders).toEqual([]);
    const preflight = fs.readFileSync(path.join(LIB, 'offers.js'), 'utf8');
    expect(preflight.slice(preflight.indexOf('function ensureAuthorizationOr403'), preflight.indexOf('bru.sendRequest({\n      url: resolvedUrl'))).toContain('withTrace(resolvedHeaders');
  });

  test('the Test Config page loads the shared module before scenarios.js', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'scenarios.html'), 'utf8');
    expect(page.indexOf('/js/trace-context.js')).toBeGreaterThan(0);
    expect(page.indexOf('/js/trace-context.js')).toBeLessThan(page.indexOf('/js/scenarios.js'));
  });
});

// ── The Test Framework page ─────────────────────────────────────────────────

describe('the Test Framework page (scenarios.js)', () => {
  const vm = require('node:vm');
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function page(framework) {
    const elements = {};
    const ctx = {
      OscarTraceContext: TC, esc,
      wizData: { framework },
      saved: 0, toasts: [],
      document: { getElementById: (id) => { elements[id] ||= { disabled: false, innerHTML: '' }; return elements[id]; } },
    };
    ctx.saveFrameworkDebounced = () => { ctx.saved += 1; };
    ctx.oscarToast = (m, kind) => ctx.toasts.push([kind, m]);
    for (const name of ['traceContextPanelHtml', 'traceContextPreviewHtml', 'refreshTraceContextPanel', 'changeTraceContext', 'inputTraceState']) {
      ctx[name] = lift(name, ctx);
    }
    return { ctx, elements };
  }

  test('the panel shows the stored settings, escaped, with labelled fields and a preview', () => {
    const { ctx } = page({});
    const html = ctx.traceContextPanelHtml({ traceContext: { sampled: false, tracestate: 'a="<x>"' } });
    expect(html).toContain('id="fw-trace-send" data-action="fw-trace-send" checked');
    expect(html).not.toMatch(/id="fw-trace-sampled"[^>]*checked/);
    expect(html).toContain('value="a=&quot;&lt;x&gt;&quot;"');
    for (const id of ['fw-trace-send', 'fw-trace-sampled', 'fw-trace-state']) expect(html).toContain(`for="${id}"`);
    expect(html).toContain('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    const off = ctx.traceContextPanelHtml({ traceContext: { send: false } });
    expect(off).toMatch(/id="fw-trace-state"[^>]*disabled/);
    expect(off).toContain('No trace header is sent.');
  });

  test('only what differs from the default is stored, and saved', () => {
    const { ctx, elements } = page({});
    const fw = ctx.wizData.framework;
    expect(ctx.changeTraceContext('fw-trace-sampled', { checked: false })).toBe(true);
    expect(fw.traceContext).toEqual({ sampled: false });
    ctx.changeTraceContext('fw-trace-state', { value: '  processid={{uuid}} ' });
    expect(fw.traceContext).toEqual({ sampled: false, tracestate: 'processid={{uuid}}' });
    ctx.changeTraceContext('fw-trace-send', { checked: false });
    expect(elements['fw-trace-state'].disabled).toBe(true);
    ctx.changeTraceContext('fw-trace-send', { checked: true });
    ctx.changeTraceContext('fw-trace-sampled', { checked: true });
    ctx.changeTraceContext('fw-trace-state', { value: '' });
    expect('traceContext' in fw).toBe(false);
    expect(ctx.saved).toBe(6);
    expect(ctx.changeTraceContext('fw-other', { value: 'x' })).toBe(false);
  });

  test('a tracestate the server would refuse is not stored: it is said, and shown', () => {
    const { ctx, elements } = page({ traceContext: { tracestate: 'processid={{uuid}}' } });
    ctx.changeTraceContext('fw-trace-state', { value: 'processid = {{uid}}' });
    expect(ctx.wizData.framework.traceContext).toEqual({ tracestate: 'processid={{uuid}}' });
    expect(ctx.saved).toBe(0);
    expect(ctx.toasts[0][0]).toBe('error');
    expect(elements['fw-trace-preview'].innerHTML).toContain('This tracestate is not saved.');
  });

  test('the preview follows the typing, without storing it', () => {
    const { ctx, elements } = page({});
    expect(ctx.inputTraceState('fw-trace-state', { value: 'k=<b>{{traceId}}' })).toBe(true);
    expect(elements['fw-trace-preview'].innerHTML).toContain('tracestate: k=&lt;b&gt;4bf92f3577b34da6a3ce929d0e0e4736');
    expect('traceContext' in ctx.wizData.framework).toBe(false);
  });

  test('the section is drawn, and its handlers wired before the switches', () => {
    const source = lines.join('\n');
    expect(source).toContain('${traceContextPanelHtml(fw)}');
    expect(source).toContain('|| changeTraceContext(action, el)) return;');
    expect(source).toContain('  if (inputTraceState(action, el)) return;');
    expect(source.split('\n')[0]).toContain('OscarTraceContext');
  });
});
