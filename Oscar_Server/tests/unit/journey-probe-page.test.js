// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #813: the journey probe's result in Test Config. Text from the provider is
// escaped; the button is the Test Manager's and only on a saved journey.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8');

function loadFunction(name, context = {}) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

const { esc } = require('../../public/js/esc.js');
const PROBE_OUTCOMES = vm.runInNewContext(`(${/const PROBE_OUTCOMES = (\{[\s\S]*?\n\});/.exec(source)[1]})`);
const render = loadFunction('journeyProbeHtml', { esc, PROBE_OUTCOMES });

test('each day, its differences and what is offered instead; provider text escaped', () => {
  const html = render({ summary: 'Offered on 1 of 2 day(s) searched.', days: [
    { date: '2026-10-20', via: 'trips-collection', trips: 1, outcome: 'found', differences: [], offered: ['A → B'] },
    { date: '2026-10-21', via: 'offers', trips: 2, outcome: 'differences', differences: ['leg 2 is train <b>X</b>, not 9'], offered: ['A → <i>C</i>'] },
    { date: '2026-10-22', via: 'offers', error: 'HTTP 500' },
  ] });
  expect(html).toContain('Offered on 1 of 2 day(s) searched.');
  expect(html).toContain('2026-10-20: offered as defined');
  expect(html).toContain('leg 2 is train &lt;b&gt;X&lt;/b&gt;, not 9');
  expect(html).toContain('A → &lt;i&gt;C&lt;/i&gt;');
  expect(html).toContain('2026-10-22: no answer');
  expect(html).toContain('offers, HTTP 500');
  expect(html).not.toMatch(/<b>X|<i>C/);
  // what a found day was offered is not listed as "instead"
  expect(html.split('Offered instead').length).toBe(2);
});

test('the Probe button: a saved journey only, hidden from testers, its action awaited', () => {
  expect(source).toMatch(/\$\{j\.id && !j\._unsaved \? `<button[^`]*data-action="wiz-probe-journey"/);
  expect(source).toContain(`[data-action="wiz-delete-journey"], [data-action="wiz-probe-journey"]').forEach`);
  expect(source).toContain("wizProbeJourney(Number.parseInt(el.dataset.jidx, 10), el.dataset.id).catch(reportActionError)");
});
