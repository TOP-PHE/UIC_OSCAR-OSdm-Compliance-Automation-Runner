// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ai-page-tabs.test.js — #848 PR 2: the AI analysis page in three tabs
 * (Connection, Usage status, Analysis), the choice of one service for all
 * or one per provider, the status table, and the analysis asked step by
 * step. The page's own functions are lifted out of public/js/ai-analysis.js
 * by text and run in a vm, as the other ai-* page tests do.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
const lines = source.split('\n');
const lift = (name) => {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
};
const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL|FIELD|WIDE) =/.test(l)).join('\n');
// A const that may span several lines: its declaration up to the line ending in ");".
const liftConst = (name) => {
  const start = lines.findIndex((l) => l.startsWith(`const ${name} =`));
  const end = lines.findIndex((l, i) => i >= start && l.trimEnd().endsWith(');'));
  return lines.slice(start, end + 1).join('\n');
};
const tabsDecl = ['TABS', 'ACCESS_LABEL', 'CONNECTOR_LABEL'].map(liftConst).join('\n');

const ctx = vm.createContext({ esc });
const names = ['tabsHtml', 'setupHtml', 'serviceCellHtml', 'overviewHtml', 'analysisTabHtml', 'checklistHtml', 'usd'];
vm.runInContext(`${consts}\n${tabsDecl}\n${names.map(lift).join('\n')}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);

describe('#848 the tabs', () => {
  test('three tabs, the active one pressed, each naming its panel', () => {
    const html = ctx.tabsHtml('status');
    expect((html.match(/role="tab"/g) || []).length).toBe(3);
    expect(html).toContain('data-ai-tab="connection"');
    expect(html).toMatch(/class="btn btn-primary" role="tab" data-ai-tab="status"\s+aria-selected="true" aria-controls="ai-panel-status">Usage status</);
    expect(html).toMatch(/data-ai-tab="analysis"\s+aria-selected="false"/);
  });

  test('the page opens on the tab the address names, else Analysis when a service exists, else Connection', () => {
    expect(source).toContain("await showTab(tabFromHash() || ((current.configured || []).length ? 'analysis' : 'connection'));");
    expect(lift('tabFromHash')).toContain('TAB_IDS.has(asked)');
  });
});

describe('#848 one service for all, or one per provider', () => {
  test('the choice shows the stored mode checked, and the services it leaves unused, escaped', () => {
    const html = ctx.setupHtml({ company: { name: 'Co <b>' }, mode: 'per_provider', services: [
      { company: { name: 'Co <b>' }, model: 'm1', inUse: true }, { company: { name: 'Alpha' }, model: 'm<2>', inUse: false }] });
    expect(html).toContain('for Co &lt;b&gt; and its providers');
    expect(html).toContain('value="per_provider" data-ai-action="mode" checked');
    expect(html).not.toContain('value="shared" data-ai-action="mode" checked');
    expect(html).toContain('One AI service for all (recommended)');
    expect(html).toContain('Kept but not used with this choice: Alpha (m&lt;2&gt;).');
    const shared = ctx.setupHtml({ company: { name: 'Co' }, mode: 'shared', services: [] });
    expect(shared).toContain('value="shared" data-ai-action="mode" checked');
    expect(shared).not.toContain('Kept but not used');
    expect(ctx.setupHtml(null)).toBe('');
  });

  test('changing the choice saves it and draws the page again', () => {
    const body = lift('changeMode');
    expect(body).toContain("fetch('/v1/company/ai-analysis/setup', { method: 'PUT'");
    expect(body).toContain('await load();');
  });
});

describe('#848 the usage status', () => {
  const overview = {
    mode: 'shared',
    targets: [
      { id: 'c', name: 'Co', provider: false, access: 'approved', service: { connector: 'anthropic', model: 'claude-opus-5-5', of: { id: 'c', name: 'Co' } }, analyses: 2, tokens: 1200, cost: 0.5, unpriced: 0 },
      { id: 'a', name: 'Alpha <x>', provider: true, access: 'approved', service: { connector: 'anthropic', model: 'claude-opus-5-5', of: { id: 'c', name: 'Co' } }, analyses: 1, tokens: 300, cost: 0.004, unpriced: 1 },
      { id: 'b', name: 'Beta', provider: true, access: 'pending', service: null, analyses: 0, tokens: 0, cost: 0, unpriced: 0 },
    ],
    totals: { analyses: 3, tokens: 1500, cost: 0.504, unpriced: 1 },
  };

  test('one row per company or provider: access in words, the service and whose it is, analyses, tokens, cost', () => {
    const html = ctx.overviewHtml(overview);
    expect(html).toContain('Your choice: one AI service for all.');
    expect(html).toContain('Alpha &lt;x&gt;<br><span style="font-size:11px;color:#78909c">Provider</span>');
    expect(html).toContain('>Waiting for an administrator<');
    expect(html).toContain('Anthropic · claude-opus-5-5<br><span style="font-size:11px;color:#78909c">shared, from Co</span>');
    expect(html.match(/shared, from Co/g)).toHaveLength(1);   // not on the company's own row
    expect(html).toContain('<span style="color:#90a4ae">none</span>');
    expect(html).toContain('$0.0040 (1 without a price)');
    expect(html).toMatch(/Total<\/td>.*>3<\/td>.*>1,500<\/td>.*>\$0\.50<\/td>/s);
    expect(ctx.overviewHtml({ ...overview, mode: 'per_provider' })).toContain('one AI service per provider');
  });
});

describe('#848 the analysis, step by step', () => {
  // A fake page: elements by id, each with `hidden` and `innerHTML`.
  function page() {
    const ids = ['ai-an-step-batch', 'ai-an-step-checklist', 'ai-an-step-send', 'ai-an-history-section', 'ai-an-checklist-import',
      'ai-an-preview', 'ai-an-result', 'ai-an-faults'];
    const els = Object.fromEntries(ids.map(id => [id, { hidden: true, innerHTML: 'old' }]));
    const env = vm.createContext({ document: { getElementById: (id) => els[id] || null }, previewed: { hash: 'h' } });
    vm.runInContext(`${lift('step')}\n${lift('clearAnalysisOutput')}\n${lift('checklistChoice')}\nthis.checklistChoice = checklistChoice;`, env);
    return { els, env };
  }

  test('keeping the stored checklist, or going on without, opens step 4 and clears an earlier preview', () => {
    for (const value of ['keep', 'none']) {
      const { els, env } = page();
      env.checklistChoice(value);
      expect(els['ai-an-step-send'].hidden).toBe(false);
      expect(els['ai-an-checklist-import'].hidden).toBe(true);
      expect(els['ai-an-preview'].innerHTML).toBe('');
      expect(env.previewed).toBeNull();
    }
  });

  test('importing a new one shows the file field and waits for the file before step 4', () => {
    const { els, env } = page();
    env.checklistChoice('new');
    expect(els['ai-an-checklist-import'].hidden).toBe(false);
    expect(els['ai-an-step-send'].hidden).toBe(true);
    env.checklistChoice('');   // nothing chosen: nothing opens
    expect(els['ai-an-step-send'].hidden).toBe(true);
  });

  test('after an import the step is drawn again from what is stored, kept; removing draws it again too', () => {
    expect(lift('importChecklist')).toContain('await loadChecklist();');
    expect(lift('removeChecklist')).toContain('await loadChecklist();');
    expect(lift('loadChecklist')).toContain("checklistChoice(checklist ? 'keep' : '')");
  });

  test('choosing the company or provider hides every later step until its results are read; the batch opens step 3', () => {
    const target = lift('loadAnalysisTarget');
    expect(target).toContain("for (const id of ['ai-an-step-batch', 'ai-an-step-checklist', 'ai-an-step-send', 'ai-an-history-section']) step(id, false);");
    expect(target).toContain("if (!document.getElementById('ai-an-target').value) return;");
    expect(target).toContain('— choose the test results —');
    const batch = lift('batchChosen');
    expect(batch).toContain("step('ai-an-step-checklist', chosen);");
    expect(batch).toContain("step('ai-an-step-send', false);");
  });

  test('a preview without test results chosen says so and sends nothing', () => {
    expect(lift('previewAnalysis')).toContain("if (!choice.batches[0]) { box.innerHTML = testResultHtml({ ok: false, error: 'Choose the test results first.' }); return; }");
  });
});
