// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801 PR 3: what the AI analysis sends (utils/aiAnalysis.js), how its answer
 * is read, and the page's drawing of both (public/js/ai-analysis.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AN = require('../../src/utils/aiAnalysis');
const { esc } = require('../../public/js/esc');

const rec = (over = {}) => ({ runId: 'r1', scenarioCode: 'OTST_SALE_1ADT', step: '02. POST Booking', check: 'status is 201',
  error: null, status: 400, problemCode: 'urn:uic:problem:MISSING_INFORMATION', problemTitle: 'Purchaser Jane Doe is missing',
  problemDetail: 'jane.doe@example.com', ...over });
const batch = (batchId, records, over = {}) => ({ batchId, runs: 3, finishedRuns: 3, records, truncated: false, ...over });

describe('#801 PR 3 what is sent', () => {
  test('a check and its error lose the values the run met; the problem title and detail are never sent', () => {
    const records = [rec({ check: 'booking "BK-12345678abc" priced 12.50 EUR', error: "expected 'Jane Doe' to equal 'John Smith'" })];
    const { input, text } = AN.buildInput({ batches: [batch('b1', records)], framework: null, findings: [], scenarios: [] });
    expect(input.failures[0].check).toBe('booking "…" priced N EUR');
    expect(input.failures[0].error).toBe("expected '…' to equal '…'");
    expect(input.failures[0].problemCode).toBe('MISSING_INFORMATION');
    for (const secret of ['Jane', 'John', 'jane.doe', 'BK-12345678abc', 'Purchaser']) expect(text).not.toContain(secret);
  });

  test('groups count the failures and their scenarios, the most frequent first', () => {
    const records = [rec(), rec({ runId: 'r2', scenarioCode: 'OTST_B' }), rec({ step: '01. POST Get Offer', check: 'offers exist', status: 200 })];
    const groups = AN.groupsOf(records);
    expect(groups.map(g => g.failures)).toEqual([2, 1]);
    expect(groups[0].scenarios).toEqual(['OTST_SALE_1ADT', 'OTST_B']);
  });

  test('the framework without OSCAR\'s own keys, findings as title / category / step / scenario, scenario descriptions', () => {
    const { input } = AN.buildInput({
      batches: [batch('b1', [rec()])],
      framework: { osdmVersion: '3.8', salesFlows: ['SALE'], _salesFlowsMigratedAt: 'x' },
      findings: [{ title: 'Purchaser required', category: 'provider_deviation', severity: 'minor', status: 'open', step: 'POST Booking', scenarioCode: 'OTST_SALE_1ADT', observed: 'secret evidence', evidence: 'body' }],
      scenarios: [{ code: 'OTST_SALE_1ADT', description: 'A sale for one adult' }, { code: 'OTHER', description: 'not named' }],
    });
    expect(input.testFramework).toEqual({ osdmVersion: '3.8', salesFlows: ['SALE'] });
    expect(input.findings).toEqual([{ title: 'Purchaser required', category: 'provider_deviation', severity: 'minor', status: 'open', step: 'POST Booking', scenario: 'OTST_SALE_1ADT' }]);
    expect(input.scenarios).toEqual([{ code: 'OTST_SALE_1ADT', description: 'A sale for one adult' }]);
  });

  test('two batches: OSCAR sorts the groups into fixed, still failing and new', () => {
    const a = [rec(), rec({ step: '06. POST Fulfillments', check: 'fulfilled' })];
    const b = [rec(), rec({ step: '10. POST Refund Offers', check: 'refund offered' })];
    const { input, counts } = AN.buildInput({ batches: [batch('a', a), batch('b', b)], framework: null, findings: [], scenarios: [] });
    expect(input.mode).toBe('compare');
    expect(input.comparison.fixed.map(g => g.step)).toEqual(['06. POST Fulfillments']);
    expect(input.comparison.stillFailing.map(g => g.step)).toEqual(['02. POST Booking']);
    expect(input.comparison.new.map(g => g.step)).toEqual(['10. POST Refund Offers']);
    expect(counts).toEqual({ fixed: 1, stillFailing: 1, new: 1 });
    expect(input.failures).toBeUndefined();
  });

  test('too large for the model: summarised by step, and said so', () => {
    const records = [];
    for (let i = 0; i < 3000; i++) records.push(rec({ check: `check about field${'x'.repeat(i % 50)} ${String.fromCharCode(65 + (i % 26))}${i}`, scenarioCode: `S${i}` }));
    const built = AN.buildInput({ batches: [batch('b1', records)], framework: null, findings: [], scenarios: [] });
    expect(built.summarisedByStep).toBe(true);
    expect(built.input.failures[0]).toMatchObject({ step: '02. POST Booking', status: 400 });
    expect(built.input.failures[0].scenarios.length).toBeLessThanOrEqual(10);
    expect(built.chars).toBeLessThan(AN.MAX_INPUT_CHARS);
  });

  test('tokens are estimated at four characters each; the hash covers the instructions and the input', () => {
    expect(AN.estimateTokens('x'.repeat(10))).toBe(3);
    expect(AN.inputHash('a', 'b')).not.toBe(AN.inputHash('a', 'c'));
    expect(AN.inputHash('a', 'b')).not.toBe(AN.inputHash('ab', ''));
  });

  test('the instructions ask for the chosen language, the company\'s instruction and the comparison only when comparing', () => {
    expect(AN.systemPrompt({ language: 'French' })).toContain('Answer in French');
    expect(AN.systemPrompt({ language: 'Klingon' })).toContain('Answer in English');
    expect(AN.systemPrompt({ instruction: 'Be short.' })).toContain('The company adds this instruction:\nBe short.');
    expect(AN.systemPrompt({ compare: true })).toContain('OSCAR has already sorted the groups');
    expect(AN.systemPrompt({})).toContain('leave "comparison" out');
  });
});

