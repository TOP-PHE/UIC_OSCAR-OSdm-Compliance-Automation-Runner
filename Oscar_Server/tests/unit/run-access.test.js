// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-access.test.js — unit tests for canUserSeeRun() (issue #60, v1.10.0)
 *
 * canUserSeeRun is the single point of truth for "is this user allowed to
 * see this run". A regression here is a security incident, so the test
 * matrix exercises every role × every visibility-relevant run state.
 *
 * Test setup uses the real test SQLite via the shared db helper — the
 * fastest way to seed runs/companies/users without mocking out node:sqlite.
 */

const { run: dbRun } = require('../../src/db/db');
const { canUserSeeRun } = require('../../src/api/helpers/run-access');

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const COMPANY_PLATFORM = 'pppppppp-pppp-pppp-pppp-pppppppppppp';

const USER_A_TESTER = 'a1111111-1111-1111-1111-111111111111';
const USER_A_TM     = 'a2222222-2222-2222-2222-222222222222';
const USER_B_TESTER = 'b1111111-1111-1111-1111-111111111111';
const USER_PLAT_ADM = 'p1111111-1111-1111-1111-111111111111';
const USER_PLAT_CRT = 'p2222222-2222-2222-2222-222222222222';

const RUN_A_OPEN_NOT_SHARED  = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const RUN_A_TERM_NOT_SHARED  = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const RUN_A_TERM_SHARED      = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const RUN_A_TERM_SHARED_KILL = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';
const RUN_A_DELETED          = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';
const RUN_B_TERM_SHARED      = 'bbbbbbbb-cccc-dddd-eeee-111111111111';

