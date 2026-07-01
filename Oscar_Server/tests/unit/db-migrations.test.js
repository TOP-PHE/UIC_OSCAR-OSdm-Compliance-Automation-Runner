// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * db-migrations.test.js — SQL migration SMOKE TEST (regression guard for #208).
 *
 * The #208 prod outage came from a column (`cached_token_cred_fp`) whose
 * `ALTER TABLE` was added to an ALREADY-APPLIED migration, so it never ran on
 * existing DBs → resolveAccessToken's UPDATE threw "no such column" and failed
 * every OAuth run. The existing unit test mocks the DB, so it could not catch it.
 *
 * These tests run the REAL migration path (schema.sql + the versioned migrations
 * in db.js) against throwaway temp databases and assert:
 *   1. fresh install — all migrations apply cleanly and produce every column the
 *      runtime depends on (the "schema contract");
 *   2. upgrade — a DB that is already at a high schema_version but MISSING a
 *      required column gets it back from a NEW migration (the exact #208 class).
 *
 * db.js opens its DB from OSCAR_DB_PATH at require-time and runs schema + all
 * migrations as a side effect, so each test points it at a fresh temp file via
 * jest.isolateModules().
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = path.resolve(__dirname, '../../src/db/schema.sql');

// Columns the runtime code reads/writes — extend this when code starts depending
// on a new column. `cached_token_cred_fp` is the #208 regression guard.
const REQUIRED_COLUMNS = {
  users: [
    'id', 'email', 'company_id', 'role',
    'auth_mode', 'access_token_enc', 'client_id_enc', 'client_secret_enc',
    'token_url', 'oauth_profile', 'oauth_scope', 'oauth_extra_enc', 'oauth_custom_template',
    'cached_token_enc', 'cached_token_expires_at', 'cached_token_cred_fp',
    'requestor_enc', 'subscription_key_enc',
  ],
  finding: [
    'id', 'company_id', 'title', 'step', 'scenario_code', 'expected_status',
    'observed', 'interpretation', 'category', 'severity', 'status',
    'baseline_in_run', 'raise_to_osdm', 'evidence', 'created_by',
  ],
};

let _tmpFiles = [];
function tempDbPath() {
  const f = path.join(os.tmpdir(), `oscar-mig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  _tmpFiles.push(f);
  return f;
}
afterAll(() => {
  for (const f of _tmpFiles) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.rmSync(f + suffix, { force: true }); } catch (_e) { /* best-effort */ }
    }
  }
});

// Open a throwaway read connection and return the column names of a table.
function columnsOf(dbFile, table) {
  const d = new DatabaseSync(dbFile);
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } finally {
    d.close();
  }
}

// Require db.js fresh against `dbFile` — this runs schema.sql + all migrations.
function bootDbAgainst(dbFile) {
  jest.isolateModules(() => {
    process.env.OSCAR_DB_PATH = dbFile;
    require('../../src/db/db');
  });
}

describe('DB migrations — fresh install', () => {
  test('all migrations apply cleanly and produce the required schema contract', () => {
    const dbFile = tempDbPath();
    expect(() => bootDbAgainst(dbFile)).not.toThrow();

    // schema_version is the migration ledger — must exist after boot.
    expect(columnsOf(dbFile, 'schema_version')).toContain('version');

    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      const have = columnsOf(dbFile, table);
      const missing = cols.filter((c) => !have.includes(c));
      expect(missing).toEqual([]); // names the missing columns if it fails
    }
  });
});

describe('DB migrations — upgrade from an existing DB (the #208 regression class)', () => {
  test('a required column missing on an already-versioned DB is restored by a migration', () => {
    const dbFile = tempDbPath();

    // ── Simulate a deployed DB that ran the OLD migrations: seed the schema,
    //    DROP the column, and mark the DB as already at a high version so the
    //    column can ONLY come back from a *new* migration (version > 19) — never
    //    from re-running an already-applied one. This is exactly the #208 state.
    {
      const d = new DatabaseSync(dbFile);
      d.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
      try { d.exec('ALTER TABLE users DROP COLUMN cached_token_cred_fp'); } catch (_e) { /* already absent */ }
      d.exec('DELETE FROM schema_version WHERE version >= 20');
      d.exec("INSERT OR IGNORE INTO schema_version (version) VALUES (19)");
      d.close();
    }
    // Pre-condition: the column is genuinely gone.
    expect(columnsOf(dbFile, 'users')).not.toContain('cached_token_cred_fp');

    // ── Boot db.js → migrations with version > 19 must run and restore it.
    bootDbAgainst(dbFile);

    // Regression guard: the column is present again. Fails loudly if a required
    // column is ever buried in an already-applied migration instead of a new one.
    expect(columnsOf(dbFile, 'users')).toContain('cached_token_cred_fp');
  });

  // #447 — finding.scenario_code (migration 22). Same shape as the #208 guard
  // above: simulate a DB that already ran migrations up to 21 (the finding
  // table exists, without scenario_code) and confirm ONLY the new migration
  // brings the column back — never a re-run of an already-applied one.
  test('finding.scenario_code (added in migration 22) is restored on an already-versioned DB', () => {
    const dbFile = tempDbPath();
    {
      const d = new DatabaseSync(dbFile);
      d.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
      try { d.exec('ALTER TABLE finding DROP COLUMN scenario_code'); } catch (_e) { /* already absent */ }
      d.exec('DELETE FROM schema_version WHERE version >= 22');
      d.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (21)');
      d.close();
    }
    expect(columnsOf(dbFile, 'finding')).not.toContain('scenario_code');

    bootDbAgainst(dbFile);

    expect(columnsOf(dbFile, 'finding')).toContain('scenario_code');
  });
});
