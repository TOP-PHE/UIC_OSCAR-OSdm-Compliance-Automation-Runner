// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #831: the models OSCAR knows and their prices (utils/aiModels.js), and the
 * page's model list, cost, side-by-side and spend (public/js/ai-analysis.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../../src/utils/aiModels');
const C = require('../../src/utils/aiConfig');
const { esc } = require('../../public/js/esc');

describe('#831 prices and costs', () => {
  test('a listed model, a dated id of it, a custom price only for a model not listed', () => {
    expect(M.priceOf('claude-opus-5-5')).toEqual({ input: 4, output: 20, source: 'list' });
    expect(M.priceOf('claude-opus-5-5-20261001')).toMatchObject({ input: 4, output: 20 });
    expect(M.priceOf('claude-opus-5-20260601')).toMatchObject({ input: 5 });   // the longest id it starts with
    expect(M.priceOf('claude-opus-5-5', { input: 1, output: 1 }).source).toBe('list');
    expect(M.priceOf('gpt-4o', { input: 2.5, output: 10 })).toEqual({ input: 2.5, output: 10, source: 'custom' });
    expect(M.priceOf('gpt-4o')).toBeNull();
    expect(M.priceOf('gpt-4o', { input: 2.5, output: null })).toBeNull();
    expect(M.priceOf(null)).toBeNull();
  });

  test('a cost is tokens × price per million; Haiku 5.5 is at its second rate above 100K input tokens', () => {
    expect(M.costOf(M.priceOf('claude-opus-5-5'), { input: 1200, output: 300 })).toBe(0.0108);
    expect(M.costOf(M.priceOf('claude-haiku-5-5'), { input: 100_000, output: 1000 })).toBe(0.0105);
    expect(M.costOf(M.priceOf('claude-haiku-5-5'), { input: 100_001, output: 1000 })).toBe(0.052501);   // 100,001 × 0.5 + 1000 × 2.5, rounded to the millionth
    expect(M.costOf(null, { input: 1, output: 1 })).toBeNull();
    expect(M.costOf(M.priceOf('claude-opus-5-5'), { input: null, output: null })).toBeNull();
    expect(M.costOf(M.priceOf('claude-opus-5-5'), { input: 1000, output: null })).toBe(0.004);
    expect(M.estimateOf(M.priceOf('claude-sonnet-5-5'), 50_000, 16_000)).toEqual({ input: 0.1, atMost: 0.26 });
    expect(M.estimateOf(null, 1, 1)).toBeNull();
  });

  test('the list for the page: the suggested model first, every one with its price', () => {
    const list = M.modelsForPage();
    expect(list[0].id).toBe('claude-opus-5-5');
    expect(list.map(m => m.id)).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']));
    expect(list.every(m => typeof m.input === 'number' && typeof m.output === 'number')).toBe(true);
    expect(list.find(m => m.id === 'claude-haiku-5-5').above).toEqual({ tokens: 100_000, input: 0.5, output: 2.5 });
  });

  test('the service\'s list: valid ids only, its names, OSCAR\'s prices where known, at most 100', () => {
    const json = { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'claude-x', display_name: '  ' },
      { id: 'has space' }, { id: 7 }, null] };
    expect(M.modelsFromService(json)).toEqual([
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, note: expect.any(String), above: null },
      { id: 'claude-x', label: 'claude-x', input: null, output: null, note: null, above: null }]);
    expect(M.modelsFromService({ data: Array.from({ length: 150 }, (_, i) => ({ id: `m-${i}` })) })).toHaveLength(100);
    expect(M.modelsFromService({ models: [] })).toBeNull();
  });

  test('the suggestions fit the form\'s own rules', () => {
    const base = { connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' };
    expect(C.checkConfig({ ...base, monthlyTokenCap: M.SUGGESTED_MONTHLY_TOKENS, instruction: M.SUGGESTED_INSTRUCTION }).refusal).toBeUndefined();
    expect(M.SUGGESTED_INSTRUCTION.length).toBeLessThanOrEqual(C.LIMITS.instruction);
  });

  test('prices in the form: both or neither, numbers from 0 to the limit', () => {
    const base = { connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm' };
    expect(C.checkConfig({ ...base, priceInput: '0', priceOutput: 2 }).value).toMatchObject({ priceInput: 0, priceOutput: 2 });
    expect(C.checkConfig({ ...base, priceInput: 1 }).refusal).toContain('both prices');
    expect(C.checkConfig({ ...base, priceInput: -1, priceOutput: 1 }).refusal).toContain('input price');
    expect(C.checkConfig({ ...base, priceInput: 1, priceOutput: 'x' }).refusal).toContain('output price');
    expect(C.checkConfig({ ...base, priceInput: 1, priceOutput: 1001 }).refusal).toContain('from 0 to 1000');
  });

  test('the models request, with or without "/v1"', () => {
    expect(C.modelsRequest({ baseUrl: 'https://api.anthropic.com/', apiKey: 'k' })).toEqual({ url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'k' } });
    expect(C.modelsRequest({ baseUrl: 'https://proxy.example/v1' }).url).toBe('https://proxy.example/v1/models?limit=100');
  });
});

