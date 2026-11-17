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
// #1305: the command reads what each of its two parts needs before it changes
// the database, says each step before it starts, and keeps a log.

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
  fs.mkdirSync(path.join(tempDir, name), { recursive: true });
  const file = path.join(tempDir, name, `${name}.db`);
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
  const logOf = (file) => {
    try { return fs.readFileSync(path.join(path.dirname(file), C.LOG_NAME), 'utf8'); } catch { return ''; }
  };
  // What the command said, without its times, process id and sizes.
  const said = (lines) => lines.map((line) => line.replace('[check-indexes] ', '')
    .replaceAll(/\d+\.\d s/g, 'N s').replaceAll(/process \d+/g, 'process P').replaceAll(/kill \d+/g, 'kill P')
    .replaceAll(/\d+ MB/g, 'N MB'));
  // A run that starts while the command is reading, seen from another connection.
  const startRun = (file) => {
    const other = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    other.prepare("INSERT INTO runs (id, company_id, user_id, status) VALUES (?, 'c', 'u', 'RUNNING')").run(randomUUID());
    other.close();
  };
  const endRuns = (file) => {
    const other = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    other.exec("UPDATE runs SET status = 'COMPLETED' WHERE status IN ('QUEUED', 'RUNNING')");
    other.close();
  };

  test('without --apply it says what there is and what it would do, and changes nothing', () => {
    const file = databaseAt55('told', { highestCheck: 1234567 });
    const { code, text } = command([], file);
    expect(code).toBe(0);
    expect(text).toContain('about 1,234,567 checks; index by check text present, index by company absent');
    expect(text).toContain('--apply would remove the index by check text, then make the index by company.');
    expect(text).toContain('Each part first reads what it needs, without any lock: the server works as usual.');
    expect(text).toContain('whatever writes to it waits, then fails. Choose a quiet time, with no run going.');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));
    // Nothing is done: no log either.
    expect(logOf(file)).toBe('');
  });

  test('--apply says each step before it starts, and how long the server could not write', () => {
    const file = databaseAt55('applied', { highestCheck: 1234567 });
    // The free space is read from the disk here, as the command does by itself.
    const first = command(['--apply'], file, { freeOf: undefined });
    expect(first.code).toBe(0);
    expect(said(first.lines)).toEqual([
      `${file}: about 1,234,567 checks; index by check text present, index by company absent`,
      `This is process P. Closing this window, or Ctrl-C, does not stop it: it goes on in the container, and writes what it says to ${path.join(path.dirname(file), 'check-indexes.log')}. To stop it, from another window: kill P. A part that had not ended changes nothing.`,
      'Part 1 of 2, removing the index by check text.',
      'Reading that index first, without any lock: the server works as usual. This is the long part.',
      'Read in N s. Now removing it: the server cannot write until the next line.',
      'Removed: the server could not write for N s.',
      'Part 2 of 2, making the index by company.',
      'Reading the checks first, without any lock: the server works as usual. This is the long part.',
      'Read in N s. Now making the index, which sorts and writes every check: the server cannot write until the next line.',
      'Made: the server could not write for N s.',
      'done. The database file keeps its size; N MB of it are free and will hold the next data stored.',
    ]);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));

    // The same lines are in the log beside the database, each with its time.
    const logged = logOf(file).trimEnd().split('\n');
    expect(logged).toHaveLength(first.lines.length);
    for (const [at, line] of logged.entries()) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(line.slice(25)).toBe(first.lines[at].replace('[check-indexes] ', ''));
    }

    const second = command(['--apply'], file);
    expect(second.code).toBe(0);
    expect(second.text).toContain('nothing to do');
    expect(logOf(file).trimEnd().split('\n')).toHaveLength(first.lines.length);

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

  test('each part reads before it changes: no lock while it reads, and what it read is still there', () => {
    const file = databaseAt55('reads', { highestCheck: 10 });
    const seen = [];
    const { code } = command(['--apply'], file, {
      afterReading: () => {
        // Another connection writes at once: nothing holds the write lock.
        const other = new DatabaseSync(file, { timeout: 0 });
        other.exec('CREATE TABLE IF NOT EXISTS probe (x); INSERT INTO probe (x) VALUES (1)');
        seen.push(indexesOf(other).filter((name) => name === C.KEY_INDEX || name === C.COMPANY_INDEX));
        other.close();
      },
    });
    expect(code).toBe(0);
    // Read for part 1: the old index is still there. Read for part 2: it is gone, the new one not made yet.
    expect(seen).toEqual([[C.KEY_INDEX], []]);
    readOnly(file, (db) => {
      expect(indexesOf(db)).toEqual(SWAPPED);
      expect(db.prepare('SELECT COUNT(*) AS n FROM probe').get().n).toBe(2);
    });
  });

  test('what it reads: the whole old index, company by company, then every check, by their ids', () => {
    const file = databaseAt55('progress');
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    const companies = ['one', 'two', 'three'];
    for (const id of companies) db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run(id, `Company ${id}`, `slug-${id}`);
    const insert = db.prepare(`INSERT INTO run_assertions (id, request_id, suite_id, run_id, company_id, assertion_key, assertion_name)
                               VALUES (?, 1, 1, 'r', ?, ?, 'n')`);
    db.exec('BEGIN');
    for (let i = 1; i <= 60; i++) insert.run(i, companies[i % 3], `key ${i}`);
    // The last id is far away: the ids in between are read too, and found empty.
    insert.run(2 * C.CHECKS_PER_READ + 5, 'one', 'the last key');
    db.exec('COMMIT');
    const inAll = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
    const plans = (sql, ...params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(' | ');
    expect(plans(`SELECT COUNT(*) AS n FROM run_assertions INDEXED BY ${C.KEY_INDEX} WHERE company_id = ?`, 'one'))
      .toContain(`USING COVERING INDEX ${C.KEY_INDEX} (company_id=?)`);
    expect(plans('SELECT COUNT(company_id) AS n FROM run_assertions NOT INDEXED WHERE id > ? AND id <= ?', 0, 10))
      .toContain('USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)');
    db.close();

    // A clock that jumps 11 s at each look: every step of a reading is told.
    let clock = 0;
    const { code, lines } = command(['--apply'], file, { now: () => (clock += 11000) });
    expect(code).toBe(0);
    const progress = said(lines).filter((line) => line.startsWith('  read so far: '));
    expect(progress.filter((line) => line.includes('companies')).at(-1)).toBe(`  read so far: ${inAll} of ${inAll} companies, 61 checks (N s)`);
    expect(progress.filter((line) => !line.includes('companies'))).toEqual([
      '  read so far: 100,000 of 200,005 checks (N s)',
      '  read so far: 200,000 of 200,005 checks (N s)',
      '  read so far: 200,005 of 200,005 checks (N s)',
    ]);

    // With the real clock a reading this short says nothing in between.
    const quiet = databaseAt55('quiet', { highestCheck: 10 });
    expect(command(['--apply'], quiet).text).not.toContain('read so far');
    expect([C.CHECKS_PER_READ, C.PROGRESS_EVERY_MS]).toEqual([100000, 10000]);
  });

  test('a run started while it was reading stops it before the change; the next run of the command goes on', () => {
    const file = databaseAt55('meanwhile', { highestCheck: 10 });
    // During the reading of part 1: nothing is changed at all.
    const first = command(['--apply'], file, { afterReading: () => startRun(file) });
    expect(first.code).toBe(1);
    expect(first.text).toContain('1 run(s) started meanwhile: stopping before the database is changed, so that they do not fail.');
    expect(first.text).not.toContain('Now removing it');
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(AS_BEFORE));
    endRuns(file);

    // During the reading of part 2: the old index is gone, the new one is still to make.
    const second = command(['--apply'], file, { afterReading: (part) => { if (part.title.startsWith('making')) startRun(file); } });
    expect(second.code).toBe(1);
    expect(second.text).toContain('Removed: the server could not write for');
    expect(second.text).toContain('What was done so far stays. Run the command again when they have ended.');
    expect(second.text).not.toContain('Now making the index');
    readOnly(file, (db) => {
      expect(C.stateOf(db)).toMatchObject({ keyIndex: false, companyIndex: false });
      expect(C.pendingText(C.stateOf(db))).toContain('the checks have no index by company yet (about 10 checks): deleting a company reads every one of them.');
      expect(C.pendingText(C.stateOf(db))).toContain('node src/db/checkIndexes.js --apply');
    });
    endRuns(file);

    // What is left is said, and done.
    expect(command([], file).text).toContain('--apply would make the index by company. Each part');
    const third = command(['--apply'], file);
    expect(third.code).toBe(0);
    expect(said(third.lines).filter((line) => line.startsWith('Part '))).toEqual(['Part 1 of 1, making the index by company.']);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));

    // With --force a run going stops nothing.
    const forced = databaseAt55('meanwhile-forced', { highestCheck: 10 });
    expect(command(['--apply', '--force'], forced, { afterReading: () => startRun(forced) }).code).toBe(0);
    readOnly(forced, (db) => expect(indexesOf(db)).toEqual(SWAPPED));
  });

  test('a screen that is gone does not stop it: the log has what it said', () => {
    const file = databaseAt55('no-screen', { highestCheck: 10 });
    const { code } = command(['--apply'], file, { log: () => { throw new Error('write EPIPE'); } });
    expect(code).toBe(0);
    readOnly(file, (db) => expect(indexesOf(db)).toEqual(SWAPPED));
    expect(logOf(file)).toContain('Made: the server could not write for');
    expect(logOf(file).trimEnd().split('\n').at(-1)).toContain('done. The database file keeps its size');
  });

  test('a database with both indexes still has the old one to remove', () => {
    const file = databaseAt55('both', { highestCheck: C.AT_START_MAX_CHECKS + 1 });
    const db = new DatabaseSync(file);
    db.exec('CREATE INDEX idx_run_assertions_company ON run_assertions(company_id)');
    expect(C.isSwapped(C.stateOf(db))).toBe(false);
    expect(C.pendingText(C.stateOf(db))).toContain('the checks are still indexed by their text');
    expect(C.pendingText(C.stateOf(db))).toContain('node src/db/checkIndexes.js --apply');
    db.close();

    const told = command([], file);
    expect(told.text).toContain('index by check text present, index by company present');
    expect(told.text).toContain('--apply would remove the index by check text. Each part');
    // Nothing is made, so no space is needed.
    const applied = command(['--apply'], file, { freeOf: () => 1 });
    expect(applied.code).toBe(0);
    expect(said(applied.lines).filter((line) => line.startsWith('Part '))).toEqual(['Part 1 of 1, removing the index by check text.']);
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
    expect(logOf(file)).toBe('');

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
    fs.mkdirSync(path.join(tempDir, 'other'), { recursive: true });
    const file = path.join(tempDir, 'other', 'other.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (x)');
    db.close();
    const { code, text } = command(['--apply'], file);
    expect(code).toBe(1);
    expect(text).toContain('failed: no such table: run_assertions. A part that had not ended changed nothing');
  });

  test('a part that fails says so, and leaves what the part before did', () => {
    const file = databaseAt55('fails', { highestCheck: 10 });
    const blocker = new DatabaseSync(file);
    // Something else has the new index's name: the second part cannot be done.
    blocker.exec('CREATE TABLE idx_run_assertions_company (x)');
    blocker.close();
    const { code, text } = command(['--apply'], file);
    expect(code).toBe(1);
    expect(text).toContain('Removed: the server could not write for');
    expect(text).toMatch(/failed: .*idx_run_assertions_company.*\. A part that had not ended changed nothing: run the command without --apply to see what there is\./);
    readOnly(file, (db) => expect(C.stateOf(db)).toMatchObject({ keyIndex: false, companyIndex: false }));
    expect(logOf(file)).toContain('failed: ');
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
    expect(applied.stdout).toMatch(/This is process \d+\./);
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
