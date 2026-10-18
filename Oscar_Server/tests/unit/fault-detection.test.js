// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #833 PR D: did a run detect the faults the simulator was asked for, and did
 * the AI analysis explain them? The replay of the SIM_FAULT_* scenarios
 * (tests/helpers/fault-replay.json, the checks failed and warnings logged by
 * the collection) must give every fault as detected.
 */

const path = require('node:path');
const D = require('../../src/utils/faultDetection');

const REPO = path.resolve(__dirname, '..', '..', '..');
const REPLAY = require('../helpers/fault-replay.json');
const DATAFILE = require(path.join(REPO, 'Bruno_Collection', 'data_base', 'simulator_datafile.json'));

// The replay as a batch: one run per scenario.
function replayBatch() {
  const runs = Object.keys(REPLAY).map((code, i) => ({ runId: `r${i}`, scenarioCode: code }));
  const failures = runs.flatMap((r) => REPLAY[r.scenarioCode].failures.map(([step, check]) => ({ runId: r.runId, step, check })));
  const warnings = runs.flatMap((r) => REPLAY[r.scenarioCode].warnings.map((message) => ({ runId: r.runId, message })));
  return { runs, failures, warnings, scenarios: DATAFILE.scenarios };
}

test('the catalogue copy is the simulator\'s own (regenerate with scripts/generate-simulator-faults.js)', () => {
  const { catalogue } = require(path.join(REPO, 'OSDM_Simulator', 'src', 'osdm', 'faults.js'));
  expect(D.CATALOGUE).toEqual(catalogue());
});

test('the replay of the SIM_FAULT_* scenarios: every fault detected, each as expected', () => {
  const report = D.detect(replayBatch());
  expect(report.summary).toEqual({ injected: 12, unknown: 0, detected: 12, asExpected: 12 });
  expect(new Set(report.faults.map((f) => f.code))).toEqual(new Set(D.CATALOGUE.map((f) => f.code)));
  const html = report.faults.find((f) => f.code === 'answer.html');
  expect(html.expectations.map((e) => e.found.length)).toEqual([1, 1]);
  const codeless = report.faults.find((f) => f.code === 'error.problem-without-code');
  expect(codeless.expectations[0].found.every((m) => m.level === 'WARNING')).toBe(true);
});

test('a fault not reported is missed; a scenario without faults is not judged', () => {
  const batch = replayBatch();
  const price = batch.runs.find((r) => r.scenarioCode === 'SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38');
  batch.failures = batch.failures.filter((f) => f.runId !== price.runId);
  batch.runs.push({ runId: 'clean', scenarioCode: 'SIM_SALE_SEARCH_1ADT_38' });
  batch.failures.push({ runId: 'clean', step: '01. POST Get Offer', check: 'Offer minimalPrice >= sum of admission parts price' });
  const report = D.detect(batch);
  expect(report.summary).toEqual({ injected: 12, unknown: 0, detected: 11, asExpected: 11 });
  expect(report.faults.find((f) => f.runId === price.runId).detected).toBe(false);
  expect(report.faults.some((f) => f.runId === 'clean')).toBe(false);
});

test('half the expectations met is detected, not as expected; a check of another step does not count', () => {
  const scenarios = [{ code: 'S', simulatorFaults: 'answer.html' }];
  const runs = [{ runId: 'r', scenarioCode: 'S' }];
  const one = D.detect({ runs, scenarios, warnings: [], failures: [{ runId: 'r', step: '05. GET Booking before Fulfillments', check: '[OSDM] Content-Type is JSON' }] });
  expect(one.faults[0]).toMatchObject({ detected: true, asExpected: false });
  const elsewhere = D.detect({ runs, scenarios, warnings: [], failures: [{ runId: 'r', step: '07. GET Booking after Fulfillments', check: '[OSDM] Content-Type is JSON' }] });
  expect(elsewhere.faults[0].detected).toBe(false);
});

test('an unknown code is said, never counted as detected', () => {
  const report = D.detect({ runs: [{ runId: 'r', scenarioCode: 'S' }], scenarios: [{ code: 'S', simulatorFaults: ['no.such'] }], failures: [], warnings: [] });
  expect(report.summary).toEqual({ injected: 1, unknown: 1, detected: 0, asExpected: 0 });
  expect(report.faults[0].known).toBe(false);
});

