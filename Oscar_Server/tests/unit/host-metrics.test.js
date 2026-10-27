// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1013: the OSCAR server's machine and the processes it starts for runs, in
// its /metrics; the dashboard row and the alerts read only what it writes.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const h = require('../../src/utils/hostMetrics');

const MEMINFO = [
  'MemTotal:       12000000 kB',
  'MemFree:          700000 kB',
  'MemAvailable:    2600000 kB',
  'SwapTotal:       4194300 kB',
  'SwapFree:        4000000 kB',
].join('\n');
const STAT = 'cpu  60000 0 9000 30000 500 0 300 100 0 0\ncpu0 10000 0 1500 5000 80 0 50 20 0 0\n';

// A /proc where the server is pid 1 with two Bruno children and one
// grandchild, and a process whose name holds a bracket and a space.
function fakeProc(overrides = {}) {
  const files = {
    '/proc/meminfo': MEMINFO,
    '/proc/loadavg': '29.67 23.49 13.34 40/700 4242\n',
    '/proc/stat': STAT,
    '/sys/fs/cgroup/memory.current': '8037000000\n',
    '/sys/fs/cgroup/memory.max': 'max\n',
    '/proc/1/stat': '1 (node) S 0 1 1 0 -1',
    '/proc/20/stat': '20 (node) R 1 20 1 0 -1',
    '/proc/20/status': 'Name:\tnode\nVmRSS:\t  300000 kB\n',
    '/proc/21/stat': '21 (odd) name) S 1 21 1 0 -1',
    '/proc/21/status': 'Name:\todd\nVmRSS:\t  100000 kB\n',
    '/proc/30/stat': '30 (sh) S 20 30 1 0 -1',
    '/proc/30/status': 'VmRSS:\t  999999 kB\n',
    ...overrides,
  };
  return {
    readFile: (file) => {
      if (files[file] === undefined) throw new Error('ENOENT');
      return files[file];
    },
    readdir: () => ['1', '20', '21', '30', 'self', 'meminfo', '99'],
    ownPid: 1,
    cpus: () => 6,
  };
}

describe('the parsers', () => {
  test('/proc/meminfo, loadavg and stat', () => {
    expect(h.parseMeminfo(MEMINFO)).toEqual({
      memoryTotal: 12000000 * 1024, memoryAvailable: 2600000 * 1024, swapTotal: 4194300 * 1024, swapFree: 4000000 * 1024,
    });
    // No swap lines: no swap, not "unreadable".
    expect(h.parseMeminfo('MemTotal: 2 kB\nMemAvailable: 1 kB')).toEqual({ memoryTotal: 2048, memoryAvailable: 1024, swapTotal: 0, swapFree: 0 });
    expect(h.parseMeminfo('SwapTotal: 1 kB')).toBeNull();
    expect(h.parseLoadavg('29.67 23.49 13.34 40/700 4242')).toEqual([29.67, 23.49, 13.34]);
    expect(h.parseLoadavg('')).toBeNull();
    expect(h.parseCpuSeconds(STAT)).toEqual({ user: 600, nice: 0, system: 90, idle: 300, iowait: 5, irq: 0, softirq: 3, steal: 1 });
    expect(h.parseCpuSeconds('intr 1')).toBeNull();
  });

  test('a process\'s parent is read after the last bracket of its name', () => {
    expect(h.parentOf('21 (odd) name) S 1 21')).toBe(1);
    expect(h.parentOf('no bracket')).toBeNull();
    expect(h.residentOf('VmRSS:\t  42 kB')).toBe(42 * 1024);
    expect(h.residentOf('Name: x')).toBe(0);
    expect(h.cgroupNumber('max')).toBeNull();
    expect(h.cgroupNumber('123\n')).toBe(123);
  });
});