beforeAll(() => {
  // Companies
  dbRun(`INSERT OR REPLACE INTO companies (id, name, slug, share_reports_with_certifier) VALUES (?, ?, ?, ?)`,
        [COMPANY_A, 'Acme Rail', 'acme-rail', 1]);
  dbRun(`INSERT OR REPLACE INTO companies (id, name, slug, share_reports_with_certifier) VALUES (?, ?, ?, ?)`,
        [COMPANY_B, 'BetaRail', 'beta-rail', 0]);  // master kill flipped
  dbRun(`INSERT OR REPLACE INTO companies (id, name, slug, share_reports_with_certifier) VALUES (?, ?, ?, ?)`,
        [COMPANY_PLATFORM, 'Platform', 'platform', 1]);

  // Users (pwhash dummy; canUserSeeRun never reads it)
  const dummy = '$2b$12$abcdefghijklmnopqrstuv';
  dbRun(`INSERT OR REPLACE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
        [USER_A_TESTER, COMPANY_A, 'tester-a@acme', dummy, 'company_user']);
  dbRun(`INSERT OR REPLACE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
        [USER_A_TM,     COMPANY_A, 'tm-a@acme',     dummy, 'test_manager']);
  dbRun(`INSERT OR REPLACE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
        [USER_B_TESTER, COMPANY_B, 'tester-b@beta', dummy, 'company_user']);
  dbRun(`INSERT OR REPLACE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
        [USER_PLAT_ADM, COMPANY_PLATFORM, 'admin@uic',     dummy, 'administrator']);
  dbRun(`INSERT OR REPLACE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
        [USER_PLAT_CRT, COMPANY_PLATFORM, 'certifier@uic', dummy, 'certification_user']);

  // Runs — covering every visibility-relevant combination
  // 1. RUNNING run, not shared with certifier
  dbRun(`INSERT OR REPLACE INTO runs (id, company_id, user_id, status, shared_with_certifier_at) VALUES (?, ?, ?, ?, ?)`,
        [RUN_A_OPEN_NOT_SHARED,  COMPANY_A, USER_A_TESTER, 'RUNNING',   null]);
  // 2. COMPLETED, not shared
  dbRun(`INSERT OR REPLACE INTO runs (id, company_id, user_id, status, shared_with_certifier_at) VALUES (?, ?, ?, ?, ?)`,
        [RUN_A_TERM_NOT_SHARED,  COMPANY_A, USER_A_TESTER, 'COMPLETED', null]);
  // 3. COMPLETED, shared with certifier
  dbRun(`INSERT OR REPLACE INTO runs (id, company_id, user_id, status, shared_with_certifier_at, shared_with_certifier_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [RUN_A_TERM_SHARED,      COMPANY_A, USER_A_TESTER, 'COMPLETED', '2026-05-15T10:00:00Z', 'tm-a@acme']);
  // 4. COMPLETED + per-run shared, but company B has master kill switch flipped
  dbRun(`INSERT OR REPLACE INTO runs (id, company_id, user_id, status, shared_with_certifier_at, shared_with_certifier_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [RUN_A_TERM_SHARED_KILL, COMPANY_B, USER_B_TESTER, 'COMPLETED', '2026-05-15T10:00:00Z', 'tm-b@beta']);
  // 5. DELETED — never visible to anyone
  dbRun(`INSERT OR REPLACE INTO runs (id, company_id, user_id, status, shared_with_certifier_at) VALUES (?, ?, ?, ?, ?)`,
        [RUN_A_DELETED,          COMPANY_A, USER_A_TESTER, 'DELETED',   '2026-05-15T10:00:00Z']);
});

const ANONYMOUS = null;

describe('canUserSeeRun — null safety', () => {
  test('null user → null', () => expect(canUserSeeRun(RUN_A_TERM_SHARED, ANONYMOUS)).toBeNull());
  test('null runId → null', () => expect(canUserSeeRun(null, { role: 'test_manager', companyId: COMPANY_A })).toBeNull());
  test('non-existent run → null', () =>
    expect(canUserSeeRun('99999999-9999-9999-9999-999999999999', { role: 'test_manager', companyId: COMPANY_A })).toBeNull());
  test('DELETED run → null even for the owner', () =>
    expect(canUserSeeRun(RUN_A_DELETED, { role: 'company_user', companyId: COMPANY_A })).toBeNull());
});

describe('canUserSeeRun — administrator (issue #60 strict mode)', () => {
  const admin = { role: 'administrator', companyId: COMPANY_PLATFORM };

  test('cannot see RUNNING run', () => expect(canUserSeeRun(RUN_A_OPEN_NOT_SHARED, admin)).toBeNull());
  test('cannot see COMPLETED unshared run', () => expect(canUserSeeRun(RUN_A_TERM_NOT_SHARED, admin)).toBeNull());
  test('cannot see COMPLETED shared run', () => expect(canUserSeeRun(RUN_A_TERM_SHARED, admin)).toBeNull());
  test('cannot see ANY run regardless of company / state / share', () => {
    expect(canUserSeeRun(RUN_B_TERM_SHARED,      admin)).toBeNull();
    expect(canUserSeeRun(RUN_A_TERM_SHARED_KILL, admin)).toBeNull();
  });
});

describe('canUserSeeRun — tester (company_user)', () => {
  const testerA = { role: 'company_user', companyId: COMPANY_A };
  const testerB = { role: 'company_user', companyId: COMPANY_B };

  test('sees own company RUNNING run', () =>
    expect(canUserSeeRun(RUN_A_OPEN_NOT_SHARED, testerA)).not.toBeNull());
  test('sees own company COMPLETED run regardless of share state', () => {
    expect(canUserSeeRun(RUN_A_TERM_NOT_SHARED, testerA)).not.toBeNull();
    expect(canUserSeeRun(RUN_A_TERM_SHARED,     testerA)).not.toBeNull();
  });
  test('cannot see another company\'s run', () =>
    expect(canUserSeeRun(RUN_A_TERM_SHARED, testerB)).toBeNull());
});

describe('canUserSeeRun — test_manager', () => {
  const tmA = { role: 'test_manager', companyId: COMPANY_A };

  test('sees own company runs (regardless of share state)', () => {
    expect(canUserSeeRun(RUN_A_OPEN_NOT_SHARED, tmA)).not.toBeNull();
    expect(canUserSeeRun(RUN_A_TERM_NOT_SHARED, tmA)).not.toBeNull();
    expect(canUserSeeRun(RUN_A_TERM_SHARED,     tmA)).not.toBeNull();
  });
  test('cannot see another company\'s run', () =>
    expect(canUserSeeRun(RUN_A_TERM_SHARED_KILL, tmA)).toBeNull());
});

describe('canUserSeeRun — certifier (per-run share + master kill)', () => {
  const cert = { role: 'certification_user', companyId: COMPANY_PLATFORM };

  test('cannot see RUNNING run (never shared)', () =>
    expect(canUserSeeRun(RUN_A_OPEN_NOT_SHARED, cert)).toBeNull());
  test('cannot see COMPLETED run that was not shared', () =>
    expect(canUserSeeRun(RUN_A_TERM_NOT_SHARED, cert)).toBeNull());
  test('CAN see COMPLETED run that was explicitly shared', () => {
    const r = canUserSeeRun(RUN_A_TERM_SHARED, cert);
    expect(r).not.toBeNull();
    expect(r.id).toBe(RUN_A_TERM_SHARED);
  });
  test('cannot see shared run when company master kill switch is off', () =>
    // Company B has share_reports_with_certifier=0; per-run share is
    // overridden by the master kill switch.
    expect(canUserSeeRun(RUN_A_TERM_SHARED_KILL, cert)).toBeNull());
});

describe('canUserSeeRun — unknown role fails closed', () => {
  test('unknown role → null', () =>
    expect(canUserSeeRun(RUN_A_TERM_SHARED, { role: 'gardener', companyId: COMPANY_A })).toBeNull());
  test('missing role → null', () =>
    expect(canUserSeeRun(RUN_A_TERM_SHARED, { companyId: COMPANY_A })).toBeNull());
});