describe('#831 spend', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const row = (at, model, input, output, cost) => ({ created_at: at, model, input_tokens: input, output_tokens: output, cost_usd: cost });

  test('today, this month, per month latest first, per model this month; a stored cost wins; unpriced counted', () => {
    const s = M.spendOf([
      row('2026-10-18 08:00:00', 'claude-opus-5-5', 1000, 100, 0.5),       // stored cost kept
      row('2026-10-17 08:00:00', 'claude-opus-5-5', 1000, 100, null),      // priced now: 0.006
      row('2026-10-02 08:00:00', 'my-model', 10, 10, null),                // no price
      row('2026-09-30 23:00:00', 'claude-sonnet-5-5', 1_000_000, 0, null), // last month: 2
      row('2026-10-18 09:00:00', 'claude-opus-5-5', null, null, null),     // a failed call: no tokens, left out
    ], now);
    expect(s.today).toEqual({ analyses: 1, tokens: 1100, cost: 0.5, unpriced: 0 });
    expect(s.month).toEqual({ analyses: 3, tokens: 2220, cost: 0.506, unpriced: 1 });
    expect(s.months.map(m => [m.month, m.cost])).toEqual([['2026-10', 0.506], ['2026-09', 2]]);
    expect(s.models.map(m => [m.model, m.analyses, m.cost])).toEqual([['claude-opus-5-5', 2, 0.506], ['my-model', 1, 0]]);
    expect(M.spendOf([], now).month).toEqual({ analyses: 0, tokens: 0, cost: 0, unpriced: 0 });
  });
});

