// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulated-errors.test.js — the simulator's deliberate errors, kept apart
 * from the provider's coverage (#1029 PR 2): which scenarios they are, when
 * one is detected, what a published report keeps, and the page's words.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SE = require('../../src/utils/simulatedErrors');
const { forPublication } = require('../../src/utils/coverageReports');
const { coverageWorkbook } = require('../../src/utils/coverageWorkbook');
const { readZipEntry } = require('../../src/utils/zip');

const simulator = require(path.resolve(__dirname, '../../../Bruno_Collection/data_base/simulator_datafile.json'));
const replay = require('../helpers/fault-replay.json');

describe('which scenarios are simulated errors', () => {
  test('SIM_WRONG_, SIM_FAULT_ and a scenario naming faults leave the data file and the run list', () => {
    const df = {
      scenariosToRun: ['A', 'SIM_WRONG_X_38', 'F'],
      scenarios: [{ code: 'A' }, { code: 'SIM_WRONG_X_38' }, { code: 'SIM_FAULT_Y_38' }, { code: 'F', simulatorFaults: 'offer.price-below-parts' }, { code: 'NHF_Z' }],
      tripRequirements: [{ id: 1 }],
    };
    const { datafile, simulated } = SE.splitSimulated(df);
    expect(datafile.scenarios.map((s) => s.code)).toEqual(['A', 'NHF_Z']);
    expect(datafile.scenariosToRun).toEqual(['A']);
    expect(datafile.tripRequirements).toBe(df.tripRequirements);
    expect(simulated.map((s) => s.code)).toEqual(['SIM_WRONG_X_38', 'SIM_FAULT_Y_38', 'F']);
    expect(df.scenarios).toHaveLength(5);
  });

  test('a data file without any is left as it is', () => {
    const df = { scenarios: [{ code: 'A' }], scenariosToRun: 'ALL' };
    expect(SE.splitSimulated(df)).toEqual({ datafile: df, simulated: [] });
    expect(SE.splitSimulated(undefined).simulated).toEqual([]);
  });
});

describe('detected, missed or not run', () => {
  const runOf = (code, failures = []) => ({ id: `run-${code}`, status: failures.length ? 'FAILED' : 'COMPLETED', failed: failures.length, completed_at: '2026-10-28 10:00:00',
    checks: failures.map(([step, check]) => ({ request_name: step, assertion_name: check })) });

  test('a wrong answer is detected when a check failed, missed when none did', () => {
    const r = SE.simulatedErrorsOf([{ code: 'SIM_WRONG_A_38' }, { code: 'SIM_WRONG_B_38' }, { code: 'SIM_WRONG_C_38' }], {
      SIM_WRONG_A_38: runOf('A', [['02. POST Create Booking', 'provisionalPrice is the sum']]), SIM_WRONG_B_38: runOf('B'),
    });
    expect(r.entries.map((e) => [e.code, e.kind, e.result])).toEqual([
      ['SIM_WRONG_A_38', 'wrong', 'detected'], ['SIM_WRONG_B_38', 'wrong', 'missed'], ['SIM_WRONG_C_38', 'wrong', 'not-run'],
    ]);
    expect(r.entries[0]).toMatchObject({ step: '02. POST Create Booking', check: 'provisionalPrice is the sum', runId: 'run-A', at: '2026-10-28 10:00:00' });
    expect(r.summary).toEqual({ total: 3, detected: 1, missed: 1, notRun: 1 });
  });

  test('every fault of the replay is detected, by the fault detection report\'s own rule', () => {
    const faults = simulator.scenarios.filter((s) => s.code in replay);
    expect(faults).toHaveLength(Object.keys(replay).length);
    const runs = Object.fromEntries(faults.map((s) => [s.code, runOf(s.code, replay[s.code].failures)]));
    const warnings = Object.fromEntries(faults.map((s) => [s.code, replay[s.code].warnings]));
    const r = SE.simulatedErrorsOf(faults, runs, warnings);
    expect(r.entries.map((e) => [e.code, e.kind, e.result])).toEqual(faults.map((s) => [s.code, 'fault', 'detected']));
  });

  test('a fault OSCAR did not report is missed, and named', () => {
    const scenario = simulator.scenarios.find((s) => s.code === 'SIM_FAULT_ANSWER_HTML_38');
    const r = SE.simulatedErrorsOf([scenario], { [scenario.code]: runOf(scenario.code, [['01. POST Get Offer', 'something else']]) });
    expect(r.entries[0]).toMatchObject({ kind: 'fault', result: 'missed', check: expect.stringMatching(/^Not reported: /) });
    expect(r.entries[0].faults.every((f) => f.detected === false)).toBe(true);
  });
});

