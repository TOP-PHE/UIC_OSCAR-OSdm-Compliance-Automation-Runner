// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #867: an AI analysis's groups as one Markdown file, each with the failing
 * requests that belong to it (utils/aiAnalysisDownload.js), and the page's
 * button (lifted out of ai-analysis.js by text and run in a vm).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DL = require('../../src/utils/aiAnalysisDownload');
const { esc } = require('../../public/js/esc');

const row = (over = {}) => ({ requestId: 1, runId: 'run-1', batchId: 'b1', scenarioCode: 'OTST_A', step: '02. POST Booking',
  method: 'POST', url: 'https://api.provider.example/osdm/bookings', status: 400, failedChecks: ['status is 201'], ...over });

describe('#867 what is written of an address and a body', () => {
  test('an address keeps its path and query, never its host, and no credential in the query', () => {
    expect(DL.pathOf('https://api.provider.example:8443/osdm/bookings/B1?embed=ALL&access_token=t0k&apiKey=k&x=1'))
      .toBe('/osdm/bookings/B1?embed=ALL&access_token=<removed>&apiKey=<removed>&x=1');
    expect(DL.pathOf('{{api_base}}/offers')).toBe('/offers');
    expect(DL.pathOf('/places?client_secret=s')).toBe('/places?client_secret=<removed>');
    expect(DL.pathOf('//other.example/x')).toBe('/x');
    expect(DL.pathOf('')).toBe('');
    expect(DL.hostsOf(['https://API.provider.example/a', 'not a url', null, 'https://api.provider.example/b'])).toEqual(['api.provider.example']);
  });

  test('a JSON body is indented, its credentials removed, the host replaced; personal data is kept', () => {
    const body = DL.bodyText(JSON.stringify({ passengers: [{ firstName: 'Marie', detail: { access_token: 'abc', Requestor: 'r' } }],
      _links: { self: 'https://API.Provider.example/bookings/1' } }), ['api.provider.example']);
    expect(body.json).toBe(true);
    expect(body.text).toContain('\n  "passengers": [');
    expect(body.text).toContain('"firstName": "Marie"');
    expect(body.text).toContain('"access_token": "<removed>"');
    expect(body.text).toContain('"Requestor": "<removed>"');
    expect(body.text).toContain('"self": "https://<host>/bookings/1"');
    expect(body.text.toLowerCase()).not.toContain('provider.example');
    expect(DL.bodyText('<html>api.provider.example</html>', ['api.provider.example'])).toMatchObject({ json: false, text: '<html><host></html>' });
    expect(DL.bodyText(null)).toBeNull();
    expect(DL.bodyText('')).toBeNull();
  });

  test('a body over 20 KB is cut and says how long it was', () => {
    const body = DL.bodyText('x'.repeat(DL.MAX_BODY_CHARS + 10));
    expect(body).toMatchObject({ cut: true, chars: DL.MAX_BODY_CHARS + 10 });
    expect(body.text).toHaveLength(DL.MAX_BODY_CHARS);
  });

  test('a fence is longer than any backtick run of the body, so a body cannot close it', () => {
    expect(DL.fenced('a', 'json')).toBe('```json\na\n```');
    const block = DL.fenced('one ``` two ````` three');
    expect(block.startsWith('``````\n')).toBe(true);
    expect(block.endsWith('\n``````')).toBe(true);
    expect(DL.inlineCode('a`b')).toBe('`` a`b ``');
  });

  test('a deep body is read without recursion', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    expect(() => DL.bodyText(deep)).not.toThrow();
  });

  test('the file name is the date and the company, in plain characters', () => {
    expect(DL.fileNameOf('2026-10-19T08:00:00.000Z', 'Alpha <Rail> & Co')).toBe('oscar-analysis-2026-10-19-alpha-rail-co.md');
    expect(DL.fileNameOf('x', '')).toBe('oscar-analysis-undated-company.md');
  });
});

