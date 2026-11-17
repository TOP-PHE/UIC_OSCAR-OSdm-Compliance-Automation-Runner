// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checkIndexes.js — which index finds a company's checks (#1295, #1305).
 *
 * run_assertions had an index (company_id, assertion_key): sorted by the text
 * of the check, so the 250 to 400 checks of one run each landed on a page of
 * their own. On a database of 7.7 million checks a run wrote 860 pages of
 * log; without that index, 94. It was read by the two trend routes, which now
 * read by run (api/helpers/checkTrends.js), and by the cascade from a deleted
 * company. An index on company_id alone serves the cascade: a company's
 * checks are neighbours there, in the order they are stored.
 *
 * The swap reads every page of the old index and every check: seconds on a
 * small database, a quarter of an hour on the test machine's (8.5 million
 * checks, a slow disk). So:
 * - at start (migration 56) it is made only on a database of at most
 *   AT_START_MAX_CHECKS checks, in one transaction. A larger one keeps the old
 *   index, which still works, and each start says so in one line;
 * - on a large database an operator runs this file as a command, at a quiet
 *   time:
 *
 *       node src/db/checkIndexes.js            what there is, what it would do
 *       node src/db/checkIndexes.js --apply    does it
 *
 * The command works in two parts, the old index removed, then the new one
 * made. Each part first reads what it will need as an ordinary reader, which
 * blocks nobody: the server works as usual. Only then does it change the
 * database, with the pages it needs in memory. While it changes it, readers
 * go on, but whatever writes waits, then fails. The first run on a server
 * (#1305) did the reading under the write lock: 442 s for the first part
 * alone, every write of the server failing, and nothing on the screen.
 *
 * It refuses while a run is queued or running, at the start and again before
 * each change; with the server stopped, --force passes that (a stopped server
 * leaves its runs marked running). What it says also goes to a file beside
 * the database, check-indexes.log: closing the window does not stop it.
 *
 * Only node: modules, and no db.js: the command opens a connection of its own.
 */

const fs = require('node:fs');
const path = require('node:path');

const KEY_INDEX = 'idx_run_assertions_key';
const COMPANY_INDEX = 'idx_run_assertions_company';
const REMOVE_KEY_INDEX = `DROP INDEX IF EXISTS ${KEY_INDEX}`;
const MAKE_COMPANY_INDEX = `CREATE INDEX IF NOT EXISTS ${COMPANY_INDEX} ON run_assertions(company_id)`;
// The old index first: the new one is then written in the pages it frees, and
// the database file does not grow.
const SWAP = [
  ['removing the index by check text', REMOVE_KEY_INDEX],
  ['making the index by company', MAKE_COMPANY_INDEX],
];
// About 2,000 runs. Measured: 19 s for 7.7 million checks on a fast disk with
// the database in memory, 15 minutes for 8.5 million on the test machine: a
// few seconds here at the worst, well inside what a start is given before it
// is taken for a failure.
const AT_START_MAX_CHECKS = 500000;
// What the swap needs on the database's disk while it runs: the new index in
// the log, and SQLite's sort files, about 45 bytes a check each. With a margin.
const BYTES_NEEDED_PER_CHECK = 150;
// The checks read together before the command looks at the time, and how
// often it says how far it is.
const CHECKS_PER_READ = 100000;
const PROGRESS_EVERY_MS = 10000;
const LOG_NAME = 'check-indexes.log';

/** The checks' indexes as the database has them, and how many checks at most. */
function stateOf(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_assertions'")
    .all().map((row) => row.name));
  // The highest id ever given: read from the end of the table, not counted.
  const checks = Number(db.prepare('SELECT MAX(id) AS n FROM run_assertions').get().n) || 0;
  return { keyIndex: names.has(KEY_INDEX), companyIndex: names.has(COMPANY_INDEX), checks };
}

const isSwapped = (state) => state.companyIndex && !state.keyIndex;

/** The swap, in one transaction. `onStep(what, seconds)` after each statement. */
function swap(db, onStep = () => {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [what, sql] of SWAP) {
      const started = process.hrtime.bigint();
      db.exec(sql);
      onStep(what, Number(process.hrtime.bigint() - started) / 1e9);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* the first error is the one to report */ }
    throw e;
  }
}

/**
 * At start: the swap on a database small enough for it to take a moment.
 * @returns {{ swapped: boolean, state: object }} `state` as it is afterwards
 */
function swapAtStart(db, { maxChecks = AT_START_MAX_CHECKS } = {}) {
  const state = stateOf(db);
  if (isSwapped(state) || state.checks > maxChecks) return { swapped: false, state };
  swap(db);
  return { swapped: true, state: stateOf(db) };
}

const COMMAND_TEXT = 'At a quiet time, run "node src/db/checkIndexes.js --apply" in the server\'s container '
  + '(#1295, metrics-and-monitoring.md).';

