// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklist-config-page.test.js — #862: what Test Config's "Provider
 * checklist" box shows. The pure functions are lifted out of the page script
 * by text, as reference-config-page.test.js does.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const FILE = path.resolve(__dirname, '../../public/js/checklist-config.js');
const SOURCE = fs.readFileSync(FILE, 'utf8').replaceAll('\r\n', '\n');
const LINES = SOURCE.split('\n');

function source(name) {
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = LINES.findIndex((l, i) => i > start && l === '}');
  return LINES.slice(start, end + 1).join('\n');
}
const consts = LINES.filter(l => /^const CHECKLIST_[A-Z_]+ = /.test(l)).join('\n');
// Every top-level helper of the page: they call one another.
const names = LINES.map(l => /^function (checklist\w+)\(/.exec(l)).filter(Boolean).map(m => m[1]);
const ctx = vm.createContext({ esc });
vm.runInContext(`${consts}\n${names.map(source).join('\n')}\nthis.api = { ${names.join(', ')} };`, ctx);
const P = ctx.api;

const imported = { id: 'i2', fileName: 'Provider <b>.docx', importedAt: '2026-10-19 08:00:00', importedBy: 'tm@x.com', status: 'waiting' };
const preview = {
  import: imported,
  previous: { kind: 'applied', fileName: 'Provider 1.docx', importedAt: '2026-10-01 09:00:00' },
  answerChanges: [{ question: 'fw.osdmVersion', before: '3.6', after: '3.8' }],
  framework: { changes: [{ path: 'osdmVersion', before: '3.6', after: '3.8' }, { path: 'salesFlows', before: ['SALE'], after: ['SALE', 'REFUND_FULL'] }], unplaced: ['fw.ancillaries.other'], created: false },
  testData: { mode: 'add', add: [{ type: 'TRAIN', label: 'Sheet 1: IC <x>' }, { type: 'JOURNEY', label: 'Journey NRT_IRT' }], remove: [], alreadyThere: 2 },
  skipped: ['Journey NRT_NRT: a leg has no station code.'],
  notes: [],
  hash: 'h',
};

describe('#862 the box', () => {
  test('no checklist yet: the import control, labelled', () => {
    const html = P.checklistBoxHtml([]);
    expect(html).toContain('No checklist applied yet.');
    expect(html).toContain('<label for="checklist-file"');
    expect(html).toContain('id="checklist-file" type="file" accept=".docx"');
    expect(html).not.toContain('Imports kept');
  });

  test('the last applied and every import kept, escaped', () => {
    const html = P.checklistBoxHtml([imported, { id: 'i1', fileName: 'Provider 1.docx', importedAt: '2026-10-01 09:00:00', status: 'applied', decidedAt: '2026-10-01 09:05:00' }]);
    expect(html).toContain('Last applied: Provider 1.docx, imported 2026-10-01 09:00:00, applied 2026-10-01 09:05:00.');
    expect(html).toContain('Imports kept (2)');
    expect(html).toContain('Provider &lt;b&gt;.docx — imported 2026-10-19 08:00:00, by tm@x.com — waiting for a decision');
    expect(html).not.toContain('<b>.docx');
  });
});

describe('#862 the preview', () => {
  const html = P.checklistPreviewHtml(preview);

  test('set against the checklist applied before, answers and framework changes in tables', () => {
    expect(html).toContain('Compared with the checklist applied before: Provider 1.docx, imported 2026-10-01 09:00:00.');
    expect(html).toContain('Answers changed (1)');
    expect(html).toContain('<td style="vertical-align:top;border-bottom:1px solid #eceff1;padding:2px 6px;overflow-wrap:anywhere">fw.osdmVersion</td>');
    expect(html).toContain('Test Framework: 2 value(s) change');
    expect(html).toContain('[&quot;SALE&quot;,&quot;REFUND_FULL&quot;]');
    expect(html).toContain('fw.ancillaries.other');
  });

  test('Test Data added, already there, and what could not be built; labels escaped', () => {
    expect(html).toContain('Added (2)');
    expect(html).toContain('Train set: Sheet 1: IC &lt;x&gt;');
    expect(html).toContain('Already there, left as they are: 2.');
    expect(html).toContain('From the checklist, not built:');
    expect(html).toContain('Journey NRT_NRT: a leg has no station code.');
    expect(html).not.toContain('To check:');
    expect(P.checklistPreviewHtml({ ...preview, skipped: [], notes: ['2 train set(s) keep local times'] })).toContain('To check:');
    expect(html).not.toContain('Removed (');
    expect(html).toContain('id="checklist-td-add" name="checklist-td" value="add" data-checklist-action="mode" checked');
  });

  test('every radio has its label', () => {
    for (const id of ['checklist-td-add', 'checklist-td-replace']) expect(html).toContain(`<label for="${id}">`);
  });

  test('the buttons only while the checklist waits', () => {
    expect(html).toContain('data-checklist-action="apply"');
    expect(html).toContain('data-checklist-action="discard"');
    const applied = P.checklistPreviewHtml({ ...preview, import: { ...imported, status: 'applied' } });
    expect(applied).not.toContain('data-checklist-action="apply"');
  });

  test('a first checklist, and replace naming what is removed', () => {
    const first = P.checklistPreviewHtml({ ...preview, previous: null, answerChanges: null, framework: { changes: [], unplaced: [], created: true },
      testData: { mode: 'replace', add: [], remove: [{ type: 'TRAIN', label: 'Old <t>' }], alreadyThere: 0 } });
    expect(first).toContain('No checklist was applied before: everything below is new.');
    expect(first).not.toContain('Answers changed');
    expect(first).toContain('Test Framework (created):</strong> no change.');
    expect(first).toContain('Removed (1)');
    expect(first).toContain('Old &lt;t&gt;');
    expect(first).toContain('value="replace" data-checklist-action="mode" checked');
  });

  test('the checklist imported for the AI analysis is named as such', () => {
    expect(P.checklistPreviewHtml({ ...preview, previous: { kind: 'ai_analysis', fileName: 'ai.docx', importedAt: 'd' } }))
      .toContain('Compared with the checklist imported for the AI analysis: ai.docx');
  });

  test('long values are cut', () => {
    expect(P.checklistValueText('x'.repeat(200))).toBe(`${'x'.repeat(120)}…`);
    expect(P.checklistValueText(null)).toBe('—');
  });
});

describe('#862 the wiring', () => {
  test('Test Managers only, through the page\'s fetch (which names the provider)', () => {
    expect(SOURCE).toContain("if (user.role !== 'test_manager') return;");
    expect(SOURCE).not.toMatch(/innerHTML\s*=\s*[^;]*\$\{(?!.*esc)/);
    expect(SOURCE).toContain('JSON.stringify({ hash: current.hash, testData: mode })');
  });

  test('the box is on Test Config, after the reference', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../public/scenarios.html'), 'utf8');
    expect(html.indexOf('<div id="checklist-config"></div>')).toBeGreaterThan(html.indexOf('<div id="reference-config"></div>'));
    expect(html).toContain('<script src="/js/checklist-config.js"></script>');
  });
});

describe('#862 an import id read from an answer', () => {
  test('only a positive integer goes into a request address', () => {
    expect(P.checklistIdOf(7)).toBe(7);
    expect(P.checklistIdOf('12')).toBe(12);
    for (const v of ['../admin', '1/discard', '1?x=1', 0, -3, 1.5, null, undefined, '', 'abc', Number.MAX_SAFE_INTEGER + 2]) {
      expect(P.checklistIdOf(v)).toBeNull();
    }
  });

  test('every request to an import uses it', () => {
    expect(SOURCE).not.toMatch(/checklists\/\$\{encodeURIComponent/);
    expect(SOURCE.match(/checklistIdOf\(/g).length).toBeGreaterThanOrEqual(4);
  });
});
