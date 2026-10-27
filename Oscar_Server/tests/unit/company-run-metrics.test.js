// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1017: runs and their requests by company or provider, for Prometheus, and
// the OSCAR · Overview row that reads them. Never a user in a label.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const m = require('../../src/utils/companyRunMetrics');
const metrics = require('../../src/utils/metrics');

describe('labels', () => {
  test('the company and its distributor, on one short line', () => {
    expect(m.labelsOf({ name: 'Gamma', parent_name: 'Simulator Co' }, 'id')).toEqual({ company: 'Gamma', distributor: 'Simulator Co' });
    expect(m.labelsOf({ name: '  Top\n  level ', parent_name: null }, 'id')).toEqual({ company: 'Top level', distributor: '' });
    expect(m.labelsOf({ name: 'x'.repeat(200) }, 'id').company).toHaveLength(m.MAX_LABEL);
    // A company no longer found keeps its own series.
    expect(m.labelsOf(null, 'abc')).toEqual({ company: 'company abc', distributor: '' });
  });

  test('read once per company, and a failed read is not fatal', () => {
    const reads = [];
    const labelFor = m.labelCache((id) => {
      reads.push(id);
      if (id === 'broken') throw new Error('db');
      return { name: `Co ${id}` };
    });
    expect(labelFor('a')).toEqual({ company: 'Co a', distributor: '' });
    expect(labelFor('a')).toEqual({ company: 'Co a', distributor: '' });
    expect(labelFor('broken')).toEqual({ company: 'company broken', distributor: '' });
    expect(reads).toEqual(['a', 'broken']);
  });

  test('two companies of one name under one distributor are added up', () => {
    const names = { a: { name: 'Same', parent_name: 'D' }, b: { name: 'Same', parent_name: 'D' }, c: { name: 'Same', parent_name: 'E' } };
    const samples = m.gaugeSamples(new Map([
      ['a', { running: 2, queued: 1 }], ['b', { running: 1, queued: 0 }], ['c', { running: 0, queued: 4 }],
    ]), (id) => m.labelsOf(names[id], id));
    expect(samples).toEqual([
      { labels: { company: 'Same', distributor: 'D' }, running: 3, queued: 1 },
      { labels: { company: 'Same', distributor: 'E' }, running: 0, queued: 4 },
    ]);
  });
});

describe('the metrics', () => {
  test('labelled by company and distributor only, never a user', async () => {
    const families = (await metrics.register.getMetricsAsJSON()).filter((f) => f.name.startsWith('oscar_company_'));
    expect(families.map((f) => f.name).sort()).toEqual([
      'oscar_company_run_requests_total', 'oscar_company_runs_finished_total',
      'oscar_company_runs_queued', 'oscar_company_runs_running',
    ]);
    for (const name of ['companyRunsRunning', 'companyRunsQueued', 'companyRunRequests']) {
      expect(metrics[name].labelNames).toEqual(['company', 'distributor']);
    }
    expect(metrics.companyRunsFinished.labelNames).toEqual(['company', 'distributor', 'status']);
  });
});

describe('queue.companyCounts', () => {
  test('running and waiting runs per company', () => {
    jest.isolateModules(() => {
      jest.doMock('../../src/worker/runner', () => ({ executeRun: jest.fn() }));
      const queue = require('../../src/worker/queue');
      queue._runningByCompany.set('a', 2);
      queue._queue.push({ companyId: 'a' }, { companyId: 'b' }, { companyId: 'b' });
      expect(Object.fromEntries(queue.companyCounts())).toEqual({ a: { running: 2, queued: 1 }, b: { running: 0, queued: 2 } });
      queue._queue.length = 0;
      queue._runningByCompany.clear();
    });
  });
});

describe('OSCAR · Overview', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy', 'grafana', 'dashboards', 'oscar-overview.json'), 'utf8'));

  test('the row reads only the metrics the server writes, by company', async () => {
    const written = new Set((await metrics.register.getMetricsAsJSON()).map((f) => f.name));
    const exprs = dashboard.panels.flatMap((p) => (p.targets || []).map((t) => t.expr));
    const names = [...new Set(exprs.flatMap((e) => e.match(/\boscar_company_[a-z_]+/g) || []))].sort();
    expect(names).toEqual([
      'oscar_company_run_requests_total', 'oscar_company_runs_finished_total',
      'oscar_company_runs_queued', 'oscar_company_runs_running',
    ]);
    expect(names.filter((n) => !written.has(n))).toEqual([]);
    expect(exprs.filter((e) => e.includes('oscar_company_')).every((e) => e.includes('by (company)'))).toBe(true);
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Admin → Server Activity', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin.html'), 'utf8');
  const lines = html.split('\n');
  const start = lines.findIndex((l) => l.startsWith('function runsInProgressRows('));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const rows = vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, { esc });

  test('one row per user and company, the names escaped', () => {
    const out = rows([
      { email: 'a@x.com', company: 'Gamma <b>', distributor: 'Sim & Co', running: 2, queued: '1' },
      { email: 'b@x.com', company: 'Top', distributor: null, running: 0, queued: 3 },
    ]);
    expect(out).toContain('Gamma &lt;b&gt;');
    expect(out).toContain('(Sim &amp; Co)');
    expect(out).not.toContain('<b>');
    expect(out.match(/<tr>/g)).toHaveLength(2);
    expect(out).toContain('<td>2</td><td>1</td>');
  });

  test('nothing going says so', () => {
    expect(rows([])).toContain('No run in progress.');
    expect(rows(undefined)).toContain('No run in progress.');
  });
});
