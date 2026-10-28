// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-selection-page.test.js — the Run page's choice of what a batch runs
 * (#1029), without a browser: the page's own functions, lifted out of
 * run.html, draw the server's own preview and read it back.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');
const RF = require('../../src/utils/runFilters');

const PAGE = fs.readFileSync(path.resolve(__dirname, '../../public/run.html'), 'utf8').replaceAll('\r\n', '\n').split('\n');
function lift(name, context) {
  const start = PAGE.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`${name} not found in run.html`);
  const end = PAGE.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${PAGE.slice(start, end + 1).join('\n')})`, context, { filename: `run.html#${name}` });
}
const SELECT_FILTERS = vm.runInNewContext(`${PAGE.find((l) => l.startsWith('const SELECT_FILTERS ='))}\nSELECT_FILTERS`);
const ctx = { esc, SELECT_FILTERS };
ctx.selectOptionHtml = lift('selectOptionHtml', ctx);
const selectionPanelHtml = lift('selectionPanelHtml', ctx);
const selectionFromPanel = lift('selectionFromPanel', ctx);
const launchButtonText = lift('launchButtonText', ctx);

// The inputs of drawn HTML, as a root querySelectorAll() can read.
const unescape = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function rootOf(html) {
  const inputs = [...html.matchAll(/<input type="(\w+)" name="[^"]*" value="([^"]*)" data-select="([^"]*)"( checked)?>/g)]
    .map((m) => ({ type: m[1], value: unescape(m[2]), key: unescape(m[3]), checked: Boolean(m[4]) }));
  return {
    inputs,
    querySelectorAll(selector) {
      const key = /data-select="([^"]+)"/.exec(selector)[1];
      return inputs.filter((i) => i.key === key);
    },
  };
}

const facets = [
  { code: 'H1', category: 'happy', group: 'Sale', form: 'SEARCH', lastRun: 'passed', toRunAgain: false },
  { code: 'R1', category: 'refusal', group: 'Refund', form: 'TRIP_IDS', lastRun: 'failed', toRunAgain: true },
  { code: 'S1', category: 'simulated', group: 'Sale', form: 'SPECIFICATION', lastRun: 'never', toRunAgain: true },
];
const answer = (list, selection) => ({ ...RF.previewOf(list, selection), selection: RF.withDefaults(selection), seen: list.length, runList: 1 });

test('the panel draws every filter and value of the server\'s preview, and reads back the same selection', () => {
  for (const selection of [{}, { base: 'list', categories: ['simulated'], groups: ['Sale', 'Refund'], forms: ['TRIP_IDS'], lastRun: 'failed' }]) {
    const html = selectionPanelHtml(answer(facets, selection));
    for (const key of ['categories', 'groups', 'forms']) {
      const drawn = rootOf(html).querySelectorAll(`input[data-select="${key}"]`).map((i) => i.value);
      expect([key, drawn]).toEqual([key, Object.keys(RF.previewOf(facets, selection).counts[key])]);
    }
    expect(selectionFromPanel(rootOf(html))).toEqual(RF.withDefaults(selection));
  }
});

test('the labels are the server\'s, the counts shown, the simulated errors only when the file holds some', () => {
  const html = selectionPanelHtml(answer(facets, {}));
  expect(html).toContain(`> ${RF.CATEGORY_TEXT.simulated} <span class="sel-count">(1)</span>`);
  expect(html).toContain(`> ${RF.LAST_RUN_TEXT.toRunAgain} <span class="sel-count">(2)</span>`);
  expect(html).toContain('> Every scenario of the data file <span class="sel-count">(3)</span>');
  const without = selectionPanelHtml(answer(facets.filter((f) => f.category !== 'simulated'), { categories: ['happy', 'refusal', 'simulated'] }));
  expect(without).not.toContain('value="simulated"');
  expect(selectionFromPanel(rootOf(without)).categories).toEqual(['happy', 'refusal']);
});

test('what the server sends is text, never markup', () => {
  const evil = answer(facets, {});
  evil.labels = { ...evil.labels, groups: { ...evil.labels.groups, Sale: '<img src=x onerror=alert(1)>' } };
  const html = selectionPanelHtml(evil);
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
});

test('the button says how many scenarios run', () => {
  expect(launchButtonText(12)).toBe('▶ Run 12 scenario(s)');
});

test('the launch sends the selection the panel shows', async () => {
  const sent = [];
  const button = { disabled: false, textContent: '' };
  const page = {
    esc, runSelection: { base: 'all', categories: ['simulated'] }, location: { href: '' },
    document: { getElementById: () => button },
    fetch: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ runs: [{}, {}], batch_id: '0123456789' }) }; },
    oscarToastAfterNav: () => {}, showWarn: () => {}, updateLaunchButton: () => {},
  };
  page.window = page;
  const startRun = lift('startRun', page);
  await startRun();
  expect(sent).toEqual([{ url: '/v1/runs', body: { parallel: true, selection: { base: 'all', categories: ['simulated'] } } }]);
  expect(page.location.href).toBe('/dashboard.html');
});