describe('#867 which requests belong to a group', () => {
  const group = { steps: ['02. POST Booking'], scenarios: ['OTST_A', 'OTST_B'] };

  test('the first of each run and step, at most three, the others counted', () => {
    const rows = [
      row({ requestId: 1, runId: 'r1' }), row({ requestId: 2, runId: 'r1' }),   // the same run and step: once
      row({ requestId: 3, runId: 'r2' }), row({ requestId: 4, runId: 'r3', scenarioCode: 'OTST_B' }),
      row({ requestId: 5, runId: 'r4' }), row({ requestId: 6, runId: 'r5' }),
      row({ requestId: 7, runId: 'r6', step: '06. POST Fulfillment' }), row({ requestId: 8, runId: 'r7', scenarioCode: 'OTST_C' }),
    ];
    const { chosen, leftOut, matches } = DL.requestsOfGroup(group, rows, ['b1']);
    expect(chosen.map((r) => r.requestId)).toEqual([1, 3, 4]);
    expect(leftOut).toBe(2);
    expect(matches).toBe(5);
  });

  test('a step shortened for the model still matches; no steps = every step; nothing named = none', () => {
    const rows = [row({ requestId: 1, step: '14b. GET Booking Refund Receipt' }), row({ requestId: 2, step: '07. GET Booking' })];
    expect(DL.requestsOfGroup({ steps: ['14b. GET Booking Ref…'], scenarios: [] }, rows).chosen.map((r) => r.requestId)).toEqual([1]);
    expect(DL.requestsOfGroup({ steps: [], scenarios: ['OTST_A'] }, rows).chosen.map((r) => r.requestId)).toEqual([1, 2]);
    expect(DL.requestsOfGroup({ steps: [], scenarios: [] }, rows)).toEqual({ chosen: [], leftOut: 0, matches: 0 });
    expect(DL.requestsOfGroup({ steps: ['…'], scenarios: [] }, rows).chosen).toEqual([]);
  });

  test('two batches compared: the later batch first', () => {
    const rows = [row({ requestId: 1, runId: 'r1', batchId: 'early' }), row({ requestId: 2, runId: 'r2', batchId: 'late' })];
    expect(DL.requestsOfGroup(group, rows, ['early', 'late']).chosen.map((r) => r.requestId)).toEqual([2, 1]);
  });
});

