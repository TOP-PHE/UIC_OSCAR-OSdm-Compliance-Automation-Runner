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
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

const { esc } = require('../../public/js/esc.js');
const PROBE_OUTCOMES = vm.runInNewContext(`(${/const PROBE_OUTCOMES = (\{[\s\S]*?\n\});/.exec(source)[1]})`);
const journeyProbeDayHtml = loadFunction('journeyProbeDayHtml', { esc, PROBE_OUTCOMES });
const offeredTripHtml = loadFunction('offeredTripHtml', { esc });
const probeOffersAsDefined = loadFunction('probeOffersAsDefined');
const render = loadFunction('journeyProbeHtml', { esc, journeyProbeDayHtml, offeredTripHtml, probeOffersAsDefined });

test('each day and its differences, then the trips offered once; provider text escaped', () => {
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
  expect(html.match(/\(as defined\)/g)).toHaveLength(1);
  // #865: a saved journey offered as defined on one day: nothing to keep or replace.
  expect(html).not.toContain('data-action="probe-keep-trip"');
  expect(html).not.toContain('data-action="probe-replace-journey"');
  expect(html).toContain('The journey is offered as defined: nothing to change.');
});

test('#865: a saved journey not offered as defined gets one button replacing it with every trip offered', () => {
  const result = { summary: 's', days: [{ date: '2026-10-20', via: 'offers', trips: 2, outcome: 'differences', differences: ['x'] }],
    offeredTrips: [{ text: 'A → B', days: ['TUE'], asDefined: false, legs: [] }, { text: 'A → C', days: ['TUE'], asDefined: false, legs: [] }] };
  const html = render(result, 'j"3');
  expect(html).not.toContain('data-action="probe-keep-trip"');
  expect(html.match(/data-action="probe-replace-journey"/g)).toHaveLength(1);
  expect(html).toContain('data-key="j&quot;3"');
  expect(html).toContain('Replace this journey with the 2 trip(s) offered');
  expect(render({ ...result, offeredTrips: [] }, 'j0')).toContain('The provider offers no trip to replace it with.');
});

test('#815: a result of Find journeys keeps its trips one by one', () => {
  const html = render({ summary: 's', days: [], offeredTrips: [{ text: 'A → B', days: ['TUE'], legs: [] }, { text: 'A → C', days: ['TUE'], legs: [] }] }, 'f2');
  expect(html.match(/data-action="probe-keep-trip"/g)).toHaveLength(2);
  expect(html).toContain('data-key="f2" data-idx="1"');
  expect(html).not.toContain('probe-replace-journey');
  expect(html).toContain('Nothing is changed in Test Data until you use a trip.');
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

// #868: Test Data ids are UUIDs (crypto.randomUUID). The page took only a
// positive integer, so the replace button never sent its request.
describe('#868 the replace button sends its request for a real Test Data id', () => {
  const RESOURCE_ID = vm.runInNewContext(`(${/const RESOURCE_ID = (\/.*\/i);/.exec(source)[1]})`);
  const resourceIdOf = loadFunction('resourceIdOf', { RESOURCE_ID });
  const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

  test('a UUID is taken; anything else is refused', () => {
    expect(resourceIdOf(ID)).toBe(ID);
    expect(resourceIdOf(ID.toUpperCase())).toBe(ID);
    for (const v of [7, '7', `${ID}/x`, `../${ID}`, `${ID}?a=1`, '', null, undefined, {}]) expect(resourceIdOf(v)).toBeNull();
  });

  test('replaceProbedJourney posts to the journey of the probe', async () => {
    const calls = [];
    const ctx = {
      resourceIdOf,
      probeResults: { j0: { journey: { id: ID, label: 'J' }, offeredTrips: [{ legs: [{ a: 1 }], days: ['TUE'] }] } },
      confirm: () => true,
      fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ journeys: [{ id: 'n1', created: true }] }) }; },
      oscarToast: () => {}, refreshAllSections: async () => {}, showJourneyInTestData: () => {},
    };
    const replaceProbedJourney = loadFunction('replaceProbedJourney', ctx);
    await replaceProbedJourney('j0');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/v1/company/test-resources/${ID}/replace-journey`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ trips: [{ legs: [{ a: 1 }], days: ['TUE'] }] });
  });
});
