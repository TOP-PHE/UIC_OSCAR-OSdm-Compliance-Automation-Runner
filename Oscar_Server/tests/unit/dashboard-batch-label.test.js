// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * dashboard-batch-label.test.js — the dashboard says what a batch ran
 * (#1029 PR 3), without a browser: the page's own helper, lifted out of
 * dashboard.html, draws the server's own words.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');
const RF = require('../../src/utils/runFilters');

const PAGE = fs.readFileSync(path.resolve(__dirname, '../../public/dashboard.html'), 'utf8').replaceAll('\r\n', '\n').split('\n');
function sourceOf(name) {
  const start = PAGE.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found in dashboard.html`);
  const end = PAGE.findIndex((l, i) => i > start && l === '}');
  return PAGE.slice(start, end + 1).join('\n');
}
const batchLabelHtml = vm.runInNewContext(`(${sourceOf('batchLabelHtml')})`, { esc }, { filename: 'dashboard.html#batchLabelHtml' });

describe('the batch label on the dashboard', () => {
  test('draws the server\'s words', () => {
    const label = RF.selectionLabel({ base: 'list', categories: ['simulated'], lastRun: 'failed' });
    const html = batchLabelHtml(label);
    expect(html).toContain('class="batch-label"');
    expect(html).toContain(esc(label));
    expect(html).toContain('Run list · Simulated errors · Failed at the last run');
  });

  test('escapes what it is given', () => {
    const html = batchLabelHtml('<img src=x onerror=alert(1)> & "');
    expect(html).not.toContain('<img');
    expect(html).toContain(esc('<img src=x onerror=alert(1)> & "'));
  });

  test('says nothing for a batch without a selection', () => {
    for (const none of [null, undefined, '', '  ', 42, {}]) expect(batchLabelHtml(none)).toBe('');
  });

  test('is drawn in the batch header, from the batch\'s first run', () => {
    const render = sourceOf('renderRuns');
    expect(render).toContain('${batchLabelHtml(batchRuns[0].batch_label)}');
    expect(render.indexOf('batchLabelHtml(')).toBeGreaterThan(render.indexOf('class="run-row batch-header"'));
  });
});
