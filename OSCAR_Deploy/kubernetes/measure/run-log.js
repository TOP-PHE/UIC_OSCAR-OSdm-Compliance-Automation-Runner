// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// Read only. One run, found by its scenario code among the runs queued since
// a time (UTC): its result, its failed checks, its steps, the log lines that
// speak of a failure, and its last lines. Log lines are stored encrypted;
// ENCRYPTION_KEY is the server's own. What it prints holds test data and the
// person who ran: for the operator only.
//
//   sudo kubectl -n oscar exec -i deploy/oscar -c oscar -- node --no-warnings - \
//     SINCE SCENARIO_CODE < OSCAR_Deploy/kubernetes/measure/run-log.js
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
  } catch { return '(not readable)'; }
};
const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const [since, code] = process.argv.slice(2);

const run = db.prepare(`SELECT id, status, exit_code AS exit, started_at AS started, completed_at AS ended,
  coalesce(error_message, '') AS why FROM runs WHERE scenario_code = ? AND queued_at >= datetime(?)
  ORDER BY queued_at LIMIT 1`).get(code, since);
if (!run) {
  console.log(`no run of ${code} since ${since}`);
} else {
  console.log(`${code} | ${run.status} exit ${run.exit} | ${run.started} to ${run.ended} UTC | ${one(run.why, 200)}`);
  const failed = db.prepare(`SELECT assertion_name AS name, coalesce(error_msg, '') AS msg FROM run_assertions
    WHERE run_id = ? AND passed = 0 ORDER BY id LIMIT 10`).all(run.id);
  console.log(`\n${failed.length} failed check(s) stored:`);
  for (const f of failed) console.log(`  ${one(f.name, 140)}\n      ${one(f.msg, 200)}`);
  console.log('\nSteps (first and last line):');
  for (const s of db.prepare(`SELECT coalesce(request_name, '(none)') AS step, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n
    FROM run_events WHERE run_id = ? GROUP BY coalesce(request_name, '(none)') ORDER BY MIN(id)`).all(run.id)) {
    console.log(`  ${s.first.slice(11)} to ${s.last.slice(11)}  ${String(s.n).padStart(4)} lines  ${s.step}`);
  }
  const lines = db.prepare('SELECT ts, level, request_name AS step, message FROM run_events WHERE run_id = ? ORDER BY id').all(run.id)
    .flatMap((l) => plain(l.message).split('\n').filter((t) => t.trim())
      .map((t) => `  ${l.ts.slice(11)} ${l.level} [${l.step || '-'}] ${one(t, 220)}`));
  const BAD = /✗|✕|\[ERROR\]|\bFAIL|error|timed out|ECONN|socket|refused|not finished|stopped/i;
  console.log('\nLines speaking of a failure (first 30):');
  for (const t of lines.filter((t) => BAD.test(t)).slice(0, 30)) console.log(t);
  console.log('\nThe last 15 lines:');
  for (const t of lines.slice(-15)) console.log(t);
}