describe('#801 PR 3 reading the answer', () => {
  const answer = { summary: 'Two problems.', groups: [{ title: 'Purchaser', cause: 'Missing', owner: 'provider', why: 'A 400', steps: ['02'], scenarios: ['S1'] },
    { title: 'Other', cause: 'x', owner: 'someone' }], comparison: { fixed: ['a'], stillFailing: ['b'], new: [] } };

  test('JSON alone, in a code fence or after prose is read; an unknown owner reads as unclear', () => {
    for (const text of [JSON.stringify(answer), '```json\n' + JSON.stringify(answer) + '\n```', 'Here it is: ' + JSON.stringify(answer)]) {
      const r = AN.readResult(text, { compare: true });
      expect(r.ok).toBe(true);
      expect(r.result.groups[1].owner).toBe('unclear');
      expect(r.result.comparison).toEqual({ fixed: ['a'], stillFailing: ['b'], new: [] });
    }
  });

  test('a comparison is kept only when comparing; no summary or no JSON is refused', () => {
    expect(AN.readResult(JSON.stringify(answer)).result.comparison).toBeUndefined();
    expect(AN.readResult('{"groups": []}')).toEqual({ ok: false, reason: 'The answer has no summary.' });
    expect(AN.readResult('No idea.')).toEqual({ ok: false, reason: 'The answer is not a JSON object.' });
    expect(AN.readResult('[1, 2]').ok).toBe(false);
  });

  test('texts are cut to size and non-text list members dropped', () => {
    const r = AN.readResult(JSON.stringify({ summary: 'x'.repeat(5000), groups: [{ title: 't', steps: ['a', 3, null] }] }));
    expect(r.result.summary).toHaveLength(4001);
    expect(r.result.groups[0].steps).toEqual(['a']);
  });
});

