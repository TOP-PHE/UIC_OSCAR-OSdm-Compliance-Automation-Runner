// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bootstrap-token.test.js — the first administrator of an installation (#1365).
 *
 * utils/bootstrapToken.js: when an administrator who can sign in exists, when
 * the environment holds a token, and what the server says at its start. The
 * route's side is in tests/integration/auth-routes.test.js; the page's note in
 * ui-scripts.test.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { run } = require('../../src/db/db');
const B = require('../../src/utils/bootstrapToken');

const SRC = path.join(__dirname, '..', '..', 'src');

describe('an administrator who can sign in', () => {
  const companyId = randomUUID();
  const add = (role, status) => run(
    `INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`,
    [randomUUID(), companyId, `${randomUUID()}@bootstrap-token.example`, role, status]);

  beforeAll(() => {
    run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, 'Bootstrap token test', ?, 'bearer')`,
      [companyId, `bootstrap-token-${companyId.slice(0, 8)}`]);
  });
  beforeEach(() => {
    run("DELETE FROM users WHERE company_id = ?", [companyId]);
    run("UPDATE users SET status = 'suspended' WHERE role = 'administrator'");
  });

  test('none: no user, other roles, administrators that are not active', () => {
    expect(B.administratorExists()).toBe(false);
    for (const role of ['test_manager', 'company_user', 'certification_user', 'api_client']) add(role, 'active');
    for (const status of ['pending', 'suspended', 'rejected']) add('administrator', status);
    expect(B.administratorExists()).toBe(false);
  });

  test('one active administrator is enough', () => {
    add('administrator', 'active');
    expect(B.administratorExists()).toBe(true);
  });

  test('the same status the session rule asks: active', () => {
    // sessionUser() (middleware/auth.js) admits a user whose status is active
    // and no other: an administrator counted here is one who can sign in.
    const auth = fs.readFileSync(path.join(SRC, 'api', 'middleware', 'auth.js'), 'utf8');
    expect(auth).toContain("row?.status !== 'active'");
    const own = fs.readFileSync(path.join(SRC, 'utils', 'bootstrapToken.js'), 'utf8');
    expect(own).toContain("role = 'administrator' AND status = 'active'");
  });
});

describe('the token in the environment', () => {
  test('set means text that is not empty', () => {
    expect(B.tokenSet({ PLATFORM_BOOTSTRAP_TOKEN: 'abc' })).toBe(true);
    for (const env of [{}, { PLATFORM_BOOTSTRAP_TOKEN: '' }, { PLATFORM_BOOTSTRAP_TOKEN: undefined }]) {
      expect(B.tokenSet(env)).toBe(false);
    }
  });
});

describe('the start line', () => {
  test('nothing to say without a token', () => {
    expect(B.startLine(false, false)).toBeNull();
    expect(B.startLine(false, true)).toBeNull();
  });

  test('a warning while the token is set and an administrator exists', () => {
    const line = B.startLine(true, true);
    expect(line.level).toBe('warn');
    expect(line.text).toMatch(/still set/);
    expect(line.text).toMatch(/creates no account any more/);
    expect(line.text).toMatch(/Remove the token/);
  });

  test('information on a new installation', () => {
    const line = B.startLine(true, false);
    expect(line.level).toBe('info');
    expect(line.text).toMatch(/creates the first one/);
  });

  test('the server says it once at its start', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    expect(server).toContain('bootstrapToken.startLine(bootstrapToken.tokenSet(), bootstrapToken.administratorExists())');
  });
});

describe('the route', () => {
  // The order matters: the token first (a caller without it learns nothing),
  // then the administrator rule, before anything is read from the body.
  test('looks at the token, then at the administrator, then at the body', () => {
    const auth = fs.readFileSync(path.join(SRC, 'api', 'routes', 'auth.js'), 'utf8');
    const handler = auth.slice(auth.indexOf("router.post('/bootstrap/platform-user'"), auth.indexOf("router.post('/login'"));
    const order = ["detail: 'Invalid bootstrap token.'", 'bootstrapToken.administratorExists()', 'const { email, password, role } = req.body', 'createUser('];
    const places = order.map(text => handler.indexOf(text));
    expect(places.every(p => p > -1)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
  });
});
