// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1286: Prometheus matches the two sides of a binary operation label by
// label. oscar_runs_total carries `status`, so
//   rate(oscar_runs_total{status="FAILED"}[15m]) / rate(oscar_runs_total[15m])
// divided the FAILED series by the FAILED series (100 % from one failure),
// and `oscar_queue_depth > 0 and rate(oscar_runs_total[10m]) == 0` matched
// nothing (the alert never fired). A metric the server registers with labels
// is therefore summed (by or without them) wherever an alert combines series.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { register } = require('../../src/utils/metrics');

const DEPLOY = path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy');
const RULE_FILES = [
  ...fs.readdirSync(path.join(DEPLOY, 'prometheus', 'alerts')).filter((f) => f.endsWith('.yml')).map((f) => path.join(DEPLOY, 'prometheus', 'alerts', f)),
  path.join(DEPLOY, 'kubernetes', 'monitoring', 'oscar', 'prometheus-rules.yaml'),
  path.join(DEPLOY, 'kubernetes', 'monitoring', 'oscar', 'cluster-rules.yaml'),
];

function alertsOf(file) {
  const out = [];
  for (const doc of yaml.loadAll(fs.readFileSync(file, 'utf8'))) {
    for (const group of doc?.groups || doc?.spec?.groups || []) {
      for (const rule of group.rules || []) if (rule.alert) out.push({ file: path.basename(file), alert: rule.alert, expr: String(rule.expr) });
    }
  }
  return out;
}

// The server's metrics that carry labels, and the names their histograms add.
function labelledMetrics() {
  const names = [];
  for (const m of register.getMetricsAsArray()) {
    if (!(m.labelNames || []).length) continue;
    names.push(m.name);
    if (m.constructor?.name === 'Histogram') names.push(`${m.name}_bucket`, `${m.name}_sum`, `${m.name}_count`);
  }
  return names;
}

const AGGREGATION = /\b(?:sum|avg|min|max|count)\s*(?:(?:by|without)\s*\([^()]*\)\s*)?$/;

// Whether the text at `at` sits inside an aggregation's parentheses.
function insideAggregation(expr, at) {
  const open = [];
  for (let i = 0; i < at; i++) {
    if (expr[i] === '(') open.push(AGGREGATION.test(expr.slice(Math.max(0, i - 80), i)));
    else if (expr[i] === ')') open.pop();
  }
  return open.includes(true);
}

// The places where a labelled metric meets another series without being
// summed first. Quoted label values are left out of the operator search.
function mismatches(expr, metrics) {
  const bare = expr.replace(/"[^"]*"/g, '""');
  if (!/\/|\band\b|\bunless\b|\bor\b|\*|(?<![<>=!])-(?!\d)|\+/.test(bare)) return [];
  const found = [];
  for (const name of metrics) {
    const word = new RegExp(`\\b${name}\\b(?!_)`, 'g');
    for (const m of bare.matchAll(word)) if (!insideAggregation(bare, m.index)) found.push(name);
  }
  return found;
}

describe('alert rules sum a labelled metric before combining it (#1286)', () => {
  const metrics = labelledMetrics();

  test('the server registers oscar_runs_total with its status label', () => {
    expect(metrics).toContain('oscar_runs_total');
  });

  test('the check refuses the two rules as they were, and takes them as they are', () => {
    const before = [
      'oscar_queue_depth > 0 and rate(oscar_runs_total[10m]) == 0',
      '(rate(oscar_runs_total{status="FAILED"}[15m]) / (rate(oscar_runs_total[15m]) > 0)) > 0.5',
    ];
    for (const expr of before) expect(mismatches(expr, metrics)).toContain('oscar_runs_total');
    const after = [
      'oscar_queue_depth > 0 unless sum without (status) (rate(oscar_runs_total[10m])) > 0',
      '(sum without (status) (rate(oscar_runs_total{status="FAILED"}[15m])) / (sum without (status) (rate(oscar_runs_total[15m])) > 0)) > 0.5',
    ];
    for (const expr of after) expect(mismatches(expr, metrics)).toEqual([]);
    // A single series compared with a number needs no sum.
    expect(mismatches('rate(oscar_runs_total{status="FAILED"}[15m]) > 1', metrics)).toEqual([]);
  });

  test.each(RULE_FILES.map((f) => [path.basename(f), f]))('%s: no labelled metric meets another series unsummed', (_name, file) => {
    const wrong = alertsOf(file).map((r) => ({ alert: r.alert, metrics: mismatches(r.expr, metrics) })).filter((r) => r.metrics.length);
    expect(wrong).toEqual([]);
  });

  test('the two rules of #1286 are summed over status on the VPS and in the cluster copy', () => {
    for (const file of RULE_FILES.slice(0, -1)) {
      const rules = Object.fromEntries(alertsOf(file).map((r) => [r.alert, r.expr.replace(/\s+/g, ' ').trim()]));
      if (!rules.OscarRunFailureRateHigh) continue;
      expect(rules.OscarRunFailureRateHigh).toContain('sum without (status) (rate(oscar_runs_total{status="FAILED"}[15m])) / (sum without (status) (rate(oscar_runs_total[15m])) > 0)');
      expect(rules.OscarQueueStuck).toBe('oscar_queue_depth > 0 unless sum without (status) (rate(oscar_runs_total[10m])) > 0');
    }
  });
});