describe('#801 PR 3 the page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL|FIELD|WIDE|OWNER_LABEL|OWNER_STYLE|STATUS_LABEL) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  const names = ['analysisPanelHtml', 'batchLabel', 'batchOptionsHtml', 'previewHtml', 'listHtml', 'groupRowHtml', 'comparisonHtml', 'resultHtml', 'historyHtml'];
  vm.runInContext(`${consts}\n${names.map(lift).join('\n')}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);

  test('the panel lists the configured targets, escaped, with labelled fields', () => {
    const html = ctx.analysisPanelHtml([{ id: 'own', name: 'Acme <b>', provider: false }, { id: 'p1', name: 'Beta', provider: true }]);
    expect(html).toContain('Acme &lt;b&gt;');
    expect(html).toContain('<option value="p1" data-provider="1">');
    for (const id of ['ai-an-target', 'ai-an-a', 'ai-an-b', 'ai-an-lang']) expect(html).toContain(`<label for="${id}"`);
    expect(ctx.analysisPanelHtml([])).toBe('');
  });

  test('the preview shows the counts, the size, the monthly use and exactly what is sent, escaped', () => {
    const p = { mode: 'compare', counts: { fixed: 1, stillFailing: 2, new: 3 }, estimatedTokens: 1200, chars: 4800, model: 'claude-opus-5-5',
      monthly: { cap: 100000, used: 500 }, summarisedByStep: true, batches: [{ truncated: true }], instructions: 'Say <x>', input: '{"a":"<b>"}', tooLarge: false };
    const html = ctx.previewHtml(p);
    expect(html).toContain('1 problem(s) fixed, 2 still failing, 3 new');
    expect(html).toContain('About <strong>1200</strong> tokens (4800 characters) to claude-opus-5-5');
    expect(html).toContain('500 of your 100000 tokens used this month');
    expect(html).toContain('summarised by step');
    expect(html).toContain('only the first ones are sent');
    expect(html).toContain('Say &lt;x&gt;');
    expect(html).toContain('{&quot;a&quot;:&quot;&lt;b&gt;&quot;}');
    expect(html).toContain('data-ai-action="an-run"');
    expect(ctx.previewHtml({ ...p, tooLarge: true })).not.toContain('data-ai-action="an-run"');
  });

  test('a result: the opinion warning, the summary, the comparison and each group with its owner, escaped', () => {
    const html = ctx.resultHtml({ status: 'done', createdAt: 't', by: 'tm@x', model: 'm', mode: 'compare', tokens: { input: 10, output: 5 },
      result: { summary: 'Sum <i>', comparison: { fixed: ['f'], stillFailing: [], new: ['n'] },
        groups: [{ title: 'T <b>', cause: 'C', owner: 'oscar', why: 'W', steps: ['02'], scenarios: ['S1'] }] } });
    expect(html).toContain('An AI opinion');
    expect(html).toContain('Sum &lt;i&gt;');
    expect(html).toContain('<strong>T &lt;b&gt;</strong>');
    expect(html).toContain('>OSCAR</span>');
    expect(html).toContain('Steps: 02<br>Scenarios: S1');
    expect(html).toContain('Tokens: 10 in, 5 out.');
  });

  test('running, failed, interrupted and unreadable answers say so', () => {
    const base = { createdAt: 't', model: 'm', mode: 'one' };
    expect(ctx.resultHtml({ ...base, status: 'running' })).toContain('is reading the results');
    expect(ctx.resultHtml({ ...base, status: 'failed', error: 'HTTP <401>' })).toContain('HTTP &lt;401&gt;');
    expect(ctx.resultHtml({ ...base, status: 'interrupted' })).toContain('the server restarted');
    expect(ctx.resultHtml({ ...base, status: 'unreadable', error: 'no summary', result: { raw: '<p>' } })).toContain('&lt;p&gt;');
  });

  test('the history lists each analysis with a Show button', () => {
    expect(ctx.historyHtml([])).toContain('None yet');
    const html = ctx.historyHtml([{ id: 'a<1', createdAt: 't', by: 'tm', mode: 'one', model: 'm', status: 'unreadable' }]);
    expect(html).toContain('data-id="a&lt;1"');
    expect(html).toContain('Answer not readable');
  });

  test('every analysis request names the company or provider of the card', () => {
    for (const url of ['/v1/company/ai-analysis/batches', '/v1/company/ai-analysis/history', '/v1/company/ai-analysis/preview', '/v1/company/ai-analysis/run']) {
      const line = lines.find(l => l.includes(`fetch('${url}'`));
      expect(line).toContain('analysisHeaders(');
    }
  });
});

describe('#827 PR A the provider\'s context', () => {
  const catalogue = [{ code: 'OTST_SALE_ONE_WAY_1ADT', purpose: 'One-way sale for one adult.' },
    { code: 'OTST_SALE', purpose: 'too short a prefix: never chosen over a longer one' },
    { code: 'NHF_SALE_DEPARTURE_IN_PAST', purpose: 'A past departure is refused.' }];

  test('a copy of a reference scenario gets its purpose: same code, else the longest code it extends with "_"', () => {
    expect(AN.catalogueEntryOf('OTST_SALE_ONE_WAY_1ADT', catalogue).purpose).toBe('One-way sale for one adult.');
    expect(AN.catalogueEntryOf('OTST_SALE_ONE_WAY_1ADT_SPEC', catalogue).code).toBe('OTST_SALE_ONE_WAY_1ADT');
    expect(AN.catalogueEntryOf('OTST_SALE_ONE_WAY_1ADTX', catalogue).code).toBe('OTST_SALE');
    expect(AN.catalogueEntryOf('MY_OWN', catalogue)).toBeNull();
    const { input } = AN.buildInput({ batches: [batch('b1', [rec({ scenarioCode: 'NHF_SALE_DEPARTURE_IN_PAST_SPEC' }), rec({ scenarioCode: 'MINE', step: 'x' })])],
      framework: null, findings: [], scenarios: [{ code: 'MINE', description: 'mine' }], catalogue });
    expect(input.scenarios).toEqual([{ code: 'MINE', description: 'mine' },
      { code: 'NHF_SALE_DEPARTURE_IN_PAST_SPEC', description: null, purpose: 'A past departure is refused.' }]);
  });

  test('the declared OSDM version and the checklist go in the input, and the version in the instructions', () => {
    const checklist = { answers: { 'info.pastDeparture': ['SOLD'] }, cut: 2 };
    const { input } = AN.buildInput({ batches: [batch('b1', [rec()])], framework: { osdmVersion: '3.6' }, findings: [], scenarios: [], checklist });
    expect(input.provider).toEqual({ declaredOsdmVersion: '3.6', checklist: { 'info.pastDeparture': ['SOLD'] }, checklistAnswersLeftOut: 2 });
    const none = AN.buildInput({ batches: [batch('b1', [rec()])], framework: null, findings: [], scenarios: [] }).input;
    expect(none.provider).toEqual({ declaredOsdmVersion: null, checklist: null });
    expect(AN.systemPrompt({ osdmVersion: '3.6' })).toContain('The provider declares OSDM 3.6: judge every request and answer against OSDM 3.6');
    expect(AN.systemPrompt({})).toContain('declares no OSDM version');
    expect(AN.systemPrompt({})).toContain('provider.checklist');
  });

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('function checklistHtml('));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  const ctx = vm.createContext({ esc });
  vm.runInContext(`${lines.filter((l) => /^const (FIELD|WIDE) =/.test(l)).join('\n')}\n${lines.slice(start, end + 1).join('\n')}\nthis.checklistHtml = checklistHtml;`, ctx);

  test('the page says what is imported and what the model is told, escaped, with a labelled file field', () => {
    const none = ctx.checklistHtml(null);
    expect(none).toContain('no checklist imported');
    expect(none).toContain('<label for="ai-an-checklist-file"');
    const html = ctx.checklistHtml({ fileName: 'a<b>.docx', answers: 264, importedAt: 't', importedBy: 'tm@x', cut: 3, sent: { 'info.x': '<y>' } });
    expect(html).toContain('a&lt;b&gt;.docx');
    expect(html).toContain('264 answers');
    expect(html).toContain('3 left out for size');
    expect(html).toContain('&lt;y&gt;');
    expect(html).toContain('data-ai-action="an-checklist-remove"');
  });

  test('the checklist requests name the company or provider of the card', () => {
    const fetches = lines.filter((l) => l.includes("fetch('/v1/company/ai-analysis/checklist'"));
    expect(fetches).toHaveLength(3);
    for (const line of fetches) expect(line).toContain('analysisHeaders(');
  });
});

describe('#827 PR C questioning the test', () => {
  const recs = [rec({ requestId: 11 }), rec({ requestId: 12, runId: 'r2' }), rec({ requestId: 13, step: '06. POST Fulfillments', check: 'fulfilled', status: 500 })];

  test('each group gets the masked sample of one of its requests; the request id is never sent', () => {
    const asked = [];
    const sampleOf = (id) => { asked.push(id); return id === 11 ? { request: { offers: [{ offerId: 'O1' }] }, response: { problems: [{ code: 'X', title: '<masked>' }] } } : null; };
    const { input, text } = AN.buildInput({ batches: [batch('b', recs)], framework: null, findings: [], scenarios: [], sampleOf });
    expect(asked).toEqual([11, 13]);
    expect(input.failures[0].sample).toEqual({ request: { offers: [{ offerId: 'O1' }] }, response: { problems: [{ code: 'X', title: '<masked>' }] } });
    expect(input.failures[1].sample).toBeUndefined();
    expect(text).not.toContain('requestId');
  });

  test('at most 15 samples, the most failing groups first; none when summarised by step', () => {
    const many = Array.from({ length: 20 }, (_, i) => rec({ requestId: i, step: `s${i}`, check: `c${i}` }));
    let calls = 0;
    const { input } = AN.buildInput({ batches: [batch('b', many)], framework: null, findings: [], scenarios: [], sampleOf: () => { calls++; return { request: {}, response: {} }; } });
    expect(calls).toBe(15);
    expect(input.failures.filter((g) => g.sample)).toHaveLength(15);
    expect(AN.byStep([{ step: 'a', status: 1, failures: 1, scenarios: [], sample: { x: 1 } }])[0].sample).toBeUndefined();
  });

  test('the answer may give a group to the configuration and propose an action; the instructions allow questioning a check', () => {
    const r = AN.readResult(JSON.stringify({ summary: 's', groups: [{ title: 'T', cause: 'C', owner: 'configuration', action: 'Untick IDEMPOTENCY.' }, { title: 'U', owner: 'nobody' }] }));
    expect(r.result.groups[0]).toMatchObject({ owner: 'configuration', action: 'Untick IDEMPOTENCY.' });
    expect(r.result.groups[1]).toMatchObject({ owner: 'unclear', action: '' });
    const prompt = AN.systemPrompt({});
    expect(prompt).toContain('the configuration\'s');
    expect(prompt).toContain('You may question a check itself');
    expect(prompt).toContain('"owner": "provider | oscar | configuration | unclear"');
    expect(prompt).toContain('"action"');
  });

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const ctx = vm.createContext({ esc });
  const consts = lines.filter((l) => /^const (CELL|OWNER_LABEL|OWNER_STYLE) =/.test(l)).join('\n');
  vm.runInContext(`${consts}\n${lift('groupRowHtml')}\n${lift('issueText')}\nthis.groupRowHtml = groupRowHtml; this.issueText = issueText;`, ctx);

  test('the page shows the configuration owner and the action, and offers an OSCAR issue only for OSCAR\'s groups', () => {
    const conf = ctx.groupRowHtml({ title: 'T', cause: 'C', owner: 'configuration', action: 'Untick <x>' }, 0);
    expect(conf).toContain('>Configuration</span>');
    expect(conf).toContain('<strong>Next:</strong> Untick &lt;x&gt;');
    expect(conf).not.toContain('an-copy-issue');
    const oscar = ctx.groupRowHtml({ title: 'T', cause: 'C', owner: 'oscar' }, 3);
    expect(oscar).toContain('data-ai-action="an-copy-issue" data-group="3"');
  });

  test('the issue text names the group, the model, the analysis and that it is an opinion', () => {
    const text = ctx.issueText({ title: 'Check expects X', cause: 'OSDM 3.6 makes it optional.', why: 'Extract', action: 'Fix the check', steps: ['07. GET Booking'], scenarios: ['S1', 'S2'] },
      { model: 'claude-sonnet-5-5', createdAt: '2026-10-18', id: 'a1' });
    expect(text).toBe('## Check expects X\n\nOSDM 3.6 makes it optional.\n\n**Why OSCAR:** Extract\n\n**Next:** Fix the check\n\n**Steps:** 07. GET Booking\n**Scenarios:** S1, S2\n\n'
      + '_From an AI analysis (claude-sonnet-5-5, 2026-10-18, id a1). An AI opinion, to be checked before acting on it._\n');
  });
});
