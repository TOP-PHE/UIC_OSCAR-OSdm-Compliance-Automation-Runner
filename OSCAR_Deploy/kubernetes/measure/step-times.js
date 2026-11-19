// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// Read only. For each window (name, from, to, in UTC): the runs' mean and 95th
// percentile time per step, read from the line "[runner] Where this run's time
// went (...)" each run logs at its end (#1312). Log lines are stored
// encrypted; ENCRYPTION_KEY is the server's own; only that line is printed.
//
//   sudo kubectl -n oscar exec -i deploy/oscar -c oscar -- node --no-warnings - \
//     NAME FROM TO [NAME FROM TO …] < OSCAR_Deploy/kubernetes/measure/step-times.js
'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.OSCAR_DB || '/app/data/oscar.db', { readOnly: true });
const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
const plain = (s) => {
  if (typeof s !== 'string' || !s.startsWith('enc:v1:')) return String(s ?? '');
  try {
    const b = Buffer.from(s.slice(7), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
};
const MARK = "Where this run's time went (";
const runsOf = db.prepare('SELECT id FROM runs WHERE julianday(queued_at) >= julianday(?) AND julianday(queued_at) < julianday(?)');
const lastLines = db.prepare('SELECT message FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 8');

function stepsOf(line) {
  const i = line.indexOf(MARK);
  if (i < 0) return null;
  const rest = line.slice(i + MARK.length);
  const total = Number.parseFloat(rest);
  const out = { 'slot to final status': total };
  const body = rest.slice(rest.indexOf('): ') + 3);
  for (const part of body.split(', ')) {
    const m = /^(.+) (\d+(?:\.\d+)?) s\.?$/.exec(part.trim());
    if (m) out[m[1]] = Number.parseFloat(m[2]);
  }
  return out;
}

const args = process.argv.slice(2);
const windows = [];
for (let i = 0; i + 2 < args.length; i += 3) {
  const [name, from, to] = args.slice(i, i + 3);
  const byStep = new Map();
  let runs = 0;
  let found = 0;
  for (const { id } of runsOf.all(from, to)) {
    runs += 1;
    for (const row of lastLines.all(id)) {
      const steps = stepsOf(plain(row.message));
      if (!steps) continue;
      found += 1;
      for (const [step, s] of Object.entries(steps)) {
        if (!byStep.has(step)) byStep.set(step, []);
        byStep.get(step).push(s);
      }
      break;
    }
  }
  windows.push({ name, runs, found, byStep });
}

const steps = [...new Set(windows.flatMap((w) => [...w.byStep.keys()]))];
const fmt = (xs) => {
  if (!xs || !xs.length) return '-';
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  return `${mean.toFixed(1)} / ${p95.toFixed(1)}`;
};
console.log(`seconds, mean / 95th percentile`);
console.log(['step'.padEnd(34), ...windows.map((w) => `${w.name} (${w.found} of ${w.runs} runs)`.padEnd(30))].join(' '));
for (const step of steps) {
  console.log([step.padEnd(34), ...windows.map((w) => fmt(w.byStep.get(step)).padEnd(30))].join(' '));
}