describe('#867 the file', () => {
  const analysis = {
    id: 'a-1', model: 'claude-opus-5-5', createdAt: '2026-10-19 08:00:00', by: 'tm@x.com', batches: ['b1'],
    result: { summary: 'Two problems.', groups: [
      { title: 'Purchaser refused', cause: 'The provider asks a purchaser.', owner: 'provider', why: 'A 400 at booking.',
        action: 'The provider says why.', steps: ['02. POST Booking'], scenarios: ['OTST_A'] },
      { title: 'Nothing matches', cause: 'c', owner: 'odd', why: '', action: '', steps: ['99. Nowhere'], scenarios: [] },
    ] },
  };
  const bodies = { 1: { request: '{"offers":[{"offerId":"O-1"}]}', response: 'plain ```` text' } };

  test('each group as shown on the page, then its requests with bodies in fenced blocks', () => {
    const rows = [row({ requestId: 1 }), row({ requestId: 2, runId: 'r2' })];
    const file = DL.buildMarkdown({ analysis, company: 'Alpha', rows, bodyOf: (id) => bodies[id] || null, hosts: ['api.provider.example'], now: '2026-10-19T09:00:00Z' });
    const t = file.text;
    expect(t).toContain('## 1. Purchaser refused');
    expect(t).toContain('- **Owner:** Provider');
    expect(t).toContain('- **Explanation:** The provider asks a purchaser.');
    expect(t).toContain('- **Evidence:** A 400 at booking.');
    expect(t).toContain('- **Next step:** The provider says why.');
    expect(t).toContain('- **Steps:** 02. POST Booking');
    expect(t).toContain('#### 1.1 OTST_A — 02. POST Booking');
    expect(t).toContain('**Request:** ` POST /osdm/bookings `');
    expect(t).toContain('```json\n{\n  "offers": [');
    expect(t).toContain('**Response:** HTTP 400');
    expect(t).toContain('`````\nplain ```` text\n`````');
    expect(t).toContain('  - status is 201');
    expect(t).toContain('#### 1.2 OTST_A — 02. POST Booking');
    expect(t).toContain('**Request body:** none stored.');
    expect(t).toContain('## 2. Nothing matches');
    expect(t).toContain('- **Owner:** Unclear');
    expect(t).toContain('No failing request of the batch matches');
    expect(t).not.toContain('provider.example');
    expect(file).toMatchObject({ requests: 2, leftOut: 0, stopped: false });
  });

  test('checks and bodies are asked for the requests written only', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ requestId: n, runId: `r${n}`, failedChecks: undefined }));
    const asked = [];
    const file = DL.buildMarkdown({ analysis, company: 'A', rows, now: 'n', bodyOf: (id) => { asked.push(id); return null; }, checksOf: () => ['c'] });
    expect(asked).toEqual([1, 2, 3]);
    expect(file.leftOut).toBe(2);
    expect(file.text).toContain('_2 more failing request(s) of this group left out: the first of each run and step is shown, at most 3._');
  });

  test('the file stops adding requests at its size limit and says so', () => {
    const big = { request: 'y'.repeat(DL.MAX_BODY_CHARS), response: 'z'.repeat(DL.MAX_BODY_CHARS) };
    const many = { ...analysis, result: { summary: 's', groups: Array.from({ length: 120 }, (_, i) => ({ title: `G${i}`, owner: 'oscar', steps: [], scenarios: [`S${i}`] })) } };
    const rows = [];
    for (let i = 0; i < 120; i++) for (let k = 0; k < 3; k++) rows.push(row({ requestId: i * 10 + k, runId: `r${i}-${k}`, scenarioCode: `S${i}` }));
    const file = DL.buildMarkdown({ analysis: many, company: 'A', rows, now: 'n', bodyOf: () => big });
    expect(file.stopped).toBe(true);
    expect(file.text.length).toBeLessThanOrEqual(DL.MAX_FILE_CHARS + 50_000);
    expect(file.text).toContain('_The file reached its size limit');
    expect(file.requests + file.leftOut).toBe(360);
    expect(file.text).toContain('## 120. G119');
  });
});

describe('#867 the page', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lift = (name) => {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = src.split('\n').filter((l) => /^const ANALYSIS_ID =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  vm.runInContext(`${consts}\n${lift('analysisIdOf')}\n${lift('downloadButtonHtml')}\n${lift('downloadName')}
this.analysisIdOf = analysisIdOf; this.downloadButtonHtml = downloadButtonHtml; this.downloadName = downloadName;`, ctx);

  test('the button names a valid analysis id only, and says the bodies are not masked', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const html = ctx.downloadButtonHtml({ id });
    expect(html).toContain(`data-ai-action="an-download" data-id="${id}"`);
    expect(html).toContain('⬇ Download the findings with requests and responses');
    expect(html).toContain('not masked');
    expect(ctx.downloadButtonHtml({ id: '"><img src=x>' })).toBe('');
    expect(ctx.analysisIdOf('../x')).toBeNull();
  });

  test('the file name kept is a plain one', () => {
    expect(ctx.downloadName('attachment; filename="oscar-analysis-2026-10-19-alpha.md"')).toBe('oscar-analysis-2026-10-19-alpha.md');
    expect(ctx.downloadName('attachment; filename="../x y.md"')).toBe('oscar-analysis.md');
  });

  test('the done analysis shows it; the click fetches through the page\'s fetch with the target header', () => {
    expect(src).toContain('${downloadButtonHtml(a)}');
    const dl = lift('downloadAnalysis');
    expect(dl).toContain("'/download', { headers: analysisHeaders() }");
    expect(dl).toContain('const id = analysisIdOf(value);');
    expect(src).toContain("else if (act === 'an-download') job = downloadAnalysis(el.dataset.id);");
  });
});
