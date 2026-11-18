// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1312: a run's time, step by step. The steps between the moments the
// server sees (worker/runTimeline.js), and the metric held to what the
// dashboard and the documentation read. Noting the moments is
// runner.test.js's and internal-run-port.test.js's.

const fs = require('node:fs');
const path = require('node:path');
const T = require('../../src/worker/runTimeline');
const metrics = require('../../src/utils/metrics');

const ROOT = path.join(__dirname, '..', '..', '..');
const dashboard = JSON.parse(fs.readFileSync(path.join(ROOT, 'OSCAR_Deploy', 'grafana', 'dashboards', 'oscar-overview.json'), 'utf8'));
const guide = fs.readFileSync(path.join(ROOT, 'Documentation', 'Server_Operations', 'metrics-and-monitoring.md'), 'utf8');

// A moment on the clock, in seconds (halves and quarters are exact).
const at = (seconds) => BigInt(seconds * 1e9);
let made = 0;
const ids = [];
// A run in progress with these moments.
function runWith(marks) {
  const id = `run-${++made}`;
  ids.push(id);
  T.begin(id, at(marks.slot ?? 0));
  for (const [name, seconds] of Object.entries(marks)) {
    if (name !== 'slot') T.mark(id, name, at(seconds));
  }
  return id;
}
afterEach(() => { while (ids.length) T.drop(ids.pop()); });

const POD_RUN = { slot: 0, launched: 0.5, job: 1, pod: 7, output: 8, call: 11, upload: 31, uploaded: 32.5, exit: 34, linked: 35, done: 37 };
const LOCAL_RUN = { slot: 0, launched: 1, call: 3, exit: 20, linked: 21, done: 22 };
const stepsOf = (id, options) => Object.fromEntries(T.stepsOf(id, options).steps.map((s) => [s.step, s.seconds]));

describe('the steps of a run', () => {
  test('a run in a pod: eleven steps, each from the moment before, adding up to the whole', () => {
    const out = T.stepsOf(runWith(POD_RUN), { requestSeconds: 15 });
    expect(out.steps).toEqual([
      { step: 'prepare', seconds: 0.5 },
      { step: 'job', seconds: 0.5 },
      { step: 'pod', seconds: 6 },
      { step: 'folder', seconds: 1 },
      { step: 'bruno_start', seconds: 3 },
      { step: 'requests', seconds: 15 },
      { step: 'reports', seconds: 5 },
      { step: 'send', seconds: 1.5 },
      { step: 'end', seconds: 1.5 },
      { step: 'link', seconds: 1 },
      { step: 'store', seconds: 2 },
    ]);
    expect(out.total).toBe(37);
    expect(out.steps.reduce((sum, s) => sum + s.seconds, 0)).toBe(out.total);
  });

  test('a run in the other modes: no job, pod, folder, send or end; the reports go to Bruno\'s end', () => {
    const out = T.stepsOf(runWith(LOCAL_RUN), { requestSeconds: 10 });
    expect(out.steps).toEqual([
      { step: 'prepare', seconds: 1 },
      { step: 'bruno_start', seconds: 2 },
      { step: 'requests', seconds: 10 },
      { step: 'reports', seconds: 7 },
      { step: 'link', seconds: 1 },
      { step: 'store', seconds: 1 },
    ]);
    expect(out.total).toBe(22);
  });

  test('without Bruno\'s own times, the requests and the reports are one step', () => {
    for (const requestSeconds of [undefined, null, Number.NaN, -1, '10', Infinity]) {
      const steps = stepsOf(runWith(LOCAL_RUN), { requestSeconds });
      expect([requestSeconds, steps.scenario, steps.requests, steps.reports]).toEqual([requestSeconds, 17, undefined, undefined]);
    }
    expect(stepsOf(runWith(LOCAL_RUN)).scenario).toBe(17);
  });

  test('the requests are never more than their span; none at all is 0', () => {
    expect(stepsOf(runWith(LOCAL_RUN), { requestSeconds: 99 })).toMatchObject({ requests: 17, reports: 0 });
    expect(stepsOf(runWith(LOCAL_RUN), { requestSeconds: 0 })).toMatchObject({ requests: 0, reports: 17 });
  });

  test('a step with an end missing is not given', () => {
    // Bruno never called: nothing between the launch and its end.
    expect(Object.keys(stepsOf(runWith({ slot: 0, launched: 1, exit: 9, linked: 10, done: 11 })))).toEqual(['prepare', 'link', 'store']);
    // The dispatcher never said the Job was made: no job, no pod, but the folder.
    expect(Object.keys(stepsOf(runWith({ slot: 0, launched: 1, pod: 5, output: 6 })))).toEqual(['prepare', 'folder']);
    // A run refused before it was launched gives nothing.
    expect(T.stepsOf(runWith({ slot: 0 }))).toEqual({ steps: [], total: null });
  });

  test('a step that would end before it started is not given', () => {
    const steps = stepsOf(runWith({ slot: 0, launched: 1, call: 5, upload: 4, uploaded: 6, exit: 7 }));
    expect(steps.scenario).toBeUndefined();
    expect(steps).toMatchObject({ prepare: 1, bruno_start: 4, send: 2, end: 1 });
  });

  test('Bruno\'s start is counted from the latest moment seen before it', () => {
    const base = { slot: 0, launched: 1, call: 10 };
    expect(stepsOf(runWith({ ...base, job: 2, pod: 4, output: 6 })).bruno_start).toBe(4);
    expect(stepsOf(runWith({ ...base, job: 2, pod: 4 })).bruno_start).toBe(6);
    expect(stepsOf(runWith({ ...base, job: 2 })).bruno_start).toBe(8);
    expect(stepsOf(runWith(base)).bruno_start).toBe(9);
  });

  test('the whole is given once the run is done only', () => {
    expect(T.stepsOf(runWith({ slot: 2, launched: 3 })).total).toBeNull();
    expect(T.stepsOf(runWith({ slot: 2, launched: 3, done: 10 })).total).toBe(8);
  });
});

