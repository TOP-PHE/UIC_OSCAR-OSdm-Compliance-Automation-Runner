// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1239: the indexes of runs and run_assertions. A partial index holds the
// runs queued or running, which the Dashboard's queue panel reads every 3 s.
// Four indexes no query needed went: each stored check updated 7 indexes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { all } = require('../../src/db/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-indexes-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const indexesOf = (table, query = all) => query(`PRAGMA index_list(${table})`)
  .filter((ix) => ix.origin === 'c')
  .map((ix) => ix.name)
  .sort((a, b) => a.localeCompare(b));
const planOf = (sql, params = []) => all(`EXPLAIN QUERY PLAN ${sql}`, params).map((row) => row.detail).join(' | ');

describe('the indexes after migration 55 (#1239)', () => {
  test('runs: the active runs have their own; (company_id) alone is gone', () => {
    expect(indexesOf('runs')).toEqual([
      'idx_runs_active', 'idx_runs_company_batch', 'idx_runs_company_queued', 'idx_runs_company_scenario',
      'idx_runs_shared_with_certifier', 'idx_runs_status', 'idx_runs_user_id',
    ]);
  });

  test('run_assertions: four indexes, each one read by a query or a cascade', () => {
    expect(indexesOf('run_assertions')).toEqual([
      'idx_run_assertions_key', 'idx_run_assertions_request', 'idx_run_assertions_run_passed', 'idx_run_assertions_suite',
    ]);
  });

  test('every foreign key of both tables has an index that starts with it (a cascade finds its rows)', () => {
    for (const table of ['runs', 'run_assertions']) {
      const firstColumns = new Set(all(`PRAGMA index_list(${table})`)
        .map((ix) => all(`PRAGMA index_info(${ix.name})`)[0]?.name));
      for (const fk of all(`PRAGMA foreign_key_list(${table})`)) {
        expect([table, fk.from, firstColumns.has(fk.from)]).toEqual([table, fk.from, true]);
      }
    }
  });
});

describe('the queries those indexes serve (#1239)', () => {
  test('the queue panel reads the active runs\' index alone', () => {
    const plan = planOf(`
      SELECT r.id, r.status, r.scenario_code, r.batch_id, r.queued_at, r.started_at,
             r.user_id, u.email AS user_email
      FROM runs r
      JOIN users u ON u.id = r.user_id
      WHERE r.company_id = ? AND r.status IN ('QUEUED', 'RUNNING')
      ORDER BY r.queued_at ASC`, ['c']);
    expect(plan).toContain('USING INDEX idx_runs_active (company_id=?)');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  test.each([
    ['a company\'s runs', 'SELECT COUNT(*) FROM runs WHERE company_id = ?', 'runs'],
    ['a company\'s runs deleted', 'DELETE FROM runs WHERE company_id = ?', 'runs'],
    ['a company\'s checks deleted', 'DELETE FROM run_assertions WHERE company_id = ?', 'run_assertions'],
    ['the trends of a check', 'SELECT run_id FROM run_assertions WHERE company_id = ? AND assertion_key = ?', 'run_assertions'],
  ])('%s: an index, never the whole table', (_name, sql, table) => {
    const params = (sql.match(/\?/g) || []).map(() => 'x');
    const plan = planOf(sql, params);
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_/);
    expect(plan).not.toMatch(new RegExp(`SCAN ${table}( |$)`));
  });

  test('the trends of a company group its checks by key from the key\'s index', () => {
    const plan = planOf(`
      SELECT ra.assertion_key, COUNT(*) FROM run_assertions ra JOIN runs r ON r.id = ra.run_id
      WHERE ra.company_id = ? AND r.status IN ('COMPLETED', 'FAILED')
      GROUP BY ra.assertion_key`, ['c']);
    expect(plan).toContain('USING INDEX idx_run_assertions_key (company_id=?)');
  });
});

describe('migration 55 on a database that had the old indexes (#1239)', () => {
  test('it makes the active runs\' index and removes the four', () => {
    const file = path.join(tempDir, 'old.db');
    const boot = () => {
      const saved = process.env.OSCAR_DB_PATH;
      let fresh;
      try {
        process.env.OSCAR_DB_PATH = file;
        jest.isolateModules(() => { fresh = require('../../src/db/db'); });
      } finally {
        if (saved === undefined) delete process.env.OSCAR_DB_PATH;
        else process.env.OSCAR_DB_PATH = saved;
      }
      return fresh;
    };
    const first = boot();
    first.db.close();
    // As a database at migration 54 was: the four indexes, not the new one.
    const old = new DatabaseSync(file);
    old.exec(`
      DROP INDEX idx_runs_active;
      CREATE INDEX idx_runs_company_id ON runs(company_id);
      CREATE INDEX idx_run_assertions_company  ON run_assertions(company_id);
      CREATE INDEX idx_run_assertions_category ON run_assertions(company_id, category);
      CREATE INDEX idx_run_assertions_domain   ON run_assertions(company_id, domain);
      DELETE FROM schema_version WHERE version >= 55;`);
    old.close();
    const again = boot();
    try {
      const q = (sql) => again.db.prepare(sql).all();
      expect(indexesOf('runs', q)).toContain('idx_runs_active');
      expect(indexesOf('runs', q)).not.toContain('idx_runs_company_id');
      expect(indexesOf('run_assertions', q)).toEqual([
        'idx_run_assertions_key', 'idx_run_assertions_request', 'idx_run_assertions_run_passed', 'idx_run_assertions_suite',
      ]);
      expect(q('SELECT MAX(version) AS v FROM schema_version')[0].v).toBeGreaterThanOrEqual(55);
    } finally {
      again.db.close();
    }
  });
});
