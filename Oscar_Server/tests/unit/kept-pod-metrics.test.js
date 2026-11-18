// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Kept run pods in the metrics, OSCAR · Overview and the alerts (#1309; part
 * 5 = #1324): what the server writes is what the dashboard and the alert read.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { randomUUID } = require('node:crypto');
const metrics = require('../../src/utils/metrics');
const keptPods = require('../../src/worker/keptPods');

const DEPLOY = path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy');
const dashboard = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'grafana', 'dashboards', 'oscar-overview.json'), 'utf8'));
const rules = yaml.load(fs.readFileSync(path.join(DEPLOY, 'prometheus', 'alerts', 'oscar-alerts.yml'), 'utf8'));
const clusterRules = yaml.loadAll(fs.readFileSync(path.join(DEPLOY, 'kubernetes', 'monitoring', 'oscar', 'prometheus-rules.yaml'), 'utf8'));

const NAMES = ['oscar_kept_pod_runs_total', 'oscar_kept_pods', 'oscar_kept_pods_stopped_total'];
const keptNamesIn = (exprs) => [...new Set(exprs.flatMap((e) => e.match(/\boscar_kept_pod[a-z_]*/g) || []))].sort();

afterEach(() => keptPods._clear());

describe('the metrics', () => {
  test('the server writes the three, each with its one label', async () => {
    const written = new Set((await metrics.register.getMetricsAsJSON()).map((f) => f.name));
    for (const name of NAMES) expect([name, written.has(name)]).toEqual([name, true]);
    expect(metrics.keptPodsByState.labelNames).toEqual(['state']);
    expect(metrics.keptPodRuns.labelNames).toEqual(['pod']);
    expect(metrics.keptPodsStopped.labelNames).toEqual(['reason']);
    expect(metrics.KEPT_POD_STATES).toEqual(['new', 'waiting', 'running']);
    expect(metrics.KEPT_POD_RUNS).toEqual(['first', 'again']);
  });

  test('the pods by state are read from the pods\' record at each scrape', async () => {
    const batch = { companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID() };
    keptPods.open(batch);
    keptPods.open(batch);
    const waiting = keptPods.open(batch);
    const answer = keptPods.ask(waiting.secret, '10.42.0.17', null);
    await new Promise((r) => setImmediate(r));
    const values = (await metrics.keptPodsByState.get()).values;
    const of = (state) => values.find((v) => v.labels.state === state)?.value;
    expect([of('new'), of('waiting'), of('running')]).toEqual([2, 1, 0]);
    keptPods.endBatch(batch);
    await answer;
    const after = (await metrics.keptPodsByState.get()).values;
    expect(after.map((v) => v.value)).toEqual([0, 0, 0]);
  });

  test('the states counted are the record\'s own', () => {
    const batch = { companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID() };
    keptPods.open(batch);
    expect(metrics.KEPT_POD_STATES).toContain(keptPods.snapshot()[0].state);
  });
});