describe('noting a moment', () => {
  test('the first time only; the last time for a moment that comes again', () => {
    const id = runWith({ slot: 0, launched: 1, call: 2 });
    expect(T.mark(id, 'call', at(9))).toBe(false);
    expect(stepsOf(id).bruno_start).toBe(1);
    expect(T.mark(id, 'upload', at(10))).toBe(true);
    expect(T.markAgain(id, 'uploaded', at(11))).toBe(true);
    expect(T.markAgain(id, 'uploaded', at(14))).toBe(true);
    expect(stepsOf(id).send).toBe(4);
  });

  test('a name that is no moment of a run, or a run not in progress, notes nothing', () => {
    const id = runWith({ slot: 0 });
    const before = T._going();
    expect(T.mark(id, 'constructor')).toBe(false);
    expect(T.markAgain(id, 'nothing')).toBe(false);
    expect(T.mark('not-a-run', 'call')).toBe(false);
    expect(T.markAgain('not-a-run', 'uploaded')).toBe(false);
    expect(T.mark(undefined, 'call')).toBe(false);
    expect(T._going()).toBe(before);
    expect(T.stepsOf('not-a-run')).toEqual({ steps: [], total: null });
  });

  test('the run ended: its moments are forgotten', () => {
    const id = runWith(POD_RUN);
    const before = T._going();
    T.drop(id);
    T.drop(id);
    expect(T._going()).toBe(before - 1);
    expect(T.mark(id, 'call')).toBe(false);
    expect(T.stepsOf(id).steps).toEqual([]);
  });

  test('begin starts a run afresh', () => {
    const id = runWith(POD_RUN);
    T.begin(id, at(100));
    expect(T.stepsOf(id)).toEqual({ steps: [], total: null });
  });
});

describe('the line in the run\'s log', () => {
  test('the whole, then each step in words, to a tenth of a second', () => {
    expect(T.textOf(T.stepsOf(runWith(POD_RUN), { requestSeconds: 15 }))).toBe(
      'Where this run\'s time went (37.0 s from its slot to its final status): preparing the run 0.5 s, '
      + 'asking for its pod 0.5 s, waiting for its pod 6.0 s, its pod preparing the work folder 1.0 s, Bruno starting 3.0 s, '
      + 'the requests 15.0 s, the reports 5.0 s, sending the results 1.5 s, its pod ending 1.5 s, linking the reports 1.0 s, '
      + 'storing the checks 2.0 s.');
    expect(T.textOf(T.stepsOf(runWith({ slot: 0, launched: 1, call: 3, exit: 20 }))))
      .toBe('Where this run\'s time went: preparing the run 1.0 s, Bruno starting 2.0 s, the requests and the reports 17.0 s.');
  });

  test('every step has its words, and no other', () => {
    expect(Object.keys(T.STEP_WORDS).sort()).toEqual([...T.STEP_NAMES].sort());
  });
});