describe('#831 the page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL|FIELD|WIDE|OWNER_LABEL|OWNER_STYLE|STATUS_LABEL) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  const names = ['connectorOptionsHtml', 'priceText', 'modelOptionsHtml', 'testedHtml', 'serviceHtml', 'usd', 'estimateText', 'listHtml',
    'groupRowHtml', 'comparisonHtml', 'resultHtml', 'inputLetters', 'historyHtml', 'sideBySideHtml', 'spendRow', 'spendHtml', 'analysisModelOptionsHtml'];
  vm.runInContext(`${consts}\n${names.map(lift).join('\n')}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);
  const answer = (config) => ({ config, connectors: C.connectorsForPage(), limits: { instruction: 2000, minTokenCap: 1000 },
    models: M.modelsForPage(), suggested: { monthlyTokenCap: M.SUGGESTED_MONTHLY_TOKENS, instruction: 'Be <short>.' } });
  const target = { id: 'p1', name: 'Beta', provider: true };

  test('an Anthropic service: the list, the suggested model in a new one, the suggested limit and instruction', () => {
    const html = ctx.serviceHtml(target, answer(null), 0);
    expect(html).toContain('data-f="modelList" style=""');
    expect(html).toContain('<option value="claude-opus-5-5">Claude Opus 5.5 (claude-opus-5-5) — $4 / $20 per million tokens in / out');
    expect(html).toContain('data-f="model" style="width:100%;max-width:560px;box-sizing:border-box;margin-top:6px" type="text" value="claude-opus-5-5"');
    expect(html).toContain('placeholder="2000000"');
    expect(html).toContain('Suggested: 2,000,000 tokens');
    expect(html).toContain('<template data-f="suggestedInstruction">Be &lt;short&gt;.</template>');
    expect(html).toContain('data-ai-action="suggest-instruction"');
    expect(html).toContain('data-ai-action="models"');
  });

  test('a stored model not in the list stays chosen, marked; an OpenAI-compatible service hides the list', () => {
    const anth = ctx.serviceHtml(target, answer({ connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x-<1>' }), 0);
    expect(anth).toContain('<option value="claude-x-&lt;1&gt;" selected>claude-x-&lt;1&gt; (not in the list)</option>');
    const oai = ctx.serviceHtml(target, answer({ connector: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest',
      priceInput: 2, priceOutput: 6 }), 0);
    expect(oai).toContain('data-f="modelList" style="display:none"');
    expect(oai).toContain('value="mistral-large-latest"');
    expect(oai).toMatch(/data-f="priceInput"[^>]*value="2"/);
    expect(oai).toMatch(/data-f="priceOutput"[^>]*value="6"/);
  });

  test('the analysis offers the configured model first, then the list for Anthropic only', () => {
    const anth = ctx.analysisModelOptionsHtml({ config: { connector: 'anthropic', model: 'claude-sonnet-5-5' }, models: M.modelsForPage() });
    expect(anth.startsWith('<option value="claude-sonnet-5-5" selected>claude-sonnet-5-5 (configured)</option>')).toBe(true);
    expect(anth.match(/claude-sonnet-5-5\)/g)).toBeNull();   // not listed twice
    expect(anth).toContain('Claude Opus 5.5 (claude-opus-5-5)');
    const oai = ctx.analysisModelOptionsHtml({ config: { connector: 'openai_compatible', model: 'gpt-4o' }, models: M.modelsForPage() });
    expect(oai).toBe('<option value="gpt-4o" selected>gpt-4o (configured)</option>');
  });

  test('the estimate says whose price, or that there is none', () => {
    expect(ctx.estimateText({ estimatedCost: { input: 0.1, atMost: 0.26 }, price: { source: 'list' } }))
      .toContain('Estimated cost (list price): about <strong>$0.10</strong> for what is sent, at most $0.26 with the answer.');
    expect(ctx.estimateText({ estimatedCost: { input: 0.1, atMost: 0.2 }, price: { source: 'custom' } })).toContain('(your price)');
    expect(ctx.estimateText({ estimatedCost: null })).toContain('no price for this model');
  });

  test('the history: a cost per analysis, a box to tick, and a letter for analyses sent the same input', () => {
    const html = ctx.historyHtml([
      { id: 'a1', createdAt: 't1', model: 'claude-opus-5-5', mode: 'one', status: 'done', cost: 0.27, contentHash: 'h1' },
      { id: 'a2', createdAt: 't2', model: 'claude-sonnet-5-5', mode: 'one', status: 'done', cost: 0.13, contentHash: 'h1' },
      { id: 'a3', createdAt: 't3', model: 'm', mode: 'one', status: 'failed', cost: null, contentHash: 'h2' }]);
    expect(html.match(/data-ai-action="an-pick"/g)).toHaveLength(3);
    expect(html.match(/>A<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain('>B</span>');
    expect(html).toContain('$0.27');
    expect(html).toContain('<td style="padding:7px 14px 7px 0;text-align:left;vertical-align:top;border-bottom:1px solid #eceff1;">—</td>');
    expect(html).toContain('data-ai-action="an-side"');
  });

  test('side by side: whether the inputs were the same, each model\'s answer, escaped', () => {
    const a = { status: 'done', model: 'claude-opus-5-5', mode: 'one', createdAt: 't', contentHash: 'h', tokens: {}, result: { summary: 'One <b>' } };
    const same = ctx.sideBySideHtml(a, { ...a, model: 'claude-sonnet-5-5', result: { summary: 'Two' } });
    expect(same).toContain('Both were sent the same input');
    expect(same).toContain('One &lt;b&gt;');
    expect(same).toContain('<h4 style="margin:0 0 6px">claude-sonnet-5-5</h4>');
    expect(ctx.sideBySideHtml(a, { ...a, contentHash: 'other' })).toContain('The inputs differ');
  });

  test('the spend: today, this month, per month, per model, the reader\'s own use and limit', () => {
    const s = { today: { analyses: 1, tokens: 1100, cost: 0.5, unpriced: 0 }, month: { analyses: 3, tokens: 2220, cost: 0.506, unpriced: 1 },
      months: [{ month: '2026-10', analyses: 3, tokens: 2220, cost: 0.506, unpriced: 1 }],
      models: [{ model: 'claude-<opus>', analyses: 2, tokens: 2200, cost: 0.506, unpriced: 0 }], mine: { cap: 2000000, used: 1500 } };
    const html = ctx.spendHtml(s);
    expect(html).toContain('>Today</td>');
    expect(html).toContain('$0.51 (1 without a price)');
    expect(html).toContain('>2026-10</td>');
    expect(html).toContain('claude-&lt;opus&gt;');
    expect(html).toContain('Your use this month: 1,500 of your 2,000,000 tokens.');
    expect(ctx.spendHtml({ ...s, months: [], models: [], mine: { cap: null, used: 0 } })).toContain('(no limit set)');
  });
});

describe('#848 totals over analyses', () => {
  test('stored cost first, else the list price now; no tokens = not counted; unknown model = unpriced', () => {
    const rows = [
      { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cost_usd: 0.5 },
      { model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, cost_usd: null },
      { model: 'unknown-model', input_tokens: 10, output_tokens: 10, cost_usd: null },
      { model: 'claude-opus-5-5', input_tokens: null, output_tokens: null, cost_usd: null },
    ];
    const listed = M.costOf(M.priceOf('claude-opus-5-5'), { input: 1_000_000, output: 0 });
    expect(M.totalOf(rows)).toEqual({ analyses: 3, tokens: 1_001_120, cost: 0.5 + listed, unpriced: 1 });
    expect(M.totalOf([])).toEqual({ analyses: 0, tokens: 0, cost: 0, unpriced: 0 });
  });

  test('totals add up, and an empty list is zero', () => {
    const a = { analyses: 2, tokens: 10, cost: 0.1, unpriced: 0 };
    const b = { analyses: 1, tokens: 5, cost: 0.2, unpriced: 1 };
    expect(M.sumOf([a, b])).toEqual({ analyses: 3, tokens: 15, cost: 0.3, unpriced: 1 });
    expect(M.sumOf([])).toEqual({ analyses: 0, tokens: 0, cost: 0, unpriced: 0 });
  });
});