/** What a start says while the swap is still to be made, else null. */
function pendingText(state) {
  if (isSwapped(state)) return null;
  const about = `about ${state.checks.toLocaleString('en-US')} checks`;
  if (state.keyIndex) {
    return `[db] the checks are still indexed by their text (${about}): `
      + `each stored run writes several times the pages it needs. ${COMMAND_TEXT}`;
  }
  // The command was stopped between its two parts.
  return `[db] the checks have no index by company yet (${about}): deleting a company reads every one of them. ${COMMAND_TEXT}`;
}

// ── The command ──────────────────────────────────────────────────────────────

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024)).toLocaleString('en-US')} MB`;
const count = (n) => n.toLocaleString('en-US');
const secondsSince = (started) => (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);

function freeBytes(folder) {
  try {
    const disk = fs.statfsSync(folder);
    return Number(disk.bavail) * Number(disk.bsize);
  } catch {
    return null;   // not known: not checked
  }
}

// Making the index sorts every check, in files of about the size of the index:
// beside the database, where the space is (and is checked). SQLite's own
// choice is /tmp, which a container may keep small.
function sortBeside(db, file) {
  const folder = path.dirname(path.resolve(file));
  try {
    db.exec(`PRAGMA temp_store_directory = '${folder.replaceAll("'", "''")}'`);
  } catch { /* not writable, or not known to this SQLite: its own choice then */ }
}

function runsGoing(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('QUEUED', 'RUNNING')").get().n);
}

/** Why the swap is not started now, or null. */
function refusal(db, state, { force, free }) {
  const going = runsGoing(db);
  if (going > 0 && !force) {
    return `${going} run(s) are queued or running: nothing changed. Wait for them to end. `
      + 'If the server is stopped, those are runs it left marked; add --force.';
  }
  const needed = state.checks * BYTES_NEEDED_PER_CHECK;
  if (!state.companyIndex && free !== null && free < needed && !force) {
    return `the database's disk has ${megabytes(free)} free and the swap needs about ${megabytes(needed)} while it runs: `
      + 'nothing changed. Free some space, or add --force.';
  }
  return null;
}

// The old index, read from end to end as a reader: company by company, so
// that there is something to say meanwhile. Removing it reads the same pages.
function readOldIndex(db, state, tell) {
  const companies = db.prepare('SELECT id FROM companies').all();
  const entries = db.prepare(`SELECT COUNT(*) AS n FROM run_assertions INDEXED BY ${KEY_INDEX} WHERE company_id = ?`);
  let read = 0;
  companies.forEach(({ id }, at) => {
    read += Number(entries.get(id).n);
    tell(`${at + 1} of ${companies.length} companies, ${count(read)} checks`);
  });
}

// The checks, read from the first to the last as a reader. Making the index
// reads the same pages.
function readChecks(db, state, tell) {
  const slice = db.prepare('SELECT COUNT(company_id) AS n FROM run_assertions NOT INDEXED WHERE id > ? AND id <= ?');
  for (let from = 0; from < state.checks; from += CHECKS_PER_READ) {
    slice.get(from, from + CHECKS_PER_READ);
    tell(`${count(Math.min(from + CHECKS_PER_READ, state.checks))} of ${count(state.checks)} checks`);
  }
}

// The two parts, in order. `needed` says whether the database still needs it.
const PARTS = [
  {
    needed: (state) => state.keyIndex,
    plan: 'remove the index by check text',
    title: 'removing the index by check text',
    reading: 'Reading that index first',
    read: readOldIndex,
    changing: 'Now removing it',
    sql: REMOVE_KEY_INDEX,
    done: 'Removed',
  },
  {
    needed: (state) => !state.companyIndex,
    plan: 'make the index by company',
    title: 'making the index by company',
    reading: 'Reading the checks first',
    read: readChecks,
    changing: 'Now making the index, which sorts and writes every check',
    sql: MAKE_COMPANY_INDEX,
    done: 'Made',
  },
];

/** What --apply would do to a database in this state, in words. */
function planText(state) {
  const todo = PARTS.filter((part) => part.needed(state)).map((part) => part.plan);
  return `--apply would ${todo.join(', then ')}. Each part first reads what it needs, without any lock: the server works as usual. `
    + 'It then changes the database, and until that ends whatever writes to it waits, then fails. '
    + 'Choose a quiet time, with no run going.';
}

