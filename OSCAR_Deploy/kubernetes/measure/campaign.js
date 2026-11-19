// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// Read only. A campaign's runs, by window of queue time: one line per window
// with the runs by status, the time until the last run ended and until 95 % of
// them had, the runs a minute for each, the mean run and the three longest.
// One long run pulls "all" down; "95 %" does not depend on it.
//
// From the checkout, in OSCAR's pod (guide: "OSCAR - Kubernetes run campaigns"):
//   sudo kubectl -n oscar exec -i deploy/oscar -c oscar -- node --no-warnings - \
//     NAME FROM TO [NAME FROM TO …] < OSCAR_Deploy/kubernetes/measure/campaign.js
// FROM and TO in UTC, e.g. 2026-11-19T12:29:00Z. A run belongs to the window
// its queue time falls in.
'use strict';

const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.OSCAR_DB || '/app/data/oscar.db', { readOnly: true });
const runsIn = db.prepare(`SELECT status, scenario_code AS code, started_at AS st, completed_at AS ct,
  (julianday(completed_at) - julianday(started_at)) * 86400 AS d
  FROM runs WHERE julianday(queued_at) >= julianday(?) AND julianday(queued_at) < julianday(?)`);
const ms = (t) => Date.parse(`${t.replace(' ', 'T')}Z`);

const args = process.argv.slice(2);
for (let i = 0; i + 2 < args.length; i += 3) {
  const [name, from, to] = args.slice(i, i + 3);
  const rows = runsIn.all(from, to);
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const done = rows.filter((r) => r.st && r.ct);
  if (done.length === 0) {
    console.log(`${name}: no run`);
    continue;
  }
  const t0 = Math.min(...done.map((r) => ms(r.st)));
  const ends = done.map((r) => (ms(r.ct) - t0) / 60000).sort((x, y) => x - y);
  const at = (p) => ends[Math.ceil(p * ends.length) - 1];
  const mean = done.reduce((x, r) => x + r.d, 0) / done.length;
  const longest = [...done].sort((x, y) => y.d - x.d).slice(0, 3)
    .map((r) => `${r.code} ${(r.d / 60).toFixed(1)} min`).join(', ');
  console.log(`${name}: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`
    + ` | all ${at(1).toFixed(1)} min, ${(done.length / at(1)).toFixed(1)} runs/min`
    + ` | 95 % ${at(0.95).toFixed(1)} min, ${(0.95 * done.length / at(0.95)).toFixed(1)} runs/min`
    + ` | mean run ${mean.toFixed(1)} s | longest ${longest}`);
}
