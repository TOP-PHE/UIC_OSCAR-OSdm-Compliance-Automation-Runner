// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * provider-access.test.js — the one company-access rule (#540) and the guard
 * that keeps it the only one.
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run } = require('../../src/db/db');
const { canUseCompany, requestedProviderId } = require('../../src/api/helpers/provider-access');
const { enforceTenant } = require('../../src/api/middleware/tenant');

const D = uuidv4(), P = uuidv4(), GRAND = uuidv4(), OTHER = uuidv4(), OTHER_P = uuidv4();
const TM = uuidv4(), T_GRANTED = uuidv4(), T_PLAIN = uuidv4();
const tag = D.slice(0, 8);

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [D, `pa-d-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P', ?, ?)`, [P, `pa-p-${tag}`, D]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'G', ?, ?)`, [GRAND, `pa-g-${tag}`, P]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'O', ?)`, [OTHER, `pa-o-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'OP', ?, ?)`, [OTHER_P, `pa-op-${tag}`, OTHER]);
  for (const [id, role] of [[TM, 'test_manager'], [T_GRANTED, 'company_user'], [T_PLAIN, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, D, `${id}@pa.example`, role]);
  }
  run(`INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)`, [P, T_GRANTED]);
  // A grant on another distributor's provider is inert: the rule also requires
  // the provider to be a child of the member's own company.
  run(`INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)`, [OTHER_P, T_GRANTED]);
});

const tm      = { id: TM, companyId: D, role: 'test_manager' };
const granted = { id: T_GRANTED, companyId: D, role: 'company_user' };
const plain   = { id: T_PLAIN, companyId: D, role: 'company_user' };

describe('canUseCompany', () => {
  test.each([
    ['test manager, own company', tm, () => D, true],
    ['test manager, own provider', tm, () => P, true],
    ['test manager, a provider of a provider', tm, () => GRAND, false],
    ['test manager, another company', tm, () => OTHER, false],
    ['test manager, another distributor\'s provider', tm, () => OTHER_P, false],
    ['granted tester, own company', granted, () => D, true],
    ['granted tester, granted provider', granted, () => P, true],
    ['granted tester, grant on another distributor\'s provider', granted, () => OTHER_P, false],
    ['plain tester, own company', plain, () => D, true],
    ['plain tester, provider', plain, () => P, false],
    ['unknown id', tm, () => uuidv4(), false],
  ])('%s', (_label, user, company, expected) => {
    expect(canUseCompany(user, company())).toBe(expected);
  });

  test('platform roles and unknown roles are never admitted', () => {
    for (const role of ['administrator', 'certification_user', 'auditor', undefined]) {
      expect(canUseCompany({ id: TM, companyId: D, role }, D)).toBe(false);
      expect(canUseCompany({ id: TM, companyId: D, role }, P)).toBe(false);
    }
  });

  test('malformed input is a refusal, not a throw', () => {
    expect(canUseCompany(null, D)).toBe(false);
    expect(canUseCompany(tm, null)).toBe(false);
    expect(canUseCompany(tm, ['x'])).toBe(false);
    expect(canUseCompany(tm, '')).toBe(false);
    expect(canUseCompany({ id: TM, role: 'test_manager' }, P)).toBe(false);   // no own company
  });
});

describe('requestedProviderId', () => {
  const req = (headers = {}, query = {}) => ({ headers, query });
  test.each([
    ['nothing', req(), undefined],
    ['empty header', req({ 'x-provider-id': '' }), undefined],
    ['header', req({ 'x-provider-id': 'a' }), 'a'],
    ['query', req({}, { provider_id: 'a' }), 'a'],
    ['both, same', req({ 'x-provider-id': 'a' }, { provider_id: 'a' }), 'a'],
    ['both, different', req({ 'x-provider-id': 'a' }, { provider_id: 'b' }), null],
    ['repeated query', req({}, { provider_id: ['a', 'a'] }), null],
    ['object query', req({}, { provider_id: { x: 1 } }), null],
  ])('%s', (_label, r, expected) => {
    expect(requestedProviderId(r)).toBe(expected);
  });

  test('the body is never read', () => {
    expect(requestedProviderId({ headers: {}, query: {}, body: { provider_id: P } })).toBeUndefined();
  });
});

describe('enforceTenant', () => {
  function call(user, headers = {}) {
    const req = { user, headers, query: {}, body: {} };
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    enforceTenant(req, res, () => { nexted = true; });
    return { req, res, nexted };
  }

  test('a refused provider answers 404 and does not continue', () => {
    const { res, nexted } = call(plain, { 'x-provider-id': P });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  test('an admitted provider becomes req.companyId', () => {
    const { req, nexted } = call(granted, { 'x-provider-id': P });
    expect(nexted).toBe(true);
    expect(req.companyId).toBe(P);
  });

  test('no provider: the own company', () => {
    const { req, nexted } = call(plain);
    expect(nexted).toBe(true);
    expect(req.companyId).toBe(D);
  });
});

// ── Guard: no second copy of the rule ────────────────────────────────────────
// A route that reads the member's own company straight from the token ignores
// the provider the request names, or decides access on its own. Routes read
// req.companyId (set by enforceTenant). The reads left are listed with the
// reason; a new one fails here until it is either rewritten or listed.
describe('guard — direct reads of the token\'s company', () => {
  const SRC = path.join(__dirname, '../../src');
  const ALLOWED = {
    // The user directory is the distributor's: users never belong to a provider.
    'api/routes/company-users.js': 6,
    // GET /v1/auth/me describes the user's own company.
    'api/routes/auth.js': 1,
    // Providers are children of the caller's own company, by definition.
    'api/routes/company-providers.js': 5,
    // The rule itself, and its middleware.
    'api/helpers/provider-access.js': 4,
    'api/middleware/tenant.js': 3,
  };

  function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  }

  test('every read is on the allow-list, with its count', () => {
    const found = {};
    for (const f of files(SRC)) {
      const n = (fs.readFileSync(f, 'utf8').match(/\buser\??\.companyId\b/g) || []).length;
      if (n) found[path.relative(SRC, f).split(path.sep).join('/')] = n;
    }
    expect(found).toEqual(ALLOWED);
  });
});
