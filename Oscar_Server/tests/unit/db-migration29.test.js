// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: migration 29 on an upgraded database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-mig-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
let n = 0;

// Boot the real db.js on `file`.
function boot(file) {
  const prev = process.env.OSCAR_DB_PATH;
  process.env.OSCAR_DB_PATH = file;
  let err = null;
  jest.isolateModules(() => {
    try { require('../../src/db/db'); } catch (e) { err = e; }
  });
  process.env.OSCAR_DB_PATH = prev;
  return err;
}

// A fresh DB, then rewound to "version 28, no tester_credentials" with users.
function v28Db({ orphan = false } = {}) {
  const file = path.join(DIR, `m${n++}.db`);
  expect(boot(file)).toBeNull();
  const d = new DatabaseSync(file);
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('DROP TABLE tester_credentials');
  d.exec('DELETE FROM schema_version WHERE version >= 29');
  d.exec(`INSERT INTO companies (id, name, slug) VALUES ('c1', 'C1', 'c1')`);
  d.exec(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc)
          VALUES ('u1', 'c1', 'u1@x', 'x', 'company_user', 'bearer', 'enc:v1:tok')`);
  if (orphan) {
    d.exec(`INSERT INTO users (id, company_id, email, password_hash) VALUES ('u2', 'gone', 'u2@x', 'x')`);
  }
  d.close();
  return file;
}

test('upgrade copies, and a forced re-run is idempotent', () => {
  const file = v28Db();
  expect(boot(file)).toBeNull();
  const d = new DatabaseSync(file);
  d.exec('DELETE FROM schema_version WHERE version >= 29');   // run 29 again
  d.close();
  expect(boot(file)).toBeNull();
  const d2 = new DatabaseSync(file);
  const rows = d2.prepare('SELECT user_id, company_id, access_token_enc FROM tester_credentials').all();
  d2.close();
  expect(rows).toEqual([{ user_id: 'u1', company_id: 'c1', access_token_enc: 'enc:v1:tok' }]);
});

test('a user whose company no longer exists is skipped, and the server still starts', () => {
  const file = v28Db({ orphan: true });
  expect(boot(file)).toBeNull();
  const d = new DatabaseSync(file);
  const rows = d.prepare('SELECT user_id FROM tester_credentials ORDER BY user_id').all();
  d.close();
  expect(rows).toEqual([{ user_id: 'u1' }]);
});