describe('OSCAR · Overview', () => {
  const row = dashboard.panels.find((p) => p.type === 'row' && /^Kept run pods/.test(p.title));
  const panels = dashboard.panels.filter((p) => p.type !== 'row' && p.gridPos.y === row.gridPos.y + 1);

  test('a row of three panels, under the steps of a run, ids unique', () => {
    expect(row.title).toBe('Kept run pods, RUN_KEPT_PODS=on (#1309)');
    expect(panels.map((p) => p.title)).toEqual(['Kept pods, by state', 'Runs handed to a kept pod, a minute', 'Kept pods given up, by reason, in 15 minutes']);
    const steps = dashboard.panels.find((p) => p.type === 'row' && /^A run's time, step by step/.test(p.title));
    expect(row.gridPos.y).toBeGreaterThan(steps.gridPos.y);
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No two panels share a place.
    const cells = new Set();
    for (const p of dashboard.panels) {
      for (let y = p.gridPos.y; y < p.gridPos.y + p.gridPos.h; y++) {
        for (let x = p.gridPos.x; x < p.gridPos.x + p.gridPos.w; x++) {
          const cell = `${x},${y}`;
          expect([p.id, cell, cells.has(cell)]).toEqual([p.id, cell, false]);
          cells.add(cell);
        }
      }
    }
  });

  test('the panels read the metrics the server writes, by their labels', () => {
    const exprs = panels.flatMap((p) => p.targets.map((t) => t.expr));
    expect(keptNamesIn(exprs)).toEqual(NAMES);
    expect(exprs).toEqual([
      'sum by (state) (oscar_kept_pods)',
      'sum by (pod) (rate(oscar_kept_pod_runs_total[5m])) * 60',
      'sum by (reason) (increase(oscar_kept_pods_stopped_total[15m]))',
    ]);
  });
});

describe('the alert', () => {
  const group = rules.groups.find((g) => g.name === 'oscar.kept-pods');

  test('a call the pod\'s program never makes is critical, by the reason the server writes', () => {
    expect(group.rules.map((r) => r.alert)).toEqual(['OscarKeptPodProtocolFault']);
    const [rule] = group.rules;
    expect(rule.expr).toBe('sum(increase(oscar_kept_pods_stopped_total{reason="protocol"}[15m])) > 0');
    expect(keptPods.STOP.PROTOCOL).toBe('protocol');
    expect(rule.labels.severity).toBe('critical');
    expect(rule.annotations.runbook).toBe('Documentation/Server_Operations/OSCAR - k3s on one VPS.md#kept-run-pods');
  });

  test('the runbook\'s section exists, and the cluster has the same rule', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Server_Operations', 'OSCAR - k3s on one VPS.md'), 'utf8');
    expect(guide).toMatch(/^### Kept run pods$/m);
    const cluster = clusterRules.find((d) => d?.kind === 'PrometheusRule').spec.groups.find((g) => g.name === 'oscar.kept-pods');
    expect(cluster.rules.map((r) => [r.alert, r.expr])).toEqual(group.rules.map((r) => [r.alert, r.expr]));
  });
});

describe('the manifests and the proof on a cluster', () => {
  const K8S = path.join(DEPLOY, 'kubernetes');
  const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

  test('off by default: in the base settings and the k3s overlay, never set by the component', () => {
    expect(read(K8S, 'base', 'settings.env')).toMatch(/^RUN_KEPT_PODS=off$/m);
    const overlay = yaml.load(read(K8S, 'overlays', 'k3s', 'kustomization.yaml'));
    const settings = overlay.configMapGenerator.find((g) => g.name === 'oscar-settings');
    expect(settings.behavior).toBe('merge');
    expect(settings.literals).toContain('RUN_KEPT_PODS=off');
    const component = yaml.load(read(K8S, 'components', 'pod-runs', 'kustomization.yaml'));
    const set = component.configMapGenerator.flatMap((g) => g.literals || []);
    expect(set.filter((l) => l.startsWith('RUN_KEPT_PODS='))).toEqual([]);
  });

  test('the guide\'s line finds the overlay\'s setting once, and sets it either way', () => {
    const guide = read(__dirname, '..', '..', '..', 'Documentation', 'Server_Operations', 'OSCAR - k3s on one VPS.md');
    const seds = guide.match(/sed -i "s\/RUN_KEPT_PODS=o\[nf\]\*\/RUN_KEPT_PODS=\$KEPT_PODS\/" OSCAR_Deploy\/kubernetes\/overlays\/site\/kustomization\.yaml/g);
    expect(seds).toHaveLength(2);                         // the release block and the switch
    const overlay = read(K8S, 'overlays', 'k3s', 'kustomization.yaml');
    expect(overlay.match(/RUN_KEPT_PODS=o[nf]*/g)).toEqual(['RUN_KEPT_PODS=off']);
    const on = overlay.replace(/RUN_KEPT_PODS=o[nf]*/, 'RUN_KEPT_PODS=on');
    expect(on.replace(/RUN_KEPT_PODS=o[nf]*/, 'RUN_KEPT_PODS=off')).toBe(overlay);
  });

  test('kind and k3s switch it on and run ci/kept-pods.sh, on scenarios the simulator has', () => {
    const workflow = yaml.load(read(__dirname, '..', '..', '..', '.github', 'workflows', 'ci-kubernetes.yml'));
    for (const job of ['kind', 'k3s']) {
      const step = workflow.jobs[job].steps.find((s) => /kept-pods\.sh/.test(s.run || ''));
      expect([job, Boolean(step)]).toEqual([job, true]);
      expect(step.run).toMatch(/kubectl -n oscar set env deployment\/oscar RUN_KEPT_PODS=on/);
      expect(step.run).toMatch(/SMOKE_ACCOUNT_FILE=/);
    }
    const script = read(K8S, 'ci', 'kept-pods.sh');
    const codes = JSON.parse(/^scenarios='(\[.*\])'$/m.exec(script)[1]);
    const datafile = JSON.parse(read(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json'));
    for (const code of codes) expect([code, datafile.scenarios.some((s) => s.code === code)]).toEqual([code, true]);
    expect(codes).toHaveLength(3);
  });
});

describe('the counters, where they are written', () => {
  test('a pod given up is counted by its reason; a run handed by first or again', async () => {
    const starter = require('../../src/worker/keptPodStarter');
    const pool = require('../../src/worker/keptRunPool');
    const runSecrets = require('../../src/utils/runSecrets');
    const { EventEmitter } = require('node:events');
    const before = async (metric, label, value) => (await metric.get()).values.find((v) => v.labels[label] === value)?.value || 0;
    const stoppedBefore = await before(metrics.keptPodsStopped, 'reason', 'batch-done');
    const firstBefore = await before(metrics.keptPodRuns, 'pod', 'first');
    const againBefore = await before(metrics.keptPodRuns, 'pod', 'again');
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    const batch = { companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID() };
    let secret;
    const started = starter.startKeptPod(batch, { deadlineSeconds: 600, launch: (r) => { secret = r.podSecret; return proc; }, log: { info() {}, warn() {} } });
    keptPods.configure({ hasResults: async () => true });
    pool.configure({ queuedOf: () => 1 });
    const runOf = () => {
      const runId = randomUUID();
      return { runId, envName: 'E', envYml: 'eA==', deadlineSeconds: 600, env: { OSCAR_RUN_SECRET: runSecrets.issue(runId, batch.companyId) } };
    };
    try {
      let call = keptPods.ask(secret, '10.42.0.17', null);
      await new Promise((r) => setImmediate(r));
      const a = runOf();
      pool.launchKeptRun({ batch, run: a });
      await call;
      call = keptPods.ask(secret, '10.42.0.17', { runId: a.runId, code: 0 });
      await new Promise((r) => setImmediate(r));
      const b = runOf();
      pool.launchKeptRun({ batch, run: b });
      await call;
      expect(await before(metrics.keptPodRuns, 'pod', 'first')).toBe(firstBefore + 1);
      expect(await before(metrics.keptPodRuns, 'pod', 'again')).toBe(againBefore + 1);
      keptPods.forget(started.podId, keptPods.STOP.BATCH_DONE);
      expect(await before(metrics.keptPodsStopped, 'reason', 'batch-done')).toBe(stoppedBefore + 1);
    } finally {
      pool._clear();
      starter._clear();
      runSecrets._clear();
    }
  });
});
