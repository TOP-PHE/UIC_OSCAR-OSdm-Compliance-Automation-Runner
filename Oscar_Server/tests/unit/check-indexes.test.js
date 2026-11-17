// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1295: the checks are indexed by company, no longer by company and text of
// the check. The swap is made at start on a small database (migration 56), by
// a command on a large one; until then the old index stays and still works.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const C = require('../../src/db/checkIndexes');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-check-indexes-'));
const opened = [];
afterAll(() => {
  for (const db of opened) { try { db.close(); } catch { /* closed by its test */ } }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// The server's db.js on a database file of this test: schema, then migrations.
function boot(file) {
  const saved = process.env.OSCAR_DB_PATH;
  let fresh;
  try {
    process.env.OSCAR_DB_PATH = file;
    jest.isolateModules(() => { fresh = require('../../src/db/db'); });
  } finally {
    if (saved === undefined) delete process.env.OSCAR_DB_PATH;
    else process.env.OSCAR_DB_PATH = saved;
  }
  opened.push(fresh.db);
  return fresh;
}

const indexesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_assertions' AND sql IS NOT NULL")
  .all().map((row) => row.name).sort((a, b) => a.localeCompare(b));
const SWAPPED = ['idx_run_assertions_company', 'idx_run_assertions_request', 'idx_run_assertions_run_passed', 'idx_run_assertions_suite'];
const AS_BEFORE = ['idx_run_assertions_key', 'idx_run_assertions_request', 'idx_run_assertions_run_passed', 'idx_run_assertions_suite'];

// A database as release 2026.575 left it: migration 55 applied, the checks
// indexed by company and text. `highestCheck` puts one check at that id, which
// is how many checks the database is taken to hold.
function databaseAt55(name, { highestCheck = 0, activeRuns = 0 } = {}) {
  const file = path.join(tempDir, `${name}.db`);
  boot(file).db.close();
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  db.exec(`
    DROP INDEX idx_run_assertions_company;
    CREATE INDEX idx_run_assertions_key ON run_assertions(company_id, assertion_key);
    DELETE FROM schema_version WHERE version >= 56;`);
  if (highestCheck > 0) {
    db.prepare(`INSERT INTO run_assertions (id, request_id, suite_id, run_id, company_id, assertion_key, assertion_name)
                VALUES (?, 1, 1, 'r', 'c', 'k', 'n')`).run(highestCheck);
  }
  for (let i = 0; i < activeRuns; i++) {
    db.prepare("INSERT INTO runs (id, company_id, user_id, status) VALUES (?, 'c', 'u', ?)").run(randomUUID(), i % 2 ? 'QUEUED' : 'RUNNING');
  }
  db.close();
  return file;
}

function command(args, file, more = {}) {
  const lines = [];
  const code = C.main(args, { log: (line) => lines.push(line), file, freeOf: () => null, ...more });
  return { code, lines, text: lines.join('\n') };
}
const readOnly = (file, read) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return read(db); } finally { db.close(); }
};