describe('snapshot', () => {
  test('the machine, the container and the server\'s own children only', () => {
    const s = h.snapshot(fakeProc());
    expect(s.cpus).toBe(6);
    expect(s.load).toEqual([29.67, 23.49, 13.34]);
    expect(s.memory.memoryAvailable).toBe(2600000 * 1024);
    // cgroup v2 with no limit.
    expect(s.container).toEqual({ used: 8037000000, limit: null });
    // 20 and 21 are the server's; 30 is 20's child, 1 is the server itself.
    expect(s.children).toEqual({ count: 2, resident: 400000 * 1024 });
  });

  test('cgroup v1, with and without a limit', () => {
    const v1 = (limit) => ({
      '/sys/fs/cgroup/memory.current': undefined,
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': '5000\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': limit,
    });
    expect(h.snapshot(fakeProc(v1('9000\n'))).container).toEqual({ used: 5000, limit: 9000 });
    expect(h.snapshot(fakeProc(v1('9223372036854771712\n'))).container).toEqual({ used: 5000, limit: null });
  });

  test('nothing readable gives no line, never a 0 an alert would believe', () => {
    const none = { readFile: () => { throw new Error('ENOENT'); }, readdir: () => { throw new Error('ENOENT'); }, ownPid: 1, cpus: () => 6 };
    const s = h.snapshot(none);
    expect(s).toEqual({ memory: null, load: null, cpuSeconds: null, cpus: 6, container: null, children: null });
    const text = h.hostMetricsText(s);
    expect(text).toBe('# HELP oscar_host_cpus CPUs of the OSCAR server\'s machine.\n# TYPE oscar_host_cpus gauge\noscar_host_cpus 6\n');
    expect(text).not.toContain('memory_available');
  });

  test('the text: one HELP and TYPE per family, CPU time a counter, no process name or path', () => {
    const text = h.hostMetricsText(h.snapshot(fakeProc()));
    expect(text).toContain('oscar_host_load{period="5m"} 23.49');
    expect(text).toContain('# TYPE oscar_host_cpu_seconds_total counter');
    expect(text).toContain('oscar_host_cpu_seconds_total{mode="iowait"} 5');
    expect(text).toContain('oscar_run_processes 2');
    expect(text).toContain(`oscar_run_processes_resident_memory_bytes ${400000 * 1024}`);
    expect(text).not.toContain('oscar_container_memory_limit_bytes');
    expect(text).not.toMatch(/odd|node|sh\b/);
    const helps = text.split('\n').filter((l) => l.startsWith('# HELP')).map((l) => l.split(' ')[2]);
    expect(new Set(helps).size).toBe(helps.length);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('the real machine can be read', () => {
    const s = h.snapshot();
    expect(s.cpus).toBeGreaterThan(0);
    if (process.platform === 'linux') {
      expect(s.memory.memoryTotal).toBeGreaterThan(0);
      expect(s.children.count).toBeGreaterThanOrEqual(0);
    }
  });
});

// The dashboard row and the alerts name only metrics the server writes.
describe('the dashboard and the alerts', () => {
  const DEPLOY = path.join(__dirname, '..', '..', '..', 'OSCAR_Deploy');
  const NAMES = /\boscar_(?:host|container|run_processes)[a-z0-9_]*/g;
  const written = new Set(h.hostMetricsText(h.snapshot(fakeProc({ '/sys/fs/cgroup/memory.max': '9000000000' })))
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/[{ ]/)[0]));
  const namesIn = (texts) => [...new Set(texts.flatMap((t) => t.match(NAMES) || []))].sort();

  test('every host metric of OSCAR · Overview is one the server writes', () => {
    const dashboard = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'grafana', 'dashboards', 'oscar-overview.json'), 'utf8'));
    const exprs = dashboard.panels.flatMap((p) => (p.targets || []).map((t) => t.expr));
    const names = namesIn(exprs);
    expect(names.length).toBeGreaterThanOrEqual(9);
    expect(names.filter((n) => !written.has(n))).toEqual([]);
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The load carries a "period" label the CPU count has not: without
    // ignoring(period) the division matches nothing (seen on a local Prometheus).
    expect(exprs.filter((e) => /oscar_host_load\{[^}]*\}\s*\//.test(e) && !e.includes('ignoring(period)'))).toEqual([]);
  });

  test('every host metric of the alert rules is one the server writes', () => {
    const rules = yaml.load(fs.readFileSync(path.join(DEPLOY, 'prometheus', 'alerts', 'oscar-alerts.yml'), 'utf8'));
    const host = rules.groups.find((g) => g.name === 'oscar.host').rules;
    expect(host.map((r) => r.alert)).toEqual(expect.arrayContaining(['OscarHostOverloaded', 'OscarHostMemoryLow', 'OscarHostSwapping', 'OscarContainerMemoryNearLimit']));
    expect(host.map((r) => r.expr).filter((e) => /oscar_host_load\{[^}]*\}\s*\//.test(e) && !e.includes('ignoring(period)'))).toEqual([]);
    const names = namesIn(host.map((r) => r.expr));
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.filter((n) => !written.has(n))).toEqual([]);
  });
});
