// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * hostMetrics.js — the OSCAR server's machine and the processes it starts for
 * runs (#1013), read at each Prometheus scrape.
 *
 * A run is a Bruno process, a child of the server: its CPU and memory do not
 * show in the server process's own metrics. A load test of 36 parallel runs
 * saturated a 6-CPU machine (load 29.7, 2.6 GiB available, no swap) and the
 * dashboard showed none of it. This module reads:
 * - /proc/meminfo, /proc/loadavg, /proc/stat: the machine as the container
 *   sees it (a VM's own figures; a container without its own /proc view
 *   shares these files with the machine);
 * - cgroup v2, else v1: the container's memory and its limit;
 * - /proc/<pid>/stat and status: the server's child processes, counted, and
 *   their resident memory added up. Never a command line, a path or an
 *   argument.
 *
 * The parsers are pure; `snapshot()` takes the file reader, so a test feeds
 * it text. A file that cannot be read gives nothing, never an error.
 */

const fs = require('node:fs');
const os = require('node:os');

const CPU_MODES = Object.freeze(['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal']);
// Linux counts /proc/stat in clock ticks of 1/100 s.
const TICKS_PER_SECOND = 100;
// A cgroup v1 "no limit" is a number near 2^63.
const NO_LIMIT = 2 ** 60;

/** /proc/meminfo → bytes; null when a needed line is missing. */
function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  if (kb.MemTotal === undefined || kb.MemAvailable === undefined) return null;
  return {
    memoryTotal: kb.MemTotal,
    memoryAvailable: kb.MemAvailable,
    swapTotal: kb.SwapTotal ?? 0,
    swapFree: kb.SwapFree ?? 0,
  };
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
  CPU_MODES.forEach((mode, i) => {
    if (i < values.length) seconds[mode] = values[i] / TICKS_PER_SECOND;
  });
  return seconds;
}

/** /proc/<pid>/stat → its parent's pid; the name in brackets may hold anything. */
function parentOf(statText) {
  const text = String(statText);
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/** /proc/<pid>/status → resident memory in bytes, or 0. */
function residentOf(statusText) {
  const match = /^VmRSS:\s+(\d+)\s*kB/m.exec(String(statusText));
  return match ? Number(match[1]) * 1024 : 0;
}

/** A number read from a cgroup file, or null ("max", empty, not a number). */
function cgroupNumber(text) {
  const value = Number(String(text).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readText(readFile, file) {
  try { return readFile(file, 'utf8'); } catch { return null; }
}

function containerMemory(readFile) {
  const v2 = readText(readFile, '/sys/fs/cgroup/memory.current');
  if (v2 !== null) {
    const limit = cgroupNumber(readText(readFile, '/sys/fs/cgroup/memory.max') ?? '');
    return { used: cgroupNumber(v2), limit };
  }
  const v1 = readText(readFile, '/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1 === null) return null;
  const limit = cgroupNumber(readText(readFile, '/sys/fs/cgroup/memory/memory.limit_in_bytes') ?? '');
  return { used: cgroupNumber(v1), limit: limit !== null && limit < NO_LIMIT ? limit : null };
}

/** The server's direct children: how many, and their resident memory. */
function childrenOf({ readFile, readdir, ownPid }) {
  let entries;
  try { entries = readdir('/proc'); } catch { return null; }
  let count = 0;
  let resident = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readText(readFile, `/proc/${name}/stat`);
    if (stat === null || parentOf(stat) !== ownPid) continue;
    count += 1;
    resident += residentOf(readText(readFile, `/proc/${name}/status`) ?? '');
  }
  return { count, resident };
}

/** Everything this module reads, at one moment. Parts that cannot be read are null. */
function snapshot({
  readFile = fs.readFileSync,
  readdir = fs.readdirSync,
  ownPid = process.pid,
  cpus = () => os.cpus().length,
} = {}) {
  const meminfo = readText(readFile, '/proc/meminfo');
  const loadavg = readText(readFile, '/proc/loadavg');
  const stat = readText(readFile, '/proc/stat');
  return {
    memory: meminfo === null ? null : parseMeminfo(meminfo),
    load: loadavg === null ? null : parseLoadavg(loadavg),
    cpuSeconds: stat === null ? null : parseCpuSeconds(stat),
    cpus: cpus(),
    container: containerMemory(readFile),
    children: childrenOf({ readFile, readdir, ownPid }),
  };
}

// One family: its HELP and TYPE, then its samples. A value that is not a
// finite number is left out, so a file that could not be read gives no line
// rather than a 0 an alert would take for real.
function family(name, type, help, samples) {
  const lines = samples
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([labels, value]) => `${name}${labels} ${value}`);
  return lines.length === 0 ? [] : [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines];
}

/** The snapshot in Prometheus's text format, appended to OSCAR's /metrics. */
function hostMetricsText(snap) {
  const m = snap.memory || {};
  const load = snap.load || [];
  const cpu = snap.cpuSeconds || {};
  const container = snap.container || {};
  const children = snap.children || {};
  const lines = [
    ...family('oscar_host_memory_total_bytes', 'gauge', 'Memory of the OSCAR server\'s machine.', [['', m.memoryTotal]]),
    ...family('oscar_host_memory_available_bytes', 'gauge', 'Memory available on the OSCAR server\'s machine.', [['', m.memoryAvailable]]),
    ...family('oscar_host_swap_total_bytes', 'gauge', 'Swap of the OSCAR server\'s machine.', [['', m.swapTotal]]),
    ...family('oscar_host_swap_free_bytes', 'gauge', 'Swap free on the OSCAR server\'s machine.', [['', m.swapFree]]),
    ...family('oscar_host_cpus', 'gauge', 'CPUs of the OSCAR server\'s machine.', [['', snap.cpus]]),
    ...family('oscar_host_load', 'gauge', 'Load average of the OSCAR server\'s machine.',
      [['{period="1m"}', load[0]], ['{period="5m"}', load[1]], ['{period="15m"}', load[2]]]),
    ...family('oscar_host_cpu_seconds_total', 'counter', 'CPU time of the OSCAR server\'s machine, all CPUs, by mode.',
      CPU_MODES.map((mode) => [`{mode="${mode}"}`, cpu[mode]])),
    ...family('oscar_container_memory_bytes', 'gauge', 'Memory the OSCAR container uses (cgroup).', [['', container.used]]),
    ...family('oscar_container_memory_limit_bytes', 'gauge', 'Memory limit of the OSCAR container (cgroup), when it has one.', [['', container.limit]]),
    ...family('oscar_run_processes', 'gauge', 'Processes the server started for runs (Bruno, report merge).', [['', children.count]]),
    ...family('oscar_run_processes_resident_memory_bytes', 'gauge', 'Resident memory of the processes the server started for runs.', [['', children.resident]]),
  ];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

module.exports = {
  snapshot,
  hostMetricsText,
  parseMeminfo,
  parseLoadavg,
  parseCpuSeconds,
  parentOf,
  residentOf,
  cgroupNumber,
  CPU_MODES,
};
