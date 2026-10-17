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
const journeyProbeDayHtml = loadFunction('journeyProbeDayHtml', { esc, PROBE_OUTCOMES });
const offeredTripHtml = loadFunction('offeredTripHtml', { esc });
const render = loadFunction('journeyProbeHtml', { esc, journeyProbeDayHtml, offeredTripHtml });

test('each day and its differences, then the trips offered once with their keep buttons; provider text escaped', () => {
  const html = render({ summary: 'Offered on 1 of 2 day(s) searched.', days: [
    { date: '2026-10-20', via: 'trips-collection', trips: 1, outcome: 'found', differences: [] },
    { date: '2026-10-21', via: 'offers', trips: 2, outcome: 'differences', differences: ['leg 2 is train <b>X</b>, not 9'] },
    { date: '2026-10-22', via: 'offers', error: 'HTTP 500' },
  ], offeredTrips: [
    { text: 'A → B', days: ['TUE'], asDefined: true, legs: [] },
    { text: 'A → <i>C</i>', days: ['WED', '<s>'], asDefined: false, legs: [] },
  ] }, 'j"3');
  expect(html).toContain('Offered on 1 of 2 day(s) searched.');
  expect(html).toContain('2026-10-20: offered as defined');
  expect(html).toContain('leg 2 is train &lt;b&gt;X&lt;/b&gt;, not 9');
  expect(html).toContain('A → &lt;i&gt;C&lt;/i&gt;');
  expect(html).toContain('WED &lt;s&gt;');
  expect(html).toContain('2026-10-22: no answer');
  expect(html).toContain('offers, HTTP 500');
  expect(html).not.toMatch(/<b>X|<i>C|<s>/);
  expect(html.match(/data-action="probe-keep-trip"/g)).toHaveLength(2);
  expect(html).toContain('data-key="j&quot;3" data-idx="1"');
  expect(html.match(/\(as defined\)/g)).toHaveLength(1);
});

test('no trip offered: no list', () => {
  expect(render({ summary: 's', days: [] }, 'j0')).not.toContain('Trips the provider offers');
});

test('Find journeys: each result has a Probe button and a box for its answer; both actions awaited', () => {
  const resultHtml = loadFunction('journeyFinderResultHtml', { esc, stnShort: (x) => x, journeyFinderClock: (t) => t, journeyFinderStepHtml: () => '' });
  const html = resultHtml({ waits: [5], via: ['B'], days: null, departureTime: '08:00', arrivalTime: '10:00', durationMinutes: 120, legs: [{}, {}], steps: [] }, 4);
  expect(html).toContain('data-action="jf-probe" data-idx="4"');
  expect(html).toContain('id="jf-probe-4"');
  expect(source).toContain('journeyFinderProbe(Number.parseInt(el.dataset.idx, 10)).catch(reportActionError)');
  expect(source).toContain('keepProbedTrip(el.dataset.key, Number.parseInt(el.dataset.idx, 10)).catch(reportActionError)');
});

test('the Probe button: a saved journey only, hidden from testers, its action awaited', () => {
  expect(source).toMatch(/\$\{j\.id && !j\._unsaved \? `<button[^`]*data-action="wiz-probe-journey"/);
  expect(source).toContain(`[data-action="wiz-delete-journey"], [data-action="wiz-probe-journey"]').forEach`);
  expect(source).toContain("wizProbeJourney(Number.parseInt(el.dataset.jidx, 10), el.dataset.id).catch(reportActionError)");
});
