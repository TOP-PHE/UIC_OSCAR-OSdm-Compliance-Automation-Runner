// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * metrics.js — what the simulator and its host are doing, for OSCAR's
 * Prometheus (#1005). The simulator has no dependency, so nothing here speaks
 * Prometheus: `snapshot()` is JSON, read by the OSCAR server through the
 * administration API (`GET /admin/api/metrics`) and written out by OSCAR in
 * Prometheus's text format.
 *
 * Counted since the process started: requests by provider, method and status,
 * their duration by provider, the refusals of the rate limiter. Read at each
 * snapshot: the process (memory, CPU, event-loop delay), the host (memory,
 * swap, load, CPU time, the data folder's disk), the store. The host is read
 * in /proc, which a container shares with its host for these files; on a
 * system without them the host part is null.
 *
 * Nothing names an account, a token or a body: a provider key, a method and a
 * status only.
 */

const fs = require('node:fs');
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']);
const STORE_KINDS = Object.freeze(['offer', 'trip', 'booking', 'fulfillment', 'idempotency']);
// Linux counts /proc/stat in clock ticks of 1/100 s on every platform it runs on.
const TICKS_PER_SECOND = 100;
const CPU_MODES = Object.freeze(['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal']);

/** /proc/meminfo → bytes; null when a line is missing. */
function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  const need = ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'];
  if (need.some((key) => kb[key] === undefined)) return null;
  return { memoryTotal: kb.MemTotal, memoryAvailable: kb.MemAvailable, swapTotal: kb.SwapTotal, swapFree: kb.SwapFree };
}

/** /proc/loadavg → [1, 5, 15] minutes; null when unreadable. */
function parseLoadavg(text) {
  const parts = String(text).trim().split(/\s+/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

/** The "cpu" line of /proc/stat → seconds per mode, all CPUs together. */
function parseCpuSeconds(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || !values.every(Number.isFinite)) return null;
  const seconds = {};
  CPU_MODES.forEach((mode, i) => { if (i < values.length) seconds[mode] = values[i] / TICKS_PER_SECOND; });
  return seconds;
}

function readText(readFile, file) {
  try { return readFile(file, 'utf8'); } catch { return null; }
}

/** The host as /proc shows it, or null where it says nothing. */
function hostOf({ readFile, statfs, dataDir }) {
  const meminfo = readText(readFile, '/proc/meminfo');
  const memory = meminfo === null ? null : parseMeminfo(meminfo);
  const loadavgText = readText(readFile, '/proc/loadavg');
  const statText = readText(readFile, '/proc/stat');
  let disk = null;
  try {
    const s = statfs(dataDir || '/');
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { disk = null; }
  if (!memory && loadavgText === null && statText === null && !disk) return null;
  return {
    ...memory,
    load: loadavgText === null ? null : parseLoadavg(loadavgText),
    cpuSeconds: statText === null ? null : parseCpuSeconds(statText),
    cpus: os.cpus().length,
    disk,
  };
}

function createMetrics({
  version,
  store = null,
  dataDir = null,
  now = Date.now,
  readFile = fs.readFileSync,
  statfs = fs.statfsSync,
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  eventLoop = monitorEventLoopDelay({ resolution: 20 }),
} = {}) {
  const startedAt = now();
  const requests = new Map(); // "provider|method|status" → count
  const durations = new Map(); // provider → { buckets: [], sum, count }
  const refused = { trusted: 0, others: 0 };
  eventLoop.enable?.();

  /** One answered request. `ms` is its duration; provider may be absent. */
  function record({ provider, method, status, ms }) {
    const p = typeof provider === 'string' && provider ? provider : 'none';
    const m = METHODS.has(method) ? method : 'OTHER';
    const s = Number.isInteger(status) ? status : 0;
    const key = `${p}|${m}|${s}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    let d = durations.get(p);
    if (!d) {
      d = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      durations.set(p, d);
    }
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    BUCKETS.forEach((limit, i) => { if (seconds <= limit) d.buckets[i] += 1; });
    d.sum += seconds;
    d.count += 1;
  }

  /** A request the rate limiter refused (#1004: trusted or not). */
  function rateLimited(trusted) {
    refused[trusted ? 'trusted' : 'others'] += 1;
  }

  function eventLoopOf() {
    const p99 = eventLoop.percentile?.(99);
    const max = eventLoop.max;
    eventLoop.reset?.();
    const seconds = (ns) => (Number.isFinite(ns) && ns > 0 ? ns / 1e9 : 0);
    return { p99Seconds: seconds(p99), maxSeconds: seconds(max) };
  }

  function snapshot() {
    const memory = memoryUsage();
    const cpu = cpuUsage();
    const storeEntries = {};
    if (store?.count) for (const kind of STORE_KINDS) {
      try { storeEntries[kind] = store.count(kind); } catch { /* a kind this store does not keep */ }
    }
    return {
      version,
      uptimeSeconds: Math.max(0, (now() - startedAt) / 1000),
      process: {
        residentBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        cpuUserSeconds: cpu.user / 1e6,
        cpuSystemSeconds: cpu.system / 1e6,
        eventLoop: eventLoopOf(),
      },
      host: hostOf({ readFile, statfs, dataDir }),
      requests: [...requests].map(([key, count]) => {
        const [provider, method, status] = key.split('|');
        return { provider, method, status: Number(status), count };
      }),
      durations: {
        buckets: BUCKETS,
        byProvider: Object.fromEntries([...durations].map(([p, d]) => [p, { counts: [...d.buckets], sum: d.sum, count: d.count }])),
      },
      rateLimited: { ...refused },
      store: storeEntries,
    };
  }

  return { record, rateLimited, snapshot };
}

module.exports = { createMetrics, parseMeminfo, parseLoadavg, parseCpuSeconds, BUCKETS };
