// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1221: each COMMIT of transaction() is timed. On the k3s test machine, with
// a copy of production's 10 GB database, requests still waited 0.3 to 1 s for
// the thread at almost every reading. Every results slice and every batch of
// log lines ends with a COMMIT, which the slices' 20 ms do not count, and the
// server's connection reads synchronous = FULL: each COMMIT waits for the disk.

const fs = require('node:fs');
const path = require('node:path');
const dbModule = require('../../src/db/db');
const metrics = require('../../src/utils/metrics');

const { run, all, transaction } = dbModule;
const ROOT = path.join(__dirname, '..', '..', '..');

async function commits() {
  const json = await metrics.dbCommitSeconds.get();
  const count = json.values.find((v) => v.metricName === 'oscar_db_commit_seconds_count');
  return count ? count.value : 0;
}

beforeAll(() => {
  run('CREATE TEMP TABLE commit_probe (v TEXT)');
});

afterEach(() => {
  jest.restoreAllMocks();
  run('DELETE FROM commit_probe');
});

const probes = () => all('SELECT v FROM commit_probe ORDER BY rowid').map((r) => r.v);

describe('the commits of transaction() are timed (#1221)', () => {
  test('one observation a transaction committed, none for one rolled back', async () => {
    const before = await commits();
    transaction(() => run('INSERT INTO commit_probe (v) VALUES (?)', ['kept']));
    expect(await commits()).toBe(before + 1);
    expect(() => transaction(() => {
      run('INSERT INTO commit_probe (v) VALUES (?)', ['undone']);
      throw new Error('broken');
    })).toThrow('broken');
    expect(await commits()).toBe(before + 1);
    expect(probes()).toEqual(['kept']);
  });

  test('a COMMIT that fails is timed, rolled back, and its error reaches the caller', async () => {
    const realExec = dbModule.db.exec.bind(dbModule.db);
    jest.spyOn(dbModule.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') throw new Error('disk gone');
      return realExec(sql);
    });
    const before = await commits();
    expect(() => transaction(() => run('INSERT INTO commit_probe (v) VALUES (?)', ['lost']))).toThrow('disk gone');
    jest.restoreAllMocks();
    expect(await commits()).toBe(before + 1);
    expect(probes()).toEqual([]);
  });

  test('a metric that fails never stops a commit', () => {
    jest.spyOn(metrics.dbCommitSeconds, 'observe').mockImplementation(() => { throw new Error('metric broken'); });
    expect(() => transaction(() => run('INSERT INTO commit_probe (v) VALUES (?)', ['committed']))).not.toThrow();
    expect(probes()).toEqual(['committed']);
  });

  test('a transaction inside another leaves the outer one as it was, and times nothing', async () => {
    const before = await commits();
    transaction(() => {
      run('INSERT INTO commit_probe (v) VALUES (?)', ['outer']);
      expect(() => transaction(() => run('INSERT INTO commit_probe (v) VALUES (?)', ['inner']))).toThrow();
    });
    expect(probes()).toEqual(['outer']);
    expect(await commits()).toBe(before + 1);
  });
});

describe('every COMMIT of the server goes through transaction()', () => {
  // Outside db.js (whose migrations commit their own steps at start), a
  // COMMIT written by hand would not be timed.
  test('no other file runs a COMMIT', () => {
    const src = path.join(ROOT, 'Oscar_Server', 'src');
    const commitsBy = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /exec\(\s*['"`]COMMIT/i.test(fs.readFileSync(p, 'utf8'))) {
          commitsBy.push(path.relative(src, p).replaceAll('\\', '/'));
        }
      }
    };
    walk(src);
    expect(commitsBy).toEqual(['db/db.js']);
  });

  test('transaction() commits through timedCommit()', () => {
    const db = fs.readFileSync(path.join(ROOT, 'Oscar_Server', 'src', 'db', 'db.js'), 'utf8');
    const helper = db.slice(db.indexOf('function transaction(fn) {'));
    expect(helper).toMatch(/^function transaction\(fn\) \{\s+db\.exec\('BEGIN'\);\s+try \{\s+fn\(\);\s+timedCommit\(\);/);
  });
});

describe('what the dashboard reads', () => {
  const overview = JSON.parse(fs.readFileSync(path.join(ROOT, 'OSCAR_Deploy/grafana/dashboards/oscar-overview.json'), 'utf8'));
  const exprs = overview.panels.flatMap((p) => (p.targets || []).map((t) => t.expr)).join('\n');

  test('each bound it counts commits under is a bound of the histogram', () => {
    const bounds = metrics.dbCommitSeconds.upperBounds;
    const read = [...exprs.matchAll(/oscar_db_commit_seconds_bucket\{le="([0-9.]+)"\}/g)].map((m) => Number(m[1]));
    expect(read.length).toBeGreaterThan(0);
    for (const le of read) expect(bounds).toContain(le);
  });

  test('the panel sits in the row of the server\'s thread', () => {
    const row = overview.panels.find((p) => p.type === 'row' && p.title.includes('#1205'));
    const panel = overview.panels.find((p) => (p.targets || []).some((t) => t.expr.includes('oscar_db_commit_seconds')));
    expect(panel.gridPos.y).toBeGreaterThan(row.gridPos.y);
    expect(overview.panels.filter((p) => p.id === panel.id)).toHaveLength(1);
  });
});