test('faultsOfScenario reads a list or "a, b", each once', () => {
  expect(D.faultsOfScenario({ simulatorFaults: 'a.b, c.d a.b' })).toEqual(['a.b', 'c.d']);
  expect(D.faultsOfScenario({ simulatorFaults: ['a.b'] })).toEqual(['a.b']);
  expect(D.faultsOfScenario({})).toEqual([]);
  expect(D.faultsOfScenario(null)).toEqual([]);
});

describe('the AI analysis read against the report', () => {
  const report = D.detect(replayBatch());
  const judgedCount = report.faults.filter((f) => f.expectations.some((e) => e.found.some((m) => m.level === 'FAIL'))).length;

  test('only the faults OSCAR failed are judged: a WARNING never reaches the analysis', () => {
    const score = D.scoreAnalysis(report, { groups: [] });
    expect(judgedCount).toBe(11);
    expect(score.summary).toEqual({ judged: 11, explained: 0, misattributed: 0, missed: 11, score: 0 });
    expect(score.judged.some((j) => j.code === 'error.problem-without-code')).toBe(false);
  });

  test('a provider group naming the scenario and step explains it; another owner misattributes it', () => {
    const groups = [
      { title: 'Price below its parts', owner: 'provider', steps: ['POST Get Offer'], scenarios: ['SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38'] },
      { title: 'Currency', owner: 'oscar', steps: ['02. POST Create Booking'], scenarios: ['SIM_FAULT_BOOKING_CURRENCY_CHANGED_38'] },
      { title: 'Refund status', owner: 'provider', steps: ['14. GET Booking after Patch Refund'], scenarios: [] },
      { title: 'Wrong scenario', owner: 'provider', steps: ['03. PATCH Multi Passenger'], scenarios: ['SIM_SALE_SEARCH_1ADT_38'] },
    ];
    const score = D.scoreAnalysis(report, { groups });
    const verdict = (code) => score.judged.find((j) => j.code === code).verdict;
    expect(verdict('offer.price-below-parts')).toBe('explained');
    expect(verdict('booking.currency-changed')).toBe('misattributed');
    expect(verdict('refund.not-refunded')).toBe('explained');
    expect(verdict('passenger.name-altered')).toBe('missed');
    expect(score.summary).toMatchObject({ judged: 11, explained: 2, misattributed: 1, missed: 8 });
    expect(score.summary.score).toBe(0.18);
    expect(score.judged.find((j) => j.code === 'offer.price-below-parts').group).toEqual({ index: 0, title: 'Price below its parts', owner: 'provider' });
  });

  test('no fault judged gives no score', () => {
    expect(D.scoreAnalysis({ faults: [] }, null).summary).toEqual({ judged: 0, explained: 0, misattributed: 0, missed: 0, score: null });
  });
});

describe('the page draws the report', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { esc } = require('../../public/js/esc');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL|FAULT_VERDICT) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  vm.runInContext(`${consts}\n${lift('faultVerdictHtml')}\n${lift('faultReportHtml')}\nthis.faultReportHtml = faultReportHtml;`, ctx);

  test('every fault with what OSCAR saw, and the AI column only with an analysis', () => {
    const report = D.detect(replayBatch());
    const plain = ctx.faultReportHtml(report);
    expect(plain).toContain('OSCAR detected 12 of 12 faults asked for (12 with every expected check)');
    expect((plain.match(/✅ detected/g) || []).length).toBe(12);
    expect(plain).not.toContain('AI analysis</th>');
    const analysis = { model: 'm <x>', ...D.scoreAnalysis(report, { groups: [{ title: 'T <b>', owner: 'provider', steps: ['01. POST Get Offer'], scenarios: [] }] }) };
    const scored = ctx.faultReportHtml({ ...report, analysis });
    expect(scored).toContain('AI analysis (m &lt;x&gt;): 2 of 11 explained (score 0.18)');
    expect(scored).toContain('T &lt;b&gt; (provider)');
    expect(scored).toContain('<td style="padding:7px 14px 7px 0;text-align:left;vertical-align:top;border-bottom:1px solid #eceff1;">—</td>');
  });

  test('a batch without faults says so; an unknown code and a missed one are named', () => {
    expect(ctx.faultReportHtml({ faults: [], summary: {} })).toContain('No run of this batch asked the simulator for faults');
    const r = D.detect({ runs: [{ runId: 'r', scenarioCode: 'S' }], scenarios: [{ code: 'S', simulatorFaults: 'no.such, answer.html' }], failures: [], warnings: [] });
    const html = ctx.faultReportHtml(r);
    expect(html).toContain('❓ unknown fault code');
    expect(html).toContain('❌ not detected');
    expect(html).toContain('1 unknown');
  });
});
