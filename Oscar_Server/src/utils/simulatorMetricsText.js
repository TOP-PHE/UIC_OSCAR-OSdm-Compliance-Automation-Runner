// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulatorMetricsText.js — the simulator's metrics snapshot (#1005, the JSON
 * of its `GET /admin/api/metrics`) in Prometheus's text format, for
 * `GET /metrics?source=simulator`. Pure.
 *
 * Everything the snapshot holds is read as data from another host: a value
 * that is not a finite number is left out, a label is kept only when it is a
 * plain word (a provider key, a method, a CPU mode), else written `other`.
 * So nothing the simulator answers can add a line or a label of its own.
 */

const WORD = /^[A-Za-z0-9_.+-]{1,40}$/;
const PREFIX = 'osdm_sim_';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : 'other');

function labelsOf(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${word(String(v))}"`).join(',')}}`;
}

/** A writer that gives each family one HELP and TYPE, then its samples. */
function writer() {
  const families = new Map();
  // `sample` is the series' own name when it is not the family's (a
  // histogram's _bucket, _sum and _count are one family).
  function add(name, type, help, labels, value, sample = name) {
    const v = num(value);
    if (v === null) return;
    let f = families.get(name);
    if (!f) {
      f = { type, help, lines: [] };
      families.set(name, f);
    }
    f.lines.push(`${sample}${labelsOf(labels)} ${v}`);
  }
  function text() {
    const out = [];
    for (const [name, f] of families) {
      out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`, ...f.lines);
    }
    return `${out.join('\n')}\n`;
  }
  return { add, text };
}

function addProcess(w, p) {
  if (!p || typeof p !== 'object') return;
  w.add(`${PREFIX}process_resident_memory_bytes`, 'gauge', 'Resident memory of the simulator process.', {}, p.residentBytes);
  w.add(`${PREFIX}process_heap_used_bytes`, 'gauge', 'V8 heap in use.', {}, p.heapUsedBytes);
  w.add(`${PREFIX}process_heap_total_bytes`, 'gauge', 'V8 heap reserved.', {}, p.heapTotalBytes);
  w.add(`${PREFIX}process_cpu_seconds_total`, 'counter', 'CPU time of the simulator process.', { mode: 'user' }, p.cpuUserSeconds);
  w.add(`${PREFIX}process_cpu_seconds_total`, 'counter', 'CPU time of the simulator process.', { mode: 'system' }, p.cpuSystemSeconds);
  const loop = p.eventLoop || {};
  w.add(`${PREFIX}event_loop_delay_p99_seconds`, 'gauge', 'Event-loop delay, 99th percentile since the last scrape.', {}, loop.p99Seconds);
  w.add(`${PREFIX}event_loop_delay_max_seconds`, 'gauge', 'Event-loop delay, maximum since the last scrape.', {}, loop.maxSeconds);
}

function addHost(w, h) {
  if (!h || typeof h !== 'object') return;
  w.add(`${PREFIX}host_memory_total_bytes`, 'gauge', 'Memory of the simulator host.', {}, h.memoryTotal);
  w.add(`${PREFIX}host_memory_available_bytes`, 'gauge', 'Memory available on the simulator host.', {}, h.memoryAvailable);
  w.add(`${PREFIX}host_swap_total_bytes`, 'gauge', 'Swap of the simulator host.', {}, h.swapTotal);
  w.add(`${PREFIX}host_swap_free_bytes`, 'gauge', 'Swap free on the simulator host.', {}, h.swapFree);
  w.add(`${PREFIX}host_cpus`, 'gauge', 'CPUs of the simulator host.', {}, h.cpus);
  if (Array.isArray(h.load)) {
    ['1m', '5m', '15m'].forEach((period, i) => w.add(`${PREFIX}host_load`, 'gauge', 'Load average of the simulator host.', { period }, h.load[i]));
  }
  if (h.cpuSeconds && typeof h.cpuSeconds === 'object') {
    for (const [mode, seconds] of Object.entries(h.cpuSeconds)) {
      w.add(`${PREFIX}host_cpu_seconds_total`, 'counter', 'CPU time of the simulator host, all CPUs, by mode.', { mode }, seconds);
    }
  }
  if (h.disk && typeof h.disk === 'object') {
    w.add(`${PREFIX}host_disk_total_bytes`, 'gauge', 'Size of the file system holding the data folder.', {}, h.disk.total);
    w.add(`${PREFIX}host_disk_free_bytes`, 'gauge', 'Free space on the file system holding the data folder.', {}, h.disk.free);
  }
}

function addRequests(w, snapshot) {
  for (const r of Array.isArray(snapshot.requests) ? snapshot.requests : []) {
    if (!r || typeof r !== 'object') continue;
    const status = Number.isInteger(r.status) && r.status >= 0 && r.status < 1000 ? String(r.status) : 'other';
    w.add(`${PREFIX}requests_total`, 'counter', 'Requests answered, by provider, method and status.', { provider: r.provider, method: r.method, status }, r.count);
  }
  const d = snapshot.durations || {};
  const buckets = Array.isArray(d.buckets) ? d.buckets.map(num) : [];
  if (buckets.some((b) => b === null)) return;
  for (const [provider, h] of Object.entries(d.byProvider || {})) {
    if (!h || !Array.isArray(h.counts) || h.counts.length !== buckets.length) continue;
    const name = `${PREFIX}request_duration_seconds`;
    const help = 'Time to answer a request, by provider.';
    buckets.forEach((le, i) => w.add(name, 'histogram', help, { provider, le: String(le) }, h.counts[i], `${name}_bucket`));
    w.add(name, 'histogram', help, { provider, le: '+Inf' }, h.count, `${name}_bucket`);
    w.add(name, 'histogram', help, { provider }, h.sum, `${name}_sum`);
    w.add(name, 'histogram', help, { provider }, h.count, `${name}_count`);
  }
}

/**
 * The text Prometheus reads. `up` says whether the simulator answered;
 * `configured` whether OSCAR has a simulator address and key at all.
 */
function renderSimulatorMetrics(snapshot, { up, configured }) {
  const w = writer();
  w.add('oscar_simulator_configured', 'gauge', 'Whether OSCAR has a simulator address and key (Admin, OSDM Simulator).', {}, configured ? 1 : 0);
  if (configured) w.add('oscar_simulator_up', 'gauge', 'Whether the simulator answered OSCAR\'s last read of its metrics.', {}, up ? 1 : 0);
  if (up && snapshot && typeof snapshot === 'object') {
    if (typeof snapshot.version === 'string') {
      w.add(`${PREFIX}info`, 'gauge', 'The simulator\'s version.', { version: snapshot.version }, 1);
    }
    w.add(`${PREFIX}uptime_seconds`, 'gauge', 'Seconds since the simulator started.', {}, snapshot.uptimeSeconds);
    addProcess(w, snapshot.process);
    addHost(w, snapshot.host);
    addRequests(w, snapshot);
    const refused = snapshot.rateLimited || {};
    w.add(`${PREFIX}rate_limited_total`, 'counter', 'Requests the rate limiter refused (429), by trusted address or not.', { trusted: 'true' }, refused.trusted);
    w.add(`${PREFIX}rate_limited_total`, 'counter', 'Requests the rate limiter refused (429), by trusted address or not.', { trusted: 'false' }, refused.others);
    for (const [kind, n] of Object.entries(snapshot.store || {})) {
      w.add(`${PREFIX}store_entries`, 'gauge', 'Offers, bookings and the like the simulator keeps, by kind.', { kind }, n);
    }
  }
  return w.text();
}

module.exports = { renderSimulatorMetrics };
