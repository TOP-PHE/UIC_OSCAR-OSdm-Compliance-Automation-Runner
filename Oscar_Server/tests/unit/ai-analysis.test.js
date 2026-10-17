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