// One part: read without a lock, look for runs once more, change.
// Returns a refusal, or null when the part is done.
function doPart(db, part, state, { say, force, now, label, afterReading }) {
  say(`${label}, ${part.title}.`);
  say(`${part.reading}, without any lock: the server works as usual. This is the long part.`);
  const reading = process.hrtime.bigint();
  let lastSaid = now();
  part.read(db, state, (text) => {
    if (now() - lastSaid < PROGRESS_EVERY_MS) return;
    lastSaid = now();
    say(`  read so far: ${text} (${secondsSince(reading)} s)`);
  });
  const readFor = secondsSince(reading);
  afterReading(part);
  const going = runsGoing(db);
  if (going > 0 && !force) {
    return `${going} run(s) started meanwhile: stopping before the database is changed, so that they do not fail. `
      + 'What was done so far stays. Run the command again when they have ended.';
  }
  say(`Read in ${readFor} s. ${part.changing}: the server cannot write until the next line.`);
  const changing = process.hrtime.bigint();
  db.exec(part.sql);
  say(`${part.done}: the server could not write for ${secondsSince(changing)} s.`);
  return null;
}

// What the command says goes to the screen and to a file beside the database:
// the screen may be gone (a closed window does not stop the command).
function sayer(log, logFile) {
  return (text) => {
    try { log(`[check-indexes] ${text}`); } catch { /* the screen is gone: the file has it */ }
    if (!logFile) return;
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch { /* the screen has it */ }
  };
}

function apply(db, state, file, { say, force, now, afterReading }) {
  const pagesBefore = Number(db.prepare('PRAGMA page_count').get().page_count);
  const parts = PARTS.filter((part) => part.needed(state));
  say(`This is process ${process.pid}. Closing this window, or Ctrl-C, does not stop it: it goes on in the container, `
    + `and writes what it says to ${path.join(path.dirname(file), LOG_NAME)}. To stop it, from another window: kill ${process.pid}. `
    + 'A part that had not ended changes nothing.');
  for (const [at, part] of parts.entries()) {
    const stopped = doPart(db, part, state, { say, force, now, afterReading, label: `Part ${at + 1} of ${parts.length}` });
    if (stopped) {
      say(stopped);
      return 1;
    }
  }
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const freed = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
  const grown = Number(db.prepare('PRAGMA page_count').get().page_count) - pagesBefore;
  say(`done. The database file ${grown > 0 ? `grew by ${megabytes(grown * pageSize)}` : 'keeps its size'}; `
    + `${megabytes(freed * pageSize)} of it are free and will hold the next data stored.`);
  return 0;
}

/**
 * The command. Returns its exit code: 0 done or nothing to do, 1 refused,
 * stopped or failed, 2 wrong arguments.
 */
function main(args, {
  log = console.log, file = process.env.OSCAR_DB_PATH || path.resolve(__dirname, '../../data/oscar.db'),
  freeOf = freeBytes, now = Date.now, afterReading = () => {},
} = {}) {
  const applying = args.includes('--apply');
  const force = args.includes('--force');
  let say = sayer(log, null);
  const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--force');
  if (unknown.length > 0) {
    say(`unknown argument ${unknown[0]}. Usage: node src/db/checkIndexes.js [--apply] [--force]`);
    return 2;
  }
  if (!fs.existsSync(file)) {
    say(`no database at ${file}`);
    return 1;
  }
  const { DatabaseSync } = require('node:sqlite');
  // It waits for a write of the server's to end, instead of failing.
  const db = new DatabaseSync(file, { timeout: 30000 });
  try {
    sortBeside(db, file);
    // As the server's connection: 64 MB of pages in memory, not SQLite's 2 MB.
    db.exec('PRAGMA cache_size = -65536');
    // Making the index sorts every check, and that is done while the server
    // cannot write: with SQLite's worker threads, 24 to 26 s against 36 to 44 s
    // for 7.8 million checks on the bench.
    db.exec('PRAGMA threads = 4');
    const state = stateOf(db);
    const found = `${file}: about ${count(state.checks)} checks; index by check text ${state.keyIndex ? 'present' : 'absent'}, `
      + `index by company ${state.companyIndex ? 'present' : 'absent'}`;
    if (isSwapped(state)) {
      say(found);
      say('nothing to do');
      return 0;
    }
    if (!applying) {
      say(found);
      say(planText(state));
      return 0;
    }
    const refused = refusal(db, state, { force, free: freeOf(path.dirname(file)) });
    if (refused) {
      say(found);
      say(refused);
      return 1;
    }
    say = sayer(log, path.join(path.dirname(file), LOG_NAME));
    say(found);
    return apply(db, state, file, { say, force, now, afterReading });
  } catch (e) {
    say(`failed: ${e.message}. A part that had not ended changed nothing: run the command without --apply to see what there is.`);
    return 1;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  stateOf, isSwapped, swap, swapAtStart, pendingText, planText, main, refusal,
  KEY_INDEX, COMPANY_INDEX, AT_START_MAX_CHECKS, BYTES_NEEDED_PER_CHECK, CHECKS_PER_READ, PROGRESS_EVERY_MS, LOG_NAME,
};