describe('at start (migration 56)', () => {
  test('a new database has the index by company, and never had the other', () => {
    const fresh = boot(path.join(tempDir, 'new.db'));
    expect(indexesOf(fresh.db)).toEqual(SWAPPED);
    expect(fresh.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBeGreaterThanOrEqual(56);
    fresh.db.close();
  });

  test('a small database is swapped, and says nothing more', () => {
    const file = databaseAt55('small', { highestCheck: C.AT_START_MAX_CHECKS });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const again = boot(file);
      expect(indexesOf(again.db)).toEqual(SWAPPED);
      expect(again.db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 56').get().n).toBe(1);
      expect(warn.mock.calls.flat().join('\n')).not.toContain('checkIndexes');
      again.db.close();
    } finally {
      warn.mockRestore();
    }
  });

  test('a large database keeps its index, which still finds a company\'s checks, and each start says what to run', () => {
    const file = databaseAt55('large', { highestCheck: C.AT_START_MAX_CHECKS + 1 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const start of [1, 2]) {
        const again = boot(file);
        expect([start, indexesOf(again.db)]).toEqual([start, AS_BEFORE]);
        expect(again.db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 56').get().n).toBe(1);
        const plan = again.db.prepare('EXPLAIN QUERY PLAN DELETE FROM run_assertions WHERE company_id = ?').all('c')
          .map((row) => row.detail).join(' | ');
        expect(plan).toContain('idx_run_assertions_key (company_id=?)');
        again.db.close();
        const said = warn.mock.calls.flat().filter((line) => String(line).includes('checkIndexes'));
        expect(said).toHaveLength(start);
        expect(said[0]).toContain('node src/db/checkIndexes.js --apply');
        expect(said[0]).toContain('500,001 checks');
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('the size it goes by is the highest id of a check, read from the end of the table', () => {
    const file = databaseAt55('counted', { highestCheck: 42 });
    readOnly(file, (db) => {
      expect(C.stateOf(db)).toEqual({ keyIndex: true, companyIndex: false, checks: 42 });
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT MAX(id) AS n FROM run_assertions').all().map((row) => row.detail).join(' | ');
      expect(plan).not.toMatch(/SCAN run_assertions$/);
    });
    expect(C.AT_START_MAX_CHECKS).toBe(500000);
  });
});

describe('the swap', () => {
  test('all or nothing: a failure leaves the old index', () => {
    const file = databaseAt55('atomic', { highestCheck: 10 });
    const db = new DatabaseSync(file);
    try {
      // The second statement fails: something else has the new index's name.
      db.exec('CREATE TABLE idx_run_assertions_company (x)');
      const steps = [];
      expect(() => C.swap(db, (what) => steps.push(what))).toThrow(/idx_run_assertions_company/);
      expect(steps).toEqual(['removing the index by check text']);
      expect(indexesOf(db)).toEqual(AS_BEFORE);
      // No transaction left open.
      db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } finally {
      db.close();
    }
  });

  test('the old index goes first, so the new one is written in the pages it frees', () => {
    const file = databaseAt55('order');
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    try {
      const insert = db.prepare(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name)
                                 VALUES (1, 1, 'r', ?, ?, 'n')`);
      db.exec('BEGIN');
      for (let i = 0; i < 20000; i++) insert.run(`company-${i % 5}`, `a rather long key of a check, number ${i}`);
      db.exec('COMMIT');
      const before = db.prepare('PRAGMA page_count').get().page_count;
      const steps = [];
      C.swap(db, (what, seconds) => steps.push([what, typeof seconds]));
      expect(steps).toEqual([['removing the index by check text', 'number'], ['making the index by company', 'number']]);
      expect(indexesOf(db)).toEqual(SWAPPED);
      expect(db.prepare('PRAGMA page_count').get().page_count).toBe(before);
      expect(db.prepare('PRAGMA freelist_count').get().freelist_count).toBeGreaterThan(0);
      expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    } finally {
      db.close();
    }
  });
});

describe('the command, for a large database', () => {
  test('without --apply it says what there is and what it would do, and changes nothing', () => {
    const file = databaseAt55('told', { highestCheck: 1234567 });
    const { code, text } = command([], file);
    expect(code).toBe(0);
    expect(text).toContain('about 1,234,567 checks; index by check text present, index by company absent');
    expect(text).toContain('--apply would remove the index by check text and make the index by company');
    expect(text).toContain('choose a quiet time');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));
  });

  test('--apply swaps, says how long each part took, and a second run has nothing to do', () => {
    const file = databaseAt55('applied', { highestCheck: 1234567 });
    // The free space is read from the disk here, as the command does by itself.
    const first = command(['--apply'], file, { freeOf: undefined });
    expect(first.code).toBe(0);
    expect(first.lines.filter((line) => / s$/.test(line)).map((line) => line.replace(/: [\d.]+ s$/, ''))).toEqual([
      '[check-indexes] removing the index by check text', '[check-indexes] making the index by company',
    ]);
    expect(first.text).toMatch(/done\. The database file keeps its size; \d+ MB of it are free/);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));

    const second = command(['--apply'], file);
    expect(second.code).toBe(0);
    expect(second.text).toContain('nothing to do');

    // And the server then starts without a word about it.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const again = boot(file);
      expect(indexesOf(again.db)).toEqual(SWAPPED);
      again.db.close();
      expect(warn.mock.calls.flat().join('\n')).not.toContain('checkIndexes');
    } finally {
      warn.mockRestore();
    }
  });

  test('a database with both indexes still has the old one to remove', () => {
    const file = databaseAt55('both', { highestCheck: C.AT_START_MAX_CHECKS + 1 });
    const db = new DatabaseSync(file);
    db.exec('CREATE INDEX idx_run_assertions_company ON run_assertions(company_id)');
    expect(C.isSwapped(C.stateOf(db))).toBe(false);
    expect(C.pendingText(C.stateOf(db))).toContain('node src/db/checkIndexes.js --apply');
    db.close();

    const told = command([], file);
    expect(told.text).toContain('index by check text present, index by company present');
    expect(told.text).toContain('--apply would remove');
    expect(command(['--apply'], file).code).toBe(0);
    readOnly(file, (after) => {
      expect(indexesOf(after)).toEqual(SWAPPED);
      expect(C.pendingText(C.stateOf(after))).toBeNull();
    });
  });

  test('it refuses while a run is queued or running; --force is for a stopped server', () => {
    const file = databaseAt55('busy', { highestCheck: 10, activeRuns: 3 });
    const refused = command(['--apply'], file);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('3 run(s) are queued or running: nothing changed');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));

    expect(command(['--apply', '--force'], file).code).toBe(0);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));
  });

  test('it refuses when the disk has less free than the swap needs; a size it cannot read is not checked', () => {
    const file = databaseAt55('full', { highestCheck: 1000000 });
    const needed = 1000000 * C.BYTES_NEEDED_PER_CHECK;
    const refused = command(['--apply'], file, { freeOf: () => needed - 1 });
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('143 MB free and the swap needs about 143 MB');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));

    let asked;
    expect(command(['--apply'], file, { freeOf: (folder) => { asked = folder; return needed; } }).code).toBe(0);
    expect(asked).toBe(path.dirname(file));

    const other = databaseAt55('unknown-space', { highestCheck: 1000000 });
    expect(command(['--apply'], other, { freeOf: () => null }).code).toBe(0);
  });

  test('a wrong argument, or no database: nothing made, nothing changed', () => {
    const file = databaseAt55('arguments', { highestCheck: 10 });
    const wrong = command(['--aply'], file);
    expect(wrong.code).toBe(2);
    expect(wrong.text).toContain('unknown argument --aply');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));

    const missing = path.join(tempDir, 'not-there.db');
    const none = command(['--apply'], missing);
    expect(none.code).toBe(1);
    expect(none.text).toContain('no database at');
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('a file that is not OSCAR\'s database: said, not thrown', () => {
    const file = path.join(tempDir, 'other.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (x)');
    db.close();
    const { code, text } = command(['--apply'], file);
    expect(code).toBe(1);
    expect(text).toContain('failed, nothing changed');
  });

  test('run as a program, it ends with the command\'s code', () => {
    const { spawnSync } = require('node:child_process');
    const file = databaseAt55('program', { highestCheck: 10 });
    const script = path.resolve(__dirname, '../../src/db/checkIndexes.js');
    const run = (args) => spawnSync(process.execPath, ['--no-warnings', script, ...args], { encoding: 'utf8', env: { ...process.env, OSCAR_DB_PATH: file } });
    const told = run([]);
    expect([told.status, told.stdout.includes('--apply would remove')]).toEqual([0, true]);
    expect(run(['--nope']).status).toBe(2);
    const applied = run(['--apply']);
    expect([applied.status, applied.stdout.includes('done.')]).toEqual([0, true]);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));
  });
});

describe('a company is deleted through its runs, with either index', () => {
  test.each([['swapped', false], ['not yet swapped', true]])('%s', (_name, large) => {
    const file = databaseAt55(`purge-${large}`, large ? { highestCheck: C.AT_START_MAX_CHECKS + 1 } : {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let store;
    let purge;
    const saved = process.env.OSCAR_DB_PATH;
    try {
      process.env.OSCAR_DB_PATH = file;
      jest.isolateModules(() => {
        store = require('../../src/db/db');
        purge = require('../../src/utils/companyPurge');
      });
    } finally {
      if (saved === undefined) delete process.env.OSCAR_DB_PATH;
      else process.env.OSCAR_DB_PATH = saved;
      warn.mockRestore();
    }
    opened.push(store.db);
    expect(indexesOf(store.db)).toEqual(large ? AS_BEFORE : SWAPPED);
    // The check left by the set-up names no company: out of the way.
    store.run('PRAGMA foreign_keys = OFF');
    store.run("DELETE FROM run_assertions WHERE company_id = 'c'");
    store.run('PRAGMA foreign_keys = ON');

    const companies = ['gone', 'stays'].map((name) => {
      const id = randomUUID();
      store.run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [id, `${name} ${id.slice(0, 6)}`, `${name}-${id.slice(0, 8)}`]);
      const user = randomUUID();
      store.run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [user, id, `${user}@purge.example`]);
      for (let r = 0; r < 3; r++) {
        const runId = randomUUID();
        store.run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code) VALUES (?, ?, ?, 'COMPLETED', 'CODE')`, [runId, id, user]);
        const suite = store.run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [runId, id, 'CODE', 's']).lastInsertRowid;
        const req = store.run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, ?)', [suite, runId, id, 'step']).lastInsertRowid;
        for (let c = 0; c < 4; c++) {
          store.run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name) VALUES (?, ?, ?, ?, ?, 'n')`,
            [req, suite, runId, id, `key-${c}`]);
        }
      }
      return { id, slug: `${name}-${id.slice(0, 8)}` };
    });
    const count = (table, id) => store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`, [id]).n;

    purge.purgeCompany(companies[0]);

    for (const table of ['runs', 'run_suites', 'run_requests', 'run_assertions', 'users']) {
      expect([table, count(table, companies[0].id)]).toEqual([table, 0]);
    }
    expect(store.get('SELECT id FROM companies WHERE id = ?', [companies[0].id])).toBeUndefined();
    expect([count('runs', companies[1].id), count('run_suites', companies[1].id), count('run_requests', companies[1].id), count('run_assertions', companies[1].id)])
      .toEqual([3, 3, 3, 12]);
    expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
    store.db.close();
  });

  test('the three tables a run fills are deleted by run, the checks first', () => {
    const { THROUGH_RUNS, BY_PARENT, OWNED } = require('../../src/utils/companyPurge');
    expect(THROUGH_RUNS).toEqual(['run_assertions', 'run_requests', 'run_suites']);
    for (const table of THROUGH_RUNS) {
      expect(OWNED).toContain(table);
      expect(BY_PARENT).toContain(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)`);
    }
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/utils/companyPurge.js'), 'utf8');
    expect(source).toContain('OWNED.filter(table => !THROUGH_RUNS.includes(table))');
  });
});
