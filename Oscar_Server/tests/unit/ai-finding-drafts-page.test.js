// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #823 PR 2, the pages: each group of an AI analysis offers a finding draft
 * (or says what became of it), and Test Findings says where a draft comes
 * from. The functions are lifted out of the pages by text and run in a vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', file), 'utf8');
const ai = read('ai-analysis.js');
const findings = read('findings.js');

// A top-level function, up to its "}" at column 0; or one inside an IIFE, up to its "}" at two spaces.
function lift(source, name, indent = '') {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${indent}function ${name}(`) || l.startsWith(`${indent}async function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  return lines.slice(start, end + 1).join('\n');
}

const consts = ai.split('\n').filter((l) => /^const (CELL|OWNER_LABEL|OWNER_STYLE|DRAFT_STATE) =/.test(l)).join('\n');
const ctx = vm.createContext({ esc });
vm.runInContext(`${consts}\n${lift(ai, 'draftButtonHtml')}\n${lift(ai, 'groupRowHtml')}\nthis.groupRowHtml = groupRowHtml;
${lift(findings, 'draftOrigin', '  ')}\nthis.draftOrigin = draftOrigin;`, ctx);

describe('#823 the AI analysis page', () => {
  test('a group without a draft offers to make one, under its number', () => {
    const html = ctx.groupRowHtml({ title: 'T', cause: 'C', owner: 'provider' }, 2);
    expect(html).toContain('data-ai-action="an-draft" data-group="2"');
    expect(html).toContain('Make a finding draft');
  });

  test('a group with a draft says what became of it and links to Test Findings, escaped', () => {
    const made = ctx.groupRowHtml({ title: 'T', cause: 'C', owner: 'oscar' }, 0, { id: 's1', state: 'accepted' });
    expect(made).not.toContain('an-draft');
    expect(made).toContain('Finding draft accepted as a finding — <a href="/findings.html">Test Findings</a> › 🧩 Suggested from runs');
    expect(made).toContain('data-ai-action="an-copy-issue"');
    expect(ctx.groupRowHtml({ title: 'T', cause: 'C' }, 0, { state: '<odd>' })).toContain('Finding draft &lt;odd&gt;');
  });

  test('the result passes each group its draft; a draft made draws the analysis again', () => {
    expect(ai).toContain('groupRowHtml(g, n, a.drafts?.[n])');
    const make = lift(ai, 'makeDraft');
    expect(make).toContain("'/groups/' + encodeURIComponent(n) + '/draft'");
    expect(make).toContain("method: 'POST'");
    expect(make).toContain('await showAnalysis(shownAnalysis.id);');
    expect(ai).toContain("else if (act === 'an-draft') job = makeDraft(el.dataset.group);");
  });
});

describe('#823 Test Findings', () => {
  test('a draft from an AI analysis names the model and the AI\'s owner, never a failure count; values escaped', () => {
    const line = ctx.draftOrigin({ occurrences: 0, scenarios: ['S<1>'], draft: { step: '14b', source: { kind: 'ai_analysis', model: 'm<x>', createdAt: 't', owner: 'provider' } } });
    expect(line).toBe('🤖 From an AI analysis (m&lt;x&gt;, t) · the AI names: provider · S&lt;1&gt; · step 14b');
  });

  test('a draft from a batch keeps its failure count and HTTP status', () => {
    expect(ctx.draftOrigin({ occurrences: 3, scenarios: ['A', 'B'], draft: { step: '02', expectedStatus: 400 } }))
      .toBe('3 failure(s) · A, B · step 02 · HTTP 400');
  });
});

describe('#823 the draft of a group (pure)', () => {
  const AN = require('../../src/utils/aiAnalysis');
  const analysis = { id: 'a1', model: 'm', createdAt: 't', batches: ['b1', 'b2'],
    result: { groups: [{ title: 'T', cause: 'C', owner: 'nobody', steps: [], scenarios: [] }] } };

  test('an owner the AI may not give reads as unclear; two batches are named', () => {
    const d = AN.draftOfAnalysisGroup(analysis, 0);
    expect(d.source.owner).toBe('unclear');
    expect(d.reason).toBe('From an AI analysis, which names unclear. The category is yours to choose.');
    expect(d.evidence.split('\n')[0]).toBe('From an AI analysis (id a1, model m, t) of batches b1 and b2.');
    expect(d).toMatchObject({ step: null, scenarioCode: null, category: 'open' });
  });

  test('no group, no draft; the key names the analysis and the group', () => {
    expect(AN.draftOfAnalysisGroup(analysis, 1)).toBeNull();
    expect(AN.draftOfAnalysisGroup({ ...analysis, result: null }, 0)).toBeNull();
    expect(AN.draftKeyOf('a1', 3)).toBe('ai:a1:3');
  });
});
