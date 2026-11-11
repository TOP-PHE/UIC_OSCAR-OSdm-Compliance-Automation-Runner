// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1205: what each run costs the server's one thread, measured. On the k3s
// test machine, four providers' batches at once made pages take more than
// 10 s, with CPU, memory and disk far from their limits. The work done
// for a run on the server's thread (its data file copy, its results stored,
// its log lines) and the run pods' own calls were measured nowhere. These
// tests hold the metrics to the code that writes them and to what the
// dashboard and the alerts read.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const yaml = require('js-yaml');
const metrics = require('../../src/utils/metrics');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DASHBOARDS = 'OSCAR_Deploy/grafana/dashboards';
const ALERTS = 'OSCAR_Deploy/prometheus/alerts';
const overview = JSON.parse(read(`${DASHBOARDS}/oscar-overview.json`));
const exprsOf = (dashboard) => dashboard.panels.flatMap((p) => (p.targets || []).map((t) => t.expr));

// The metrics of the server's own registry: the process, HTTP and run
// metrics. The host's lines and the simulator's relay are written apart,
// and pinned by host-metrics.test.js and simulator-monitoring-config.test.js.
const OWN = /\boscar_(?:node|http|run_work|run_log)_[a-z0-9_]+/g;

async function typesWritten() {
  return new Map((await metrics.register.getMetricsAsJSON()).map((f) => [f.name, f.type]));
}

// Every series an expression reads, by name and by the series it asks for.
function seriesIn(text) {
  return [...new Set(text.match(OWN) || [])].map((s) => {
    const m = /^(.*)_(bucket|sum|count)$/.exec(s);
    return m ? { series: s, name: m[1], part: m[2] } : { series: s, name: s, part: null };
  });
}

// A series that the server writes: a histogram's _bucket/_sum/_count only for
// a histogram, a name alone only for what is not one.
function notWritten(text, types) {
  return seriesIn(text).filter(({ series, name, part }) => {
    if (part && types.get(name) === 'histogram') return false;
    return types.get(series) === undefined || types.get(series) === 'histogram';
  }).map((s) => s.series);
}

