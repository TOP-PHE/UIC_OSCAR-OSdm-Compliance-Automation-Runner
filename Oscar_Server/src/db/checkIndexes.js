// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checkIndexes.js — which index finds a company's checks (#1295).
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
 * small database, minutes on a large one. So:
 * - at start (migration 56) it is made only on a database of at most
 *   AT_START_MAX_CHECKS checks. A larger one keeps the old index, which still
 *   works, and each start says so in one line;
 * - on a large database an operator runs this file as a command, at a quiet
 *   time:
 *
 *       node src/db/checkIndexes.js            what there is, what it would do
 *       node src/db/checkIndexes.js --apply    does it
 *
 *   The server may stay up: readers go on, but whatever writes during the swap
 *   waits, then fails. The command refuses while a run is queued or running;
 *   with the server stopped, --force passes that (a stopped server leaves its
 *   runs marked running).
 *
 * Only node: modules, and no db.js: the command opens a connection of its own.
 */

const fs = require('node:fs');
const path = require('node:path');

const KEY_INDEX = 'idx_run_assertions_key';
const COMPANY_INDEX = 'idx_run_assertions_company';
// The old index first: the new one is then written in the pages it frees, and
// the database file does not grow. Both in one transaction: all or nothing.
const SWAP = [
  ['removing the index by check text', `DROP INDEX IF EXISTS ${KEY_INDEX}`],
  ['making the index by company', `CREATE INDEX IF NOT EXISTS ${COMPANY_INDEX} ON run_assertions(company_id)`],
];
// About 2,000 runs. Measured: 19 s for 7.7 million checks on a fast disk with
// the database in memory, so a second or two here, ten times that on a slow
// disk: well inside what a start is given before it is taken for a failure.
const AT_START_MAX_CHECKS = 500000;
// What the swap needs on the database's disk while it runs: the new index in
// the log, and SQLite's sort files, about 45 bytes a check each. With a margin.
const BYTES_NEEDED_PER_CHECK = 150;

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

/** What a start says while the swap is still to be made, else null. */
function pendingText(state) {
  if (isSwapped(state)) return null;
  return `[db] the checks are still indexed by their text (about ${state.checks.toLocaleString('en-US')} checks): `
    + 'each stored run writes several times the pages it needs. At a quiet time, run '
    + '"node src/db/checkIndexes.js --apply" in the server\'s container (#1295, metrics-and-monitoring.md).';
}

// ── The command ──────────────────────────────────────────────────────────────

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024)).toLocaleString('en-US')} MB`;

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

/** Why the swap is not made now, or null. */
function refusal(db, state, { force, free }) {
  const going = Number(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('QUEUED', 'RUNNING')").get().n);
  if (going > 0 && !force) {
    return `${going} run(s) are queued or running: nothing changed. Wait for them to end. `
      + 'If the server is stopped, those are runs it left marked; add --force.';
  }
  const needed = state.checks * BYTES_NEEDED_PER_CHECK;
  if (free !== null && free < needed && !force) {
    return `the database's disk has ${megabytes(free)} free and the swap needs about ${megabytes(needed)} while it runs: `
      + 'nothing changed. Free some space, or add --force.';
  }
  return null;
}

/**
 * The command. Returns its exit code: 0 done or nothing to do, 1 refused or
 * failed, 2 wrong arguments.
 */
function main(args, { log = console.log, file = process.env.OSCAR_DB_PATH || path.resolve(__dirname, '../../data/oscar.db'), freeOf = freeBytes } = {}) {
  const say = (text) => log(`[check-indexes] ${text}`);
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
    const state = stateOf(db);
    say(`${file}: about ${state.checks.toLocaleString('en-US')} checks; index by check text ${state.keyIndex ? 'present' : 'absent'}, `
      + `index by company ${state.companyIndex ? 'present' : 'absent'}`);
    if (isSwapped(state)) {
      say('nothing to do');
      return 0;
    }
    if (!args.includes('--apply')) {
      say('--apply would remove the index by check text and make the index by company. '
        + 'While it runs, whatever writes to the database waits, then fails: choose a quiet time.');
      return 0;
    }
    const refused = refusal(db, state, { force: args.includes('--force'), free: freeOf(path.dirname(file)) });
    if (refused) {
      say(refused);
      return 1;
    }
    const pagesBefore = Number(db.prepare('PRAGMA page_count').get().page_count);
    swap(db, (what, seconds) => say(`${what}: ${seconds.toFixed(1)} s`));
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const freed = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const grown = Number(db.prepare('PRAGMA page_count').get().page_count) - pagesBefore;
    say(`done. The database file ${grown > 0 ? `grew by ${megabytes(grown * pageSize)}` : 'keeps its size'}; `
      + `${megabytes(freed * pageSize)} of it are free and will hold the next data stored.`);
    return 0;
  } catch (e) {
    say(`failed, nothing changed: ${e.message}`);
    return 1;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  stateOf, isSwapped, swap, swapAtStart, pendingText, main, refusal,
  KEY_INDEX, COMPANY_INDEX, AT_START_MAX_CHECKS, BYTES_NEEDED_PER_CHECK,
};
