// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1005: the Grafana dashboard, the alert rules and the scrape job of the
// simulator name only metrics OSCAR's relay writes. A metric renamed on one
// side fails here, not as an empty panel or an alert that never fires.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { renderSimulatorMetrics } = require('../../src/utils/simulatorMetricsText');

const DEPLOY = path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy');
const NAMES = /\b(?:osdm_sim|oscar_simulator)_[a-z0-9_]+/g;

const FULL = {
  version: 'x',
  uptimeSeconds: 1,
  process: { residentBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, cpuUserSeconds: 1, cpuSystemSeconds: 1, eventLoop: { p99Seconds: 1, maxSeconds: 1 } },
  host: { memoryTotal: 1, memoryAvailable: 1, swapTotal: 1, swapFree: 1, cpus: 1, load: [1, 1, 1], cpuSeconds: { user: 1 }, disk: { total: 1, free: 1 } },
  requests: [{ provider: 'gamma', method: 'GET', status: 200, count: 1 }],
  durations: { buckets: [1], byProvider: { gamma: { counts: [1], sum: 1, count: 1 } } },
  rateLimited: { trusted: 1, others: 1 },
  store: { offer: 1 },
};

const written = new Set(renderSimulatorMetrics(FULL, { up: true, configured: true })
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/[{ ]/)[0]));

function namesIn(texts) {
  return [...new Set(texts.flatMap((t) => t.match(NAMES) || []))].sort();
}

test('every metric the dashboard queries is one the relay writes', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'grafana', 'dashboards', 'osdm-simulator.json'), 'utf8'));
  expect(dashboard.uid).toBe('osdm-simulator');
  const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr));
  const names = namesIn(exprs);
  expect(names.length).toBeGreaterThan(15);
  expect(names.filter((n) => !written.has(n))).toEqual([]);
  const ids = dashboard.panels.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('every metric the alert rules read is one the relay writes', () => {
  const rules = yaml.load(fs.readFileSync(path.join(DEPLOY, 'prometheus', 'alerts', 'osdm-simulator-alerts.yml'), 'utf8'));
  const exprs = rules.groups.flatMap((g) => g.rules.map((r) => r.expr));
  expect(namesIn(exprs).filter((n) => !written.has(n))).toEqual([]);
  expect(rules.groups[0].rules.map((r) => r.alert)).toContain('SimulatorUnreachable');
});

test('Prometheus scrapes the simulator through OSCAR, with no key of its own', () => {
  const config = yaml.load(fs.readFileSync(path.join(DEPLOY, 'prometheus', 'prometheus.yml'), 'utf8'));
  const job = config.scrape_configs.find((j) => j.job_name === 'osdm-simulator');
  expect(job).toMatchObject({ metrics_path: '/metrics', params: { source: ['simulator'] } });
  expect(job.static_configs[0].targets).toEqual(['oscar:3001']);
  expect(job.authorization).toBeUndefined();
  expect(job.basic_auth).toBeUndefined();
});
