// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1005: the simulator's metrics snapshot written for Prometheus. What the
// simulator answers is data from another host: it can never add a line or a
// label of its own.

const { renderSimulatorMetrics } = require('../../src/utils/simulatorMetricsText');

const SNAPSHOT = {
  version: '0.57.0',
  uptimeSeconds: 90,
  process: { residentBytes: 1000, heapUsedBytes: 200, heapTotalBytes: 300, cpuUserSeconds: 2.5, cpuSystemSeconds: 0.5, eventLoop: { p99Seconds: 0.012, maxSeconds: 0.04 } },
  host: {
    memoryTotal: 8000, memoryAvailable: 2000, swapTotal: 1000, swapFree: 750, cpus: 2,
    load: [0.5, 0.75, 1], cpuSeconds: { user: 10, idle: 90 }, disk: { total: 4096000, free: 1024000 },
  },
  requests: [{ provider: 'gamma', method: 'POST', status: 200, count: 2 }],
  durations: { buckets: [0.05, 1], byProvider: { gamma: { counts: [1, 2], sum: 0.73, count: 2 } } },
  rateLimited: { trusted: 1, others: 2 },
  store: { offer: 3 },
};

// Every sample line: name{labels} value, nothing else.
function isSample(line) {
  const [series, value, ...rest] = line.split(' ');
  if (rest.length > 0 || !Number.isFinite(Number(value))) return false;
  const open = series.indexOf('{');
  const name = open < 0 ? series : series.slice(0, open);
  if (!/^[a-z0-9_]+$/.test(name)) return false;
  if (open < 0) return true;
  if (!series.endsWith('}')) return false;
  return series.slice(open + 1, -1).split(',').every((pair) => /^[a-z]+="[A-Za-z0-9_.+-]*"$/.test(pair));
}
const expectSamples = (text) => {
  for (const line of text.trimEnd().split('\n').filter((l) => !l.startsWith('#'))) expect([line, isSample(line)]).toEqual([line, true]);
};

test('a snapshot becomes one family per metric, with HELP and TYPE once', () => {
  const text = renderSimulatorMetrics(SNAPSHOT, { up: true, configured: true });
  const lines = text.trimEnd().split('\n');
  expectSamples(text);
  expect(text).toContain('osdm_sim_info{version="0.57.0"} 1');
  expect(text).toContain('osdm_sim_requests_total{provider="gamma",method="POST",status="200"} 2');
  expect(text).toContain('osdm_sim_host_load{period="5m"} 0.75');
  expect(text).toContain('osdm_sim_host_cpu_seconds_total{mode="idle"} 90');
  expect(text).toContain('osdm_sim_rate_limited_total{trusted="false"} 2');
  expect(text).toContain('osdm_sim_store_entries{kind="offer"} 3');
  // The histogram: one family, buckets then +Inf, sum and count.
  const histogram = lines.filter((l) => l.includes('request_duration_seconds'));
  expect(histogram).toEqual([
    '# HELP osdm_sim_request_duration_seconds Time to answer a request, by provider.',
    '# TYPE osdm_sim_request_duration_seconds histogram',
    'osdm_sim_request_duration_seconds_bucket{provider="gamma",le="0.05"} 1',
    'osdm_sim_request_duration_seconds_bucket{provider="gamma",le="1"} 2',
    'osdm_sim_request_duration_seconds_bucket{provider="gamma",le="+Inf"} 2',
    'osdm_sim_request_duration_seconds_sum{provider="gamma"} 0.73',
    'osdm_sim_request_duration_seconds_count{provider="gamma"} 2',
  ]);
  const types = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
  expect(new Set(types).size).toBe(types.length);
});

test('labels and values the simulator could make up are left out or written "other"', () => {
  const hostile = {
    ...SNAPSHOT,
    version: 'x"}\nfake_metric 1\n#',
    requests: [
      { provider: 'gamma"} 1\nevil{a="', method: 'POST', status: 200, count: 1 },
      { provider: 'beta', method: 'GET', status: 'abc', count: 'NaN' },
      { provider: 'beta', method: 'GET', status: 99999, count: 4 },
      null,
    ],
    host: { ...SNAPSHOT.host, memoryTotal: 'lots', cpuSeconds: { 'a b': 1 } },
    store: { offer: Infinity },
  };
  const text = renderSimulatorMetrics(hostile, { up: true, configured: true });
  expectSamples(text);
  expect(text).not.toContain('fake_metric');
  expect(text).not.toContain('evil');
  expect(text).toContain('osdm_sim_info{version="other"} 1');
  expect(text).toContain('osdm_sim_requests_total{provider="other",method="POST",status="200"} 1');
  expect(text).toContain('osdm_sim_requests_total{provider="beta",method="GET",status="other"} 4');
  expect(text).not.toContain('host_memory_total_bytes');
  expect(text).toContain('osdm_sim_host_cpu_seconds_total{mode="other"} 1');
  expect(text).not.toContain('store_entries');
});

test('unreachable or not set up: the two OSCAR gauges only', () => {
  expect(renderSimulatorMetrics(SNAPSHOT, { up: false, configured: true })).toBe(
    '# HELP oscar_simulator_configured Whether OSCAR has a simulator address and key (Admin, OSDM Simulator).\n'
    + '# TYPE oscar_simulator_configured gauge\noscar_simulator_configured 1\n'
    + "# HELP oscar_simulator_up Whether the simulator answered OSCAR's last read of its metrics.\n"
    + '# TYPE oscar_simulator_up gauge\noscar_simulator_up 0\n');
  expect(renderSimulatorMetrics(null, { up: false, configured: false })).not.toContain('oscar_simulator_up');
  // A broken snapshot (no buckets) still gives what it can.
  const text = renderSimulatorMetrics({ requests: 'x', durations: { buckets: ['a'] } }, { up: true, configured: true });
  expect(text).toContain('oscar_simulator_up 1');
  expect(text).not.toContain('request_duration');
});
