// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1130: the run pods' metrics (RUN_ISOLATION=pod), held to what the
// dashboard and the alert rules read. Recording them is runner.test.js's.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const metrics = require('../../src/utils/metrics');

const DEPLOY = path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy');
const dashboard = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'grafana', 'dashboards', 'oscar-overview.json'), 'utf8'));
const rules = yaml.load(fs.readFileSync(path.join(DEPLOY, 'prometheus', 'alerts', 'oscar-alerts.yml'), 'utf8'));

// The metric names an expression reads, a histogram's series by its own name.
const namesIn = (exprs) => [...new Set(exprs.flatMap((e) => e.match(/\boscar_run_pod[a-z_]*/g) || []))]
  .map((n) => n.replace(/_(bucket|count|sum)$/, ''))
  .filter((n, i, all) => all.indexOf(n) === i)
  .sort();
const outcomesIn = (exprs) => exprs.flatMap((e) => [...e.matchAll(/outcome="([^"]+)"/g)].map((m) => m[1]));

describe('run pods (#1130)', () => {
  let written;
  beforeAll(async () => {
    written = new Set((await metrics.register.getMetricsAsJSON()).map((f) => f.name));
  });

  test('the server writes the two metrics, the outcome as their only label', () => {
    expect(written.has('oscar_run_pod_start_seconds')).toBe(true);
    expect(written.has('oscar_run_pods_ended_total')).toBe(true);
    expect(metrics.runPodsEnded.labelNames).toEqual(['outcome']);
    expect(metrics.RUN_POD_OUTCOMES).toEqual(['ran', 'deadline', 'not_started', 'stopped', 'refused']);
  });

  test('the dashboard\'s row reads them, and nothing the server does not write', () => {
    const exprs = dashboard.panels.flatMap((p) => (p.targets || []).map((t) => t.expr));
    expect(namesIn(exprs)).toEqual(['oscar_run_pod_start_seconds', 'oscar_run_pods_ended_total']);
    expect(namesIn(exprs).filter((n) => !written.has(n))).toEqual([]);
    expect(outcomesIn(exprs).filter((o) => !metrics.RUN_POD_OUTCOMES.includes(o))).toEqual([]);
    expect(exprs.filter((e) => e.includes('oscar_run_pod_start_seconds')).every((e) => e.includes('_bucket') && e.includes('by (le)'))).toBe(true);
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the alerts read the outcomes the server writes', () => {
    const group = rules.groups.find((g) => g.name === 'oscar.run-pods').rules;
    expect(group.map((r) => r.alert)).toEqual(['OscarRunPodsNotStarting', 'OscarRunDispatcherRefusing']);
    const exprs = group.map((r) => r.expr);
    expect(namesIn(exprs)).toEqual(['oscar_run_pods_ended_total']);
    expect(outcomesIn(exprs).sort()).toEqual(['not_started', 'refused']);
    for (const r of group) expect(r.annotations.runbook).toMatch(/Kubernetes and OpenShift Deployment Guide\.md#10a-/);
  });
});