describe('the metrics of run work (#1205)', () => {
  test('the server writes them, the kind of work their one label', async () => {
    const types = await typesWritten();
    expect(types.get('oscar_run_work_seconds')).toBe('histogram');
    expect(types.get('oscar_run_log_lines_total')).toBe('counter');
    expect(types.get('oscar_run_log_seconds_total')).toBe('counter');
    expect(metrics.runWork.labelNames).toEqual(['work']);
    expect(metrics.RUN_WORK_KINDS).toEqual(['datafile_copy', 'results_store']);
  });

  test('timeRunWork() gives the work\'s result and counts it once, failed or not', async () => {
    const before = await countOf('datafile_copy');
    expect(metrics.timeRunWork('datafile_copy', () => 42)).toBe(42);
    expect(() => metrics.timeRunWork('datafile_copy', () => { throw new Error('broken'); })).toThrow('broken');
    expect(await countOf('datafile_copy')).toBe(before + 2);
  });

  test('the server times each kind where it runs, and every log line', () => {
    const server = read('Oscar_Server/src/server.js');
    const runner = read('Oscar_Server/src/worker/runner.js');
    const timed = [...`${server}\n${runner}`.matchAll(/timeRunWork\('([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(timed).toEqual([...metrics.RUN_WORK_KINDS].sort());
    expect(server).toMatch(/timeRunWork\('datafile_copy', \(\) => \{\s+const made = withTripCalendars\(withFrameworkWarnings\(/);
    expect(runner).toMatch(/timeRunWork\('results_store', \(\) => extractStructuredResults\(/);
    const logEvent = runner.slice(runner.indexOf('function logEvent('), runner.indexOf('\n}\n', runner.indexOf('function logEvent(')));
    expect(logEvent).toContain('metrics.runLogLines.inc()');
    expect(logEvent).toContain('metrics.runLogSeconds.inc(');
  });
});

async function countOf(work) {
  const json = await metrics.runWork.get();
  const count = json.values.find((v) => v.metricName === 'oscar_run_work_seconds_count' && v.labels.work === work);
  return count ? count.value : 0;
}

describe('the listener of a request (#1205)', () => {
  test('the app\'s requests read public, the run pods\' calls internal', async () => {
    const pub = express();
    pub.use(metrics.httpDurationMiddleware);
    pub.get('/v1/health', (req, res) => res.json({ ok: true }));
    const internal = express();
    internal.use(metrics.httpDurationMiddlewareFor('internal'));
    internal.get('/data/:filename', (req, res) => res.json({}));
    await request(pub).get('/v1/health');
    await request(internal).get('/data/acme-datafile.json');
    const text = await metrics.register.getSingleMetricAsString('oscar_http_request_duration_seconds');
    expect(text).toMatch(/_count\{listener="public",method="GET",route="\/v1\/health",status_code="200"\}/);
    expect(text).toMatch(/_count\{listener="internal",method="GET",route="\/data\/:filename",status_code="200"\}/);
    expect(text).not.toContain('acme-datafile');
  });

  test('server.js measures the internal port before its first route', () => {
    const server = read('Oscar_Server/src/server.js');
    const measured = server.indexOf("internalApp.use(metrics.httpDurationMiddlewareFor('internal'));");
    const firstRoute = server.search(/internalApp\.(get|post|put)\(/);
    expect(measured).toBeGreaterThan(-1);
    expect(measured).toBeLessThan(firstRoute);
    expect(server).toContain('app.use(metrics.httpDurationMiddleware);');
  });

  test('a request waiting 30 or 60 s is told from one waiting 10', () => {
    const buckets = metrics.register.getSingleMetric('oscar_http_request_duration_seconds').upperBounds;
    expect(buckets.slice(-3)).toEqual([10, 30, 60]);
  });
});

describe('what the dashboard and the alerts read', () => {
  test('the thread row reads the run work, the event loop and the listener', () => {
    const row = overview.panels.find((p) => p.type === 'row' && p.title.includes('#1205'));
    expect(row).toBeDefined();
    const after = overview.panels.filter((p) => p.gridPos.y > row.gridPos.y);
    const exprs = exprsOf({ panels: after }).join('\n');
    for (const name of ['oscar_run_work_seconds_sum', 'oscar_run_work_seconds_bucket', 'oscar_run_log_seconds_total',
      'oscar_run_log_lines_total', 'oscar_node_nodejs_eventloop_lag_max_seconds', 'oscar_node_nodejs_eventloop_lag_p99_seconds']) {
      expect(exprs).toContain(name);
    }
    expect(exprs).toMatch(/sum by \(le, listener, method, route\) \(rate\(oscar_http_request_duration_seconds_bucket/);
  });

  test('the panels of pages and API leave the run pods\' calls out', () => {
    const http = overview.panels.filter((p) => exprsOf({ panels: [p] }).some((e) => e.includes('oscar_http_request_duration_seconds'))
      && !exprsOf({ panels: [p] }).some((e) => e.includes('listener, method, route')));
    expect(http.length).toBe(4);
    for (const p of http) {
      expect(p.title).toMatch(/\(pages and API\)$/);
      for (const e of exprsOf({ panels: [p] })) expect(e).toContain('oscar_http_request_duration_seconds_' + (e.includes('_count') ? 'count' : 'bucket') + '{listener!="internal"}');
    }
  });

  test('every dashboard and alert reads only series the server writes', async () => {
    const types = await typesWritten();
    const files = [
      ...fs.readdirSync(path.join(ROOT, DASHBOARDS)).map((f) => `${DASHBOARDS}/${f}`),
      ...fs.readdirSync(path.join(ROOT, ALERTS)).map((f) => `${ALERTS}/${f}`),
    ];
    const wrong = files.flatMap((f) => notWritten(read(f), types).map((s) => `${f}: ${s}`));
    expect(wrong).toEqual([]);
  });

  test('the check sees a histogram read from a gauge (the event loop alert until #1205)', async () => {
    const types = await typesWritten();
    expect(notWritten('histogram_quantile(0.99, rate(oscar_node_nodejs_eventloop_lag_seconds_bucket[5m])) > 0.2', types))
      .toEqual(['oscar_node_nodejs_eventloop_lag_seconds_bucket']);
    expect(notWritten('rate(oscar_run_work_seconds[1m])', types)).toEqual(['oscar_run_work_seconds']);
    expect(notWritten('oscar_node_nodejs_eventloop_lag_p99_seconds > 0.2', types)).toEqual([]);
  });

  test('the event loop alert reads the p99 gauge, on the VPS and on a cluster', () => {
    const rule = (doc) => doc.groups.flatMap((g) => g.rules).find((r) => r.alert === 'OscarEventLoopLag');
    const vps = rule(yaml.load(read(`${ALERTS}/oscar-alerts.yml`)));
    expect(vps.expr).toBe('oscar_node_nodejs_eventloop_lag_p99_seconds > 0.2');
    const cluster = yaml.loadAll(read('OSCAR_Deploy/kubernetes/monitoring/oscar/prometheus-rules.yaml'))
      .filter(Boolean).map((d) => rule(d.spec)).find(Boolean);
    expect(cluster.expr).toBe(vps.expr);
  });
});
