// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// Read only. The runs not COMPLETED since the given time, by exit code and
// message, then the longest run's steps and log lines. Log lines are stored
// encrypted; ENCRYPTION_KEY is the server's own. What it prints holds test
// data and the person who ran: for the operator only.
//
//   sudo kubectl -n oscar exec -i deploy/oscar -c oscar -- node --no-warnings - \
//     SINCE < OSCAR_Deploy/kubernetes/measure/failures.js
// SINCE in UTC, e.g. 2026-11-19T12:29:00Z.
'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.OSCAR_DB || '/app/data/oscar.db', { readOnly: true });
const since = process.argv.at(-1);
const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
const plain = (s) => {
  if (typeof s !== 'string' || !s.startsWith('enc:v1:')) return String(s ?? '');
  try {
    const b = Buffer.from(s.slice(7), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return '(not readable)'; }
};
const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const runs = db.prepare(`SELECT r.id, c.name AS company, r.scenario_code AS code, r.exit_code AS exit,
  r.started_at AS started, ROUND((julianday(r.completed_at) - julianday(r.started_at)) * 86400) AS secs,
  coalesce(r.error_message, '') AS why FROM runs r JOIN companies c ON c.id = r.company_id
  WHERE r.queued_at >= datetime(?) AND r.status <> 'COMPLETED' ORDER BY r.started_at`).all(since);
const checks = db.prepare(`SELECT assertion_name AS name, coalesce(error_msg, '') AS msg FROM run_assertions
  WHERE run_id = ? AND passed = 0 ORDER BY id LIMIT 2`);
const groups = new Map();
for (const r of runs) {
  const k = `exit ${r.exit} | ${one(r.why, 70) || '(no message)'}`;
  groups.set(k, (groups.get(k) || 0) + 1);
}
console.log(`${runs.length} runs not COMPLETED since ${since}, by exit code and message:`);
for (const [k, n] of groups) console.log(`  ${String(n).padStart(3)}  ${k}`);
for (const r of runs) {
  console.log(`\n${r.started} | ${r.company} | ${r.code} | exit ${r.exit} | ${r.secs} s | ${one(r.why, 160)}`);
  for (const k of checks.all(r.id)) console.log(`    failed: ${one(k.name, 110)}\n            ${one(k.msg, 160)}`);
}

const long = db.prepare(`SELECT r.id, c.name AS company, r.scenario_code AS code, r.status, r.exit_code AS exit,
  r.started_at AS started, r.completed_at AS ended, coalesce(r.error_message, '') AS why
  FROM runs r JOIN companies c ON c.id = r.company_id
  WHERE r.queued_at >= datetime(?) AND r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
  ORDER BY julianday(r.completed_at) - julianday(r.started_at) DESC LIMIT 1`).get(since);
if (long) {
  console.log(`\n=== Longest run: ${long.company} | ${long.code} | ${long.status} exit ${long.exit} | ${long.started} to ${long.ended} UTC | ${one(long.why, 160)}`);
  const steps = db.prepare(`SELECT coalesce(request_name, '(none)') AS step, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n
    FROM run_events WHERE run_id = ? GROUP BY coalesce(request_name, '(none)') ORDER BY MIN(id)`).all(long.id);
  for (const s of steps) console.log(`  ${s.first.slice(11)} to ${s.last.slice(11)}  ${String(s.n).padStart(4)} lines  ${s.step}`);
  const lines = db.prepare('SELECT ts, level, message FROM run_events WHERE run_id = ? ORDER BY id').all(long.id)
    .flatMap((l) => plain(l.message).split('\n').filter((t) => t.trim()).map((t) => `  ${l.ts.slice(11)} ${l.level} ${one(t, 200)}`));
  const own = lines.filter((t) => /\[(runner|kept-pods|run-pod|dispatcher)\]/.test(t));
  console.log(`\n  ${lines.length} log lines. The runner's and the pod's (first 25):`);
  for (const t of own.slice(0, 25)) console.log(t);
  console.log('\n  The last 25:');
  for (const t of lines.slice(-25)) console.log(t);
}