describe('what leaves OSCAR', () => {
  const report = {
    byCapability: {
      points: [], capabilities: [], expectedRefusals: [],
      simulatedErrors: { summary: { total: 1, detected: 1, missed: 0, notRun: 0 }, entries: [{ code: 'SIM_WRONG_A_38', kind: 'wrong', result: 'detected', step: 's', check: 'c', runId: 'r', at: null }] },
    },
  };

  test('a published report never holds them', () => {
    expect(forPublication(report).byCapability).not.toHaveProperty('simulatedErrors');
    expect(report.byCapability).toHaveProperty('simulatedErrors');
  });

  test('the workbook has their sheet only when there are some', () => {
    const names = (buf) => [...readZipEntry(buf, 'xl/workbook.xml').toString().matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names(coverageWorkbook({ days: 30, summary: {}, ...report }, {}))).toContain('Simulated errors');
    expect(names(coverageWorkbook({ days: 30, summary: {}, byCapability: { capabilities: [] } }, {}))).not.toContain('Simulated errors');
  });
});

describe('the Report Builder page', () => {
  const PAGE = fs.readFileSync(path.resolve(__dirname, '../../public/report-builder.html'), 'utf8').replaceAll('\r\n', '\n').split('\n');
  const ctx = { escHtml: require('../../public/js/esc.js').esc, encodeURIComponent };
  const lift = (name) => {
    const start = PAGE.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = PAGE.findIndex((l, i) => i > start && l === '}');
    ctx[name] = vm.runInNewContext(`(${PAGE.slice(start, end + 1).join('\n')})`, ctx);
    return ctx[name];
  };
  for (const name of ['coverageRunIdOf', 'capabilityRunLink', 'mdCell', 'simulatedErrorsLabels', 'simulatedErrorsSummaryText', 'simulatedErrorWhatText', 'simulatedErrorsHtml', 'simulatedErrorsMarkdown']) lift(name);

  test('its words are the server\'s', () => {
    const labels = ctx.simulatedErrorsLabels();
    expect(labels.results).toEqual(SE.RESULT_TEXT);
    expect(labels.kinds).toEqual(SE.KIND_TEXT);
  });

  const se = {
    summary: { total: 3, detected: 1, missed: 1, notRun: 1 },
    entries: [
      { code: 'SIM_WRONG_<A>_38', kind: 'wrong', result: 'detected', step: '02. POST <b>', check: 'price | <x>', runId: '0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b' },
      { code: 'SIM_FAULT_B_38', kind: 'fault', result: 'missed', faults: [{ code: 'answer.html', detected: false }], check: 'Not reported: answer.html', runId: 'not-a-uuid' },
      { code: 'SIM_WRONG_C_38', kind: 'wrong', result: 'not-run', runId: null },
    ],
  };

  test('draws a section of its own, escaped, linking a run by its UUID only', () => {
    const html = ctx.simulatedErrorsHtml(se);
    expect(html).toContain('<h4 class="cov-heading">Simulated errors (3)</h4>');
    expect(html).toContain('1 of 3 detected (1 missed, 1 not run)');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<x>');
    expect(html).toContain('href="/run-detail.html?id=0f0e8a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b"');
    expect(html).not.toContain('not-a-uuid"');
    expect(html).toContain('answer.html (not reported)');
    expect(ctx.simulatedErrorsHtml({ entries: [] })).toBe('');
  });

  test('and its Markdown keeps every row in one table line', () => {
    const lines = ctx.simulatedErrorsMarkdown(se);
    expect(lines).toContain('## Simulated errors');
    const rows = lines.filter((l) => l.startsWith('| SIM_'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(String.raw`price \| \<x>`);
    expect(ctx.simulatedErrorsMarkdown(null)).toEqual([]);
  });
});
