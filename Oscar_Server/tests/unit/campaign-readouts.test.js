// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * campaign-readouts.test.js — #1340: the four read-only scripts of
 * OSCAR_Deploy/kubernetes/measure/, run as the guide runs them (the script on
 * stdin, its arguments after "-"), on a small database whose log lines are
 * encrypted by the server's own colEncrypt().
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { colEncrypt } = require('../../src/db/db');

const MEASURE = path.resolve(__dirname, '../../../OSCAR_Deploy/kubernetes/measure');
let dir;
let dbPath;

const timeLine = (folder, requests) => `[runner] Where this run's time went (${(folder + requests + 2).toFixed(1)} s from its slot to its final status): `
  + `preparing the run 0.1 s, asking for its pod 0.7 s, waiting for its pod 0.0 s, its pod preparing the work folder ${folder.toFixed(1)} s, `
  + `Bruno starting 0.1 s, the requests ${requests.toFixed(1)} s, the reports 0.3 s, sending the results 0.3 s, its pod ending 0.1 s, `
  + 'linking the reports 0.2 s, storing the checks 0.2 s.';
const at = (minutes) => new Date(Date.UTC(2026, 10, 19, 12, 30) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-campaign-readouts-'));
  dbPath = path.join(dir, 'oscar.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE companies (id TEXT, name TEXT);
    CREATE TABLE runs (id TEXT, company_id TEXT, scenario_code TEXT, status TEXT, exit_code INTEGER,
      queued_at TEXT, started_at TEXT, completed_at TEXT, error_message TEXT);
    CREATE TABLE run_assertions (id INTEGER PRIMARY KEY, run_id TEXT, assertion_name TEXT, passed INTEGER, error_msg TEXT);
    CREATE TABLE run_events (id INTEGER PRIMARY KEY, run_id TEXT, ts TEXT, level TEXT, request_name TEXT, message TEXT);`);
  db.prepare('INSERT INTO companies VALUES (?, ?)').run('c1', 'GAMMA');
  const run = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const event = db.prepare('INSERT INTO run_events (run_id, ts, level, request_name, message) VALUES (?, ?, ?, ?, ?)');
  // A first campaign of 20 runs, one a minute, each 40 s; one more long run.
  for (let i = 0; i < 20; i += 1) {
    run.run(`a${i}`, 'c1', `SIM_A_${i}`, 'COMPLETED', 0, at(0), at(i), at(i + 40 / 60), null);
    event.run(`a${i}`, `${at(i).replace(' ', 'T')}.000Z`, 'info', null, colEncrypt('[runner] Run started'));
    event.run(`a${i}`, `${at(i + 1).replace(' ', 'T')}.000Z`, 'info', null, colEncrypt(timeLine(10, 20 + i)));
  }
  run.run('long', 'c1', 'SIM_LONG', 'COMPLETED', 0, at(0), at(0), at(60), null);
  // A second campaign, two hours later: one failed run whose provider was not reached.
  run.run('f1', 'c1', 'SIM_SALE_FAILS', 'FAILED', 1, at(120), at(121), at(123), null);
  event.run('f1', '2026-11-19T14:31:00.000Z', 'info', '07. GET Zones', colEncrypt('07. GET Zones (200 OK) - 355 ms'));
  event.run('f1', '2026-11-19T14:33:00.000Z', 'info', '08. GET Products', colEncrypt('08. GET Products (connect ETIMEDOUT 192.0.2.1:443)'));
  event.run('f1', '2026-11-19T14:33:01.000Z', 'info', null, colEncrypt('[runner] Run finished — status=FAILED exit=1'));
  db.close();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readout(script, args) {
  return execFileSync(process.execPath, ['--no-warnings', '-', ...args], {
    input: fs.readFileSync(path.join(MEASURE, script), 'utf8'),
    env: { ...process.env, OSCAR_DB: dbPath },
    encoding: 'utf8',
  });
}

describe('the campaign readouts (#1340)', () => {
  test('campaign.js: a line per window; one long run pulls "all" down, not "95 %"', () => {
    const out = readout('campaign.js', ['first', '2026-11-19T12:29:00Z', '2026-11-19T14:00:00Z', 'second', '2026-11-19T14:00:00Z', '2026-11-20T00:00:00Z', 'none', '2026-11-18T00:00:00Z', '2026-11-18T01:00:00Z']).trim().split('\n');
    expect(out[0]).toMatch(/^first: COMPLETED 21 \| all 60\.0 min, 0\.3 runs\/min \| 95 % 19\.7 min, 1\.0 runs\/min \| mean run 209\.5 s \| longest SIM_LONG 60\.0 min, /);
    expect(out[1]).toMatch(/^second: FAILED 1 \| all 2\.0 min/);
    expect(out[2]).toBe('none: no run');
  });

  test('step-times.js: mean and 95th percentile of each step, from the encrypted time line', () => {
    const out = readout('step-times.js', ['first', '2026-11-19T12:29:00Z', '2026-11-19T14:00:00Z']);
    expect(out).toContain('first (20 of 21 runs)');
    expect(out).toMatch(/its pod preparing the work folder\s+10\.0 \/ 10\.0/);
    expect(out).toMatch(/the requests\s+29\.5 \/ 38\.0/);
    expect(out).not.toContain('Run started');
  });

  test('failures.js: the runs not completed, and the longest run with its lines', () => {
    const out = readout('failures.js', ['2026-11-19T14:00:00Z']);
    expect(out).toContain('1 runs not COMPLETED since 2026-11-19T14:00:00Z');
    expect(out).toContain('GAMMA | SIM_SALE_FAILS | exit 1');
    expect(out).toContain('08. GET Products (connect ETIMEDOUT 192.0.2.1:443)');
  });

  test('run-log.js: one run\'s steps, and the lines that speak of a failure, decrypted', () => {
    const out = readout('run-log.js', ['2026-11-19T14:00:00Z', 'SIM_SALE_FAILS']);
    expect(out).toContain('SIM_SALE_FAILS | FAILED exit 1');
    expect(out).toContain('0 failed check(s) stored');
    expect(out).toMatch(/\[08\. GET Products\] 08\. GET Products \(connect ETIMEDOUT 192\.0\.2\.1:443\)/);
    expect(readout('run-log.js', ['2026-11-19T14:00:00Z', 'NOT_RUN'])).toContain('no run of NOT_RUN since');
  });

  test('every readout opens the database read only', () => {
    for (const file of fs.readdirSync(MEASURE).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(MEASURE, file), 'utf8');
      expect([file, /new DatabaseSync\([^)]*\{ readOnly: true \}\)/.test(text)]).toEqual([file, true]);
      expect([file, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(text)]).toEqual([file, false]);
    }
  });
});