describe('oscar_run_step_seconds', () => {
  const exprs = dashboard.panels.flatMap((p) => (p.targets || []).map((t) => t.expr)).filter((e) => e.includes('oscar_run_step'));

  test('the server writes it, the step as its only label, the steps those a run can give', async () => {
    const written = (await metrics.register.getMetricsAsJSON()).map((f) => f.name);
    expect(written).toContain('oscar_run_step_seconds');
    expect(metrics.runStepSeconds.labelNames).toEqual(['step']);
    expect(metrics.RUN_STEPS).toEqual(T.STEP_NAMES);
    // Every step the two kinds of run give, with and without Bruno's times, is a label.
    const given = new Set([
      ...Object.keys(stepsOf(runWith(POD_RUN), { requestSeconds: 15 })),
      ...Object.keys(stepsOf(runWith(LOCAL_RUN))),
    ]);
    expect([...given].sort()).toEqual([...metrics.RUN_STEPS].sort());
  });

  test('the dashboard reads it by step: the mean with both sides summed by step, the percentile from the buckets', () => {
    expect(exprs).toHaveLength(2);
    const names = [...new Set(exprs.flatMap((e) => e.match(/\boscar_run_step[a-z_]*/g)))].sort();
    expect(names).toEqual(['oscar_run_step_seconds_bucket', 'oscar_run_step_seconds_count', 'oscar_run_step_seconds_sum']);
    const mean = exprs.find((e) => e.includes('_sum'));
    expect(mean.split(' / ').map((side) => side.startsWith('sum by (step) ('))).toEqual([true, true]);
    expect(exprs.find((e) => e.includes('_bucket'))).toMatch(/^histogram_quantile\(0\.95, sum by \(le, step\) \(/);
  });

  test('its row keeps every panel in a place of its own', () => {
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cells = new Set();
    const twice = [];
    for (const p of dashboard.panels) {
      for (let x = p.gridPos.x; x < p.gridPos.x + p.gridPos.w; x++) {
        for (let y = p.gridPos.y; y < p.gridPos.y + p.gridPos.h; y++) {
          if (cells.has(`${x},${y}`)) twice.push(p.id);
          cells.add(`${x},${y}`);
        }
      }
    }
    expect([...new Set(twice)]).toEqual([]);
  });

  test('the dashboard and the documentation say what each step is', () => {
    const panel = dashboard.panels.find((p) => (p.targets || []).some((t) => t.expr.includes('oscar_run_step_seconds_sum')));
    const section = guide.slice(guide.indexOf('### A run\'s time, step by step (#1312)'));
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain('`oscar_run_step_seconds{step}`');
    for (const step of metrics.RUN_STEPS) {
      expect([step, section.includes(`\`${step}\``)]).toEqual([step, true]);
      if (step !== 'scenario') expect([step, new RegExp(`\\b${step}\\b`).test(panel.description)]).toEqual([step, true]);
    }
  });
});

// The moment the Job is made comes from the dispatcher as a message of its
// own: the runner hears it as an event, as it hears the pod's address.
describe('the dispatcher\'s messages, as the runner receives them', () => {
  const net = require('node:net');
  const P = require('../../src/runner-agent/protocol');
  const { RemoteProcess } = require('../../src/worker/remoteProcess');

  test('"started" (the Job is made) is an event, before the pod and its output', async () => {
    const messages = [{ t: 'started' }, { t: 'pod', address: '10.1.0.9' }, { t: 'out', d: 'line\n' }, { t: 'exit', code: 0 }];
    const server = net.createServer((socket) => {
      socket.once('data', () => { for (const msg of messages) socket.write(P.line(msg)); });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const seen = [];
      const proc = new RemoteProcess({ host: '127.0.0.1', port: server.address().port, token: 't'.repeat(40) }, { kind: 'run' });
      proc.on('started', () => seen.push('started'));
      proc.on('pod', (address) => seen.push(`pod ${address}`));
      proc.stdout.on('data', (chunk) => seen.push(`out ${chunk.toString().trim()}`));
      const code = await new Promise((resolve, reject) => { proc.on('close', resolve); proc.on('error', reject); });
      expect(code).toBe(0);
      expect(seen).toEqual(['started', 'pod 10.1.0.9', 'out line']);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });
});
