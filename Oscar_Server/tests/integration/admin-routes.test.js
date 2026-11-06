// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-routes.test.js — Integration tests for /v1/admin/*
 *
 * NOTE: Requires Node.js 22+ (node:sqlite) for the database layer.
 *
 * Covers:
 *   - Auth protection (401 without token, 403 for non-admin)
 *   - GET /v1/admin/users  — list and search
 *   - POST /v1/admin/users — create user with validation
 *   - PATCH /v1/admin/users/:id — update user
 *   - POST /v1/admin/users/:id/reset-password
 *   - DELETE /v1/admin/users/:id
 *   - GET /v1/admin/activity
 *   - GET /v1/admin/companies — list companies
 *   - POST /v1/admin/companies — create company
 *   - PATCH /v1/admin/companies/:id — update company
 *   - DELETE /v1/admin/companies/:id — delete company
 *   - POST /v1/admin/users/:id/approve — activate a pending self-registered user
 *   - POST /v1/admin/users/:id/generate-reset-link — issue an out-of-band reset link
 *   - GET /v1/admin/config — read server config schema + values
 *   - PATCH /v1/admin/config — update server config (validation + warnings)
 *   - POST /v1/admin/alertmanager/apply — regenerate + reload alertmanager.yml
 *   - POST /v1/admin/test-email — SMTP diagnostic send
 *   - POST /v1/admin/rotate-jwt-secret — rotate the persisted JWT secret (run LAST — mutates process.env.JWT_SECRET)
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-admin-routes';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, all } = require('../../src/db/db');
const { ensurePlatformCompany } = require('../../src/api/helpers/shared');

// The admin router limits writes to 60 per 5 minutes per address, and this
// file makes more than that. Each test speaks from an address of its own
// (X-Forwarded-For from loopback), so one test's writes never use up the
// next one's; the limiter itself is not what this file tests.
const express = require('express');
const app = express();
app.set('trust proxy', 'loopback');
let clientAddress = '10.0.0.1';
let clientCount = 0;
app.use((req, _res, next) => { req.headers['x-forwarded-for'] = clientAddress; next(); });
app.use(buildAppWithRoute('/v1/admin', '../../src/api/routes/admin'));
beforeEach(() => {
  clientCount += 1;
  clientAddress = `10.0.${Math.floor(clientCount / 250)}.${(clientCount % 250) + 1}`;
});

// ── Test fixtures ─────────────────────────────────────────────────────────────

const adminId   = uuidv4();
const companyId = uuidv4();
// A token stands for a real user of its role (sessionUser): one row per role.
const roleUserIds = { administrator: adminId, company_user: uuidv4(), certification_user: uuidv4(), test_manager: uuidv4() };

function makeToken(role, uid = roleUserIds[role]) {
  return jwt.sign(
    { sub: uid, email: `${role}@admin-test.com`, companyId, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Admin Test Co', 'admin-test-co')`, [companyId]);
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'admin@admin-test.com', '$2b$12$fakehash', 'administrator')`,
    [adminId, companyId]
  );
  for (const role of ['company_user', 'certification_user', 'test_manager']) {
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, ?, '$2b$12$fakehash', ?)`,
      [roleUserIds[role], companyId, `${role}@admin-test.com`, role]
    );
  }
});

afterAll(() => {
  // Delete auth_events by both company_id AND user_id so we capture rows
  // that were logged with company_id = NULL (e.g. user_updated / password_reset
  // audit events that pass null for company_id).  Leaving those rows would
  // cause the subsequent DELETE FROM users to fail the FK constraint
  // (auth_events.user_id REFERENCES users(id), PRAGMA foreign_keys = ON).
  run('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  run(`DELETE FROM auth_events WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)`, [companyId]);
  run('DELETE FROM users WHERE company_id = ?', [companyId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
  // Clean up any extra companies created during tests
  run("DELETE FROM companies WHERE slug LIKE 'new-test-co%'");
  run("DELETE FROM companies WHERE slug LIKE 'admin-tmp-%'");
});

// ── Auth protection ───────────────────────────────────────────────────────────

describe('GET /v1/admin/users — auth', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/v1/admin/users');
    expect(res.status).toBe(401);
  });

  test('403 for company_user', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('403 for certification_user', async () => {
    const token = makeToken('certification_user');
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ── GET /v1/admin/users ───────────────────────────────────────────────────────

describe('GET /v1/admin/users', () => {
  test('200 returns users array for administrator', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  test('users include id, email, role, company_id, company_name fields', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    const user = res.body.users.find(u => u.id === adminId);
    expect(user).toBeTruthy();
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('email');
    expect(user).toHaveProperty('role');
    expect(user).toHaveProperty('company_id');
    expect(user).toHaveProperty('company_name');
    expect(user.role).toBe('administrator');
  });

  test('?q= filters by email', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/users?q=admin-test.com')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    res.body.users.forEach(u => expect(u.email).toContain('admin-test.com'));
  });

  test('?q= with no matches returns empty array', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/users?q=nobody-exists-here-xyz123')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(0);
  });
});

// ── POST /v1/admin/users ──────────────────────────────────────────────────────

describe('POST /v1/admin/users', () => {
  const adminToken = () => makeToken('administrator');

  test('400 when email missing', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ password: 'ValidPass1!', role: 'company_user', company_id: companyId });
    expect(res.status).toBe(400);
  });

  test('400 when password too short', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: 'short@admin-test.com', password: 'Short1!', role: 'company_user', company_id: companyId });
    expect(res.status).toBe(400);
  });

  test('400 when password lacks uppercase', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: 'noupper@admin-test.com', password: 'all_lowercase_1!', role: 'company_user', company_id: companyId });
    expect(res.status).toBe(400);
  });

  test('400 when role is invalid', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: 'role@admin-test.com', password: 'ValidPass1!', role: 'superuser' });
    expect(res.status).toBe(400);
  });

  test('400 when company_user has no company_id', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: `nocompany${Date.now()}@admin-test.com`, role: 'company_user' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/company_id/i);
  });

  // Nobody chooses another person's password: a password in the body is refused.
  test('400 when a password is sent, and nothing is created', async () => {
    const email = `withpassword${Date.now()}@admin-test.com`;
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email, password: 'ValidPass1!Valid', role: 'administrator' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/password/i);
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
  });

  // A company with a Test Manager: the person is placed there as an access
  // request its Test Manager confirms; no account is made by the administrator.
  test('202 places a company_user in a company that has a Test Manager (no user created)', async () => {
    const email = `newuser${Date.now()}@admin-test.com`;
    try {
      const res = await request(app)
        .post('/v1/admin/users')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email, role: 'company_user', company_id: companyId });
      expect(res.status).toBe(202);
      expect(res.body.placed).toBe(true);
      expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
      const placed = get('SELECT state, company_id FROM access_request WHERE email = ?', [email]);
      expect(placed).toEqual({ state: 'assigned', company_id: companyId });
    } finally {
      run('DELETE FROM access_request WHERE email = ?', [email]);
    }
  });

  test('404 when the target company does not exist', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: `nocompanyrow${Date.now()}@admin-test.com`, role: 'company_user', company_id: uuidv4() });
    expect(res.status).toBe(404);
  });

  describe('a company with no active Test Manager', () => {
    let newCoId;
    let usedCoId;
    beforeAll(() => {
      newCoId = uuidv4();
      usedCoId = uuidv4();
      run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Admin Tmp New', ?)`, [newCoId, `admin-tmp-new-${newCoId.slice(0, 8)}`]);
      run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Admin Tmp Used', ?)`, [usedCoId, `admin-tmp-used-${usedCoId.slice(0, 8)}`]);
      // Not new: it has a user (a tester), but no Test Manager.
      run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
        [uuidv4(), usedCoId, `used-co-tester-${usedCoId.slice(0, 8)}@admin-test.com`]);
    });
    afterAll(() => {
      for (const id of [newCoId, usedCoId]) {
        run('DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', [id]);
        run('DELETE FROM auth_events WHERE company_id = ? OR user_id IN (SELECT id FROM users WHERE company_id = ?)', [id, id]);
        run('DELETE FROM users WHERE company_id = ?', [id]);
        run('DELETE FROM companies WHERE id = ?', [id]);
      }
    });

    test('409 for a company_user: only a first Test Manager is brought in by the administrator', async () => {
      const email = `firsttester${Date.now()}@admin-test.com`;
      const res = await request(app)
        .post('/v1/admin/users')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email, role: 'company_user', company_id: newCoId });
      expect(res.status).toBe(409);
      expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
    });

    test('409 for a test_manager when the company is not new', async () => {
      const email = `usedtm${Date.now()}@admin-test.com`;
      const res = await request(app)
        .post('/v1/admin/users')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email, role: 'test_manager', company_id: usedCoId });
      expect(res.status).toBe(409);
      expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
    });

    test('201 invites the first Test Manager of a new company, with no usable password and a reset link', async () => {
      const email = `firsttm${Date.now()}@admin-test.com`;
      const res = await request(app)
        .post('/v1/admin/users')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email, role: 'test_manager', company_id: newCoId });
      expect(res.status).toBe(201);
      expect(res.body.invited).toBe(true);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.role).toBe('test_manager');
      expect(res.body.user.company_id).toBe(newCoId);
      expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [res.body.user.id]).n).toBe(1);
    });
  });

  test('409 for duplicate email', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: 'admin@admin-test.com', role: 'administrator' });
    expect(res.status).toBe(409);
  });

  test('invites an administrator on the platform company (no company_id needed)', async () => {
    const email = `newadmin${Date.now()}@admin-test.com`;
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email, role: 'administrator' });
    try {
      expect(res.status).toBe(201);
      expect(res.body.invited).toBe(true);
      expect(res.body.user.role).toBe('administrator');
      expect(res.body.user.company_slug).toBe('platform-root');
      expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [res.body.user.id]).n).toBe(1);
    } finally {
      // Clean up
      run('DELETE FROM password_reset_tokens WHERE user_id = ?', [res.body.user?.id]);
      run('DELETE FROM auth_events WHERE user_id = ?', [res.body.user?.id]);
      run('DELETE FROM users WHERE id = ?', [res.body.user?.id]);
    }
  });

  test('a certifier is invited on the platform company whatever company_id says', async () => {
    const email = `newcert${Date.now()}@admin-test.com`;
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email, role: 'certification_user', company_id: companyId });
    try {
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('certification_user');
      expect(res.body.user.company_slug).toBe('platform-root');
    } finally {
      run('DELETE FROM password_reset_tokens WHERE user_id = ?', [res.body.user?.id]);
      run('DELETE FROM users WHERE id = ?', [res.body.user?.id]);
    }
  });
});

// ── PATCH /v1/admin/users/:id ─────────────────────────────────────────────────

describe('PATCH /v1/admin/users/:id', () => {
  let targetUserId;

  beforeAll(() => {
    targetUserId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'patch-target@admin-test.com', 'x', 'company_user')`,
      [targetUserId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM users WHERE id = ?', [targetUserId]);
  });

  test('400 when no update fields provided', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/users/${targetUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/no update/i);
  });

  test('404 for non-existent user id', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/users/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@admin-test.com' });
    expect(res.status).toBe(404);
  });

  // A company account's e-mail is its owner's way in to its password.
  test('409 when changing a company account\'s email, and the email is kept', async () => {
    const token = makeToken('administrator');
    const newEmail = `patched${Date.now()}@admin-test.com`;
    const res = await request(app)
      .patch(`/v1/admin/users/${targetUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: newEmail });
    expect(res.status).toBe(409);
    expect(get('SELECT email FROM users WHERE id = ?', [targetUserId]).email).toBe('patch-target@admin-test.com');
  });

  test('200 updates a platform account\'s email', async () => {
    const certId = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'certification_user')`,
      [certId, companyId, `patch-cert-${certId.slice(0, 8)}@admin-test.com`]);
    try {
      const newEmail = `patched-cert${Date.now()}@admin-test.com`;
      const res = await request(app)
        .patch(`/v1/admin/users/${certId}`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .send({ email: newEmail });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(newEmail);
    } finally {
      run('DELETE FROM users WHERE id = ?', [certId]);
    }
  });

  // The company has an active Test Manager: they name its Test Managers.
  test('409 promoting a tester to Test Manager where the company has an active Test Manager', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/users/${targetUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'test_manager' });
    expect(res.status).toBe(409);
    expect(get('SELECT role FROM users WHERE id = ?', [targetUserId]).role).toBe('company_user');
  });

  // ── issue #128: role change must not move a user off their company ──────────
  test('Tester → Test Manager (no company_id) keeps the current company, where the company has no Test Manager', async () => {
    const noTmCo = uuidv4();
    const testerId = uuidv4();
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Admin Tmp No TM', ?)`, [noTmCo, `admin-tmp-notm-${noTmCo.slice(0, 8)}`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
      [testerId, noTmCo, `promote-${testerId.slice(0, 8)}@admin-test.com`]);
    try {
      const res = await request(app)
        .patch(`/v1/admin/users/${testerId}`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .send({ role: 'test_manager' }); // no company_id → must keep current company
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('test_manager');
      expect(res.body.user.company_id).toBe(noTmCo); // NOT reassigned to the platform company
    } finally {
      run('DELETE FROM users WHERE id = ?', [testerId]);
      run('DELETE FROM companies WHERE id = ?', [noTmCo]);
    }
  });

  // Someone joins a company through its Test Manager: no move by the administrator.
  test('409 moving a company account to another company via company_id, and it stays where it is', async () => {
    const token = makeToken('administrator');
    const otherCompanyId = uuidv4();
    run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Other Co 128', 'other-co-128')`, [otherCompanyId]);
    try {
      const res = await request(app)
        .patch(`/v1/admin/users/${targetUserId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'test_manager', company_id: otherCompanyId });
      expect(res.status).toBe(409);
      const row = get('SELECT company_id, role FROM users WHERE id = ?', [targetUserId]);
      expect(row).toEqual({ company_id: companyId, role: 'company_user' });
    } finally {
      run('DELETE FROM companies WHERE id = ?', [otherCompanyId]);
    }
  });

  test('409 moving a platform account into a company role', async () => {
    const certId = uuidv4();
    const platform = ensurePlatformCompany();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'certification_user')`,
      [certId, platform.id, `move-cert-${certId.slice(0, 8)}@admin-test.com`]);
    try {
      const res = await request(app)
        .patch(`/v1/admin/users/${certId}`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .send({ role: 'company_user', company_id: companyId });
      expect(res.status).toBe(409);
      expect(get('SELECT role, company_id FROM users WHERE id = ?', [certId])).toEqual({ role: 'certification_user', company_id: platform.id });
    } finally {
      run('DELETE FROM users WHERE id = ?', [certId]);
    }
  });

  test('a Test Manager can still be demoted to tester, in the same company', async () => {
    const tmId = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
      [tmId, companyId, `demote-${tmId.slice(0, 8)}@admin-test.com`]);
    try {
      const res = await request(app)
        .patch(`/v1/admin/users/${tmId}`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .send({ role: 'company_user' });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('company_user');
      expect(res.body.user.company_id).toBe(companyId);
    } finally {
      run('DELETE FROM users WHERE id = ?', [tmId]);
    }
  });

  test('a company account made certifier goes to the platform company (company_id ignored)', async () => {
    const userId = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
      [userId, companyId, `tocert-${userId.slice(0, 8)}@admin-test.com`]);
    try {
      const res = await request(app)
        .patch(`/v1/admin/users/${userId}`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .send({ role: 'certification_user', company_id: companyId });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('certification_user');
      expect(res.body.user.company_slug).toBe('platform-root');
    } finally {
      run('DELETE FROM users WHERE id = ?', [userId]);
    }
  });
});

// ── POST /v1/admin/users/:id/reset-password ───────────────────────────────────

describe('POST /v1/admin/users/:id/reset-password', () => {
  // A platform account (certifier) here: a company account's password is its owner's.
  let resetTargetId;
  let companyResetTargetId;

  beforeAll(() => {
    resetTargetId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'reset-target@admin-test.com', 'x', 'certification_user')`,
      [resetTargetId, companyId]
    );
    companyResetTargetId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'reset-target-company@admin-test.com', 'x', 'company_user')`,
      [companyResetTargetId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM users WHERE id IN (?, ?)', [resetTargetId, companyResetTargetId]);
  });

  test('400 when new_password is missing', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${resetTargetId}/reset-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 when new_password too short', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${resetTargetId}/reset-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ new_password: 'Short1' });
    expect(res.status).toBe(400);
  });

  test('400 when new_password lacks uppercase', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${resetTargetId}/reset-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ new_password: 'all_lowercase_12345' });
    expect(res.status).toBe(400);
  });

  test('200 resets password with valid new_password', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${resetTargetId}/reset-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ new_password: 'ValidNewPass1!' });
    expect(res.status).toBe(200);
    expect(res.body.password_reset).toBe(true);
    expect(res.body.id).toBe(resetTargetId);
  });

  test('403 for a company account, and its password is unchanged', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${companyResetTargetId}/reset-password`)
      .set('Authorization', `Bearer ${makeToken('administrator')}`)
      .send({ new_password: 'ValidNewPass1!' });
    expect(res.status).toBe(403);
    expect(get('SELECT password_hash FROM users WHERE id = ?', [companyResetTargetId]).password_hash).toBe('x');
  });

  test('404 for non-existent user', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${uuidv4()}/reset-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ new_password: 'ValidNewPass1!' });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /v1/admin/users/:id ────────────────────────────────────────────────

describe('DELETE /v1/admin/users/:id', () => {
  let deleteTargetId;

  beforeEach(() => {
    deleteTargetId = uuidv4();
    // Use a unique email per test iteration — if the email were hardcoded the
    // UNIQUE constraint would cause INSERT OR IGNORE to silently skip the 2nd+
    // inserts, leaving subsequent deleteTargetId values with no matching row.
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'delete-target-' || ? || '@admin-test.com', 'x', 'company_user')`,
      [deleteTargetId, companyId, deleteTargetId]
    );
  });

  test('400 when admin tries to delete own account', async () => {
    const token = makeToken('administrator', adminId);
    const res = await request(app)
      .delete(`/v1/admin/users/${adminId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/own account/i);
  });

  test('404 for non-existent user', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .delete(`/v1/admin/users/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 deletes the user', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .delete(`/v1/admin/users/${deleteTargetId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.id).toBe(deleteTargetId);
    // Verify it's gone
    const deleted = get('SELECT id FROM users WHERE id = ?', [deleteTargetId]);
    expect(deleted).toBeUndefined();
  });
});

// ── GET /v1/admin/activity ─────────────────────────────────────────────────────

describe('GET /v1/admin/activity', () => {
  test('200 returns structured activity metrics', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/activity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeTruthy();
    expect(typeof res.body.totals.users).toBe('number');
    expect(typeof res.body.totals.companies).toBe('number');
    expect(typeof res.body.totals.runs).toBe('number');
    expect(typeof res.body.runs_last_24h).toBe('number');
    expect(typeof res.body.logins_last_24h).toBe('number');
    expect(Array.isArray(res.body.run_status_distribution)).toBe(true);
    expect(Array.isArray(res.body.top_submitters_last_7d)).toBe(true);
    expect(Array.isArray(res.body.latest_auth_events)).toBe(true);
  });

  test('runs in progress: one row per user and company or provider, counts only (#1017)', async () => {
    const providerId = uuidv4();
    run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Admin Test Provider', ?, ?)`, [providerId, `admin-tmp-${providerId.slice(0, 8)}`, companyId]);
    const runIds = [];
    const addRun = (cid, status) => {
      const id = uuidv4();
      runIds.push(id);
      run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at) VALUES (?, ?, ?, ?, 'X', datetime('now'))`, [id, cid, adminId, status]);
    };
    addRun(providerId, 'RUNNING');
    addRun(providerId, 'RUNNING');
    addRun(providerId, 'QUEUED');
    addRun(companyId, 'QUEUED');
    addRun(companyId, 'COMPLETED');
    try {
      const res = await request(app)
        .get('/v1/admin/activity')
        .set('Authorization', `Bearer ${makeToken('administrator')}`);
      expect(res.status).toBe(200);
      const mine = res.body.runs_in_progress.filter((r) => r.email === 'admin@admin-test.com');
      expect(mine).toEqual([
        { email: 'admin@admin-test.com', company: 'Admin Test Provider', distributor: 'Admin Test Co', running: 2, queued: 1 },
        { email: 'admin@admin-test.com', company: 'Admin Test Co', distributor: null, running: 0, queued: 1 },
      ]);
    } finally {
      for (const id of runIds) run('DELETE FROM runs WHERE id = ?', [id]);
      run('DELETE FROM companies WHERE id = ?', [providerId]);
    }
  });
});

// ── GET /v1/admin/companies ────────────────────────────────────────────────────

describe('GET /v1/admin/companies', () => {
  test('200 returns companies array', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/companies')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.companies)).toBe(true);
    expect(res.body.companies.length).toBeGreaterThan(0);
    const company = res.body.companies.find(c => c.id === companyId);
    expect(company).toBeTruthy();
    expect(company).toHaveProperty('user_count');
  });
});

// ── POST /v1/admin/companies ───────────────────────────────────────────────────

describe('POST /v1/admin/companies', () => {
  const adminToken = () => makeToken('administrator');

  test('400 when name or slug is missing', async () => {
    const res = await request(app)
      .post('/v1/admin/companies')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'NoSlug Corp' });
    expect(res.status).toBe(400);
  });

  test('201 creates company with sanitized slug', async () => {
    const slug = `new-test-co-${Date.now()}`;
    const res = await request(app)
      .post('/v1/admin/companies')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'New Test Company', slug });
    expect(res.status).toBe(201);
    expect(res.body.company.slug).toBe(slug);
    expect(res.body.company.name).toBe('New Test Company');
    // Clean up
    run('DELETE FROM companies WHERE id = ?', [res.body.company.id]);
  });

  test('409 when slug already in use', async () => {
    const res = await request(app)
      .post('/v1/admin/companies')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Duplicate', slug: 'admin-test-co' });
    expect(res.status).toBe(409);
  });

  test('slug is sanitized (special chars replaced with hyphen)', async () => {
    const res = await request(app)
      .post('/v1/admin/companies')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Special Corp', slug: `admin-tmp-Special_Corp_${Date.now()}` });
    expect(res.status).toBe(201);
    // Underscores should be replaced
    expect(res.body.company.slug).not.toContain('_');
    // Clean up
    run('DELETE FROM companies WHERE id = ?', [res.body.company.id]);
  });
});

// ── PATCH /v1/admin/companies/:id ─────────────────────────────────────────────

describe('PATCH /v1/admin/companies/:id', () => {
  let patchCompanyId;

  beforeAll(() => {
    patchCompanyId = uuidv4();
    run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Patch Co', 'patch-co-admin')`, [patchCompanyId]);
  });

  afterAll(() => {
    run('DELETE FROM companies WHERE id = ?', [patchCompanyId]);
  });

  test('400 when no update fields provided', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/companies/${patchCompanyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('200 updates company name', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/companies/${patchCompanyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Patch Co' });
    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('Updated Patch Co');
  });

  test('404 for non-existent company', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch(`/v1/admin/companies/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /v1/admin/companies/:id ────────────────────────────────────────────

describe('DELETE /v1/admin/companies/:id', () => {
  test('404 for non-existent company', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .delete(`/v1/admin/companies/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('409 when company has users', async () => {
    const token = makeToken('administrator');
    // Admin test co has users (adminId etc.)
    const res = await request(app)
      .delete(`/v1/admin/companies/${companyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/user/i);
  });

  test('200 deletes an empty company', async () => {
    const emptyCompanyId = uuidv4();
    run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Empty Co', 'empty-co-for-delete')`, [emptyCompanyId]);
    const token = makeToken('administrator');
    const res = await request(app)
      .delete(`/v1/admin/companies/${emptyCompanyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    const deleted = get('SELECT id FROM companies WHERE id = ?', [emptyCompanyId]);
    expect(deleted).toBeUndefined();
  });
});

// ── POST /v1/admin/users/:id/approve (issue #449) ─────────────────────────────

describe('POST /v1/admin/users/:id/approve', () => {
  let pendingUserId;
  let noTmCompanyId;

  beforeAll(() => {
    pendingUserId = uuidv4();
    // The administrator approves alone only in a company with no Test
    // Manager (access-requests.test.js covers the refusal elsewhere).
    noTmCompanyId = uuidv4();
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'No TM Co', ?)`, [noTmCompanyId, `no-tm-${noTmCompanyId.slice(0, 8)}`]);
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role, status)
       VALUES (?, ?, 'pending-approve@admin-test.com', 'x', 'company_user', 'pending')`,
      [pendingUserId, noTmCompanyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM users WHERE id = ?', [pendingUserId]);
    run('DELETE FROM companies WHERE id = ?', [noTmCompanyId]);
  });

  test('404 for non-existent user id', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${uuidv4()}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('400 when target user is not pending', async () => {
    const token = makeToken('administrator');
    // adminId is already 'active' (default status)
    const res = await request(app)
      .post(`/v1/admin/users/${adminId}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/not awaiting approval/i);
  });

  test('200 flips a pending user to active', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${pendingUserId}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(pendingUserId);
    expect(res.body.user.status).toBe('active');
    const row = get('SELECT status FROM users WHERE id = ?', [pendingUserId]);
    expect(row.status).toBe('active');
  });

  test('400 when re-approving an already-active user', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${pendingUserId}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ── POST /v1/admin/users/:id/generate-reset-link (issue #15 workaround) ──────

describe('POST /v1/admin/users/:id/generate-reset-link', () => {
  // A platform account (certifier): only those still get a link handed to the administrator.
  let resetLinkUserId;
  let companyLinkUserId;

  beforeAll(() => {
    resetLinkUserId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'reset-link-target@admin-test.com', 'x', 'certification_user')`,
      [resetLinkUserId, companyId]
    );
    companyLinkUserId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'reset-link-company@admin-test.com', 'x', 'company_user')`,
      [companyLinkUserId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM password_reset_tokens WHERE user_id IN (?, ?)', [resetLinkUserId, companyLinkUserId]);
    run('DELETE FROM users WHERE id IN (?, ?)', [resetLinkUserId, companyLinkUserId]);
  });

  // A company account's password is its owner's: no link is handed to the administrator.
  test('403 for a company account, and no token is issued', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${companyLinkUserId}/generate-reset-link`)
      .set('Authorization', `Bearer ${makeToken('administrator')}`);
    expect(res.status).toBe(403);
    expect(res.body.resetUrl).toBeUndefined();
    expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [companyLinkUserId]).n).toBe(0);
  });

  test('404 for non-existent user', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${uuidv4()}/generate-reset-link`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  // In production the link never comes from the Host header.
  test('503 in production without APP_URL, and no token is issued', async () => {
    const saved = { env: process.env.NODE_ENV, url: process.env.APP_URL };
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    try {
      run('DELETE FROM password_reset_tokens WHERE user_id = ?', [resetLinkUserId]);
      const res = await request(app)
        .post(`/v1/admin/users/${resetLinkUserId}/generate-reset-link`)
        .set('Authorization', `Bearer ${makeToken('administrator')}`)
        .set('Host', 'attacker.example');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('attacker.example');
      expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [resetLinkUserId]).n).toBe(0);
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.url === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.url;
    }
  });

  test('200 creates a password_reset_tokens row and returns a resetUrl', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post(`/v1/admin/users/${resetLinkUserId}/generate-reset-link`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(resetLinkUserId);
    expect(res.body.email).toBe('reset-link-target@admin-test.com');
    expect(typeof res.body.resetUrl).toBe('string');
    expect(res.body.resetUrl).toMatch(/reset-password\.html\?token=/);
    expect(res.body).toHaveProperty('expires_at');

    const tokenRow = get('SELECT * FROM password_reset_tokens WHERE user_id = ?', [resetLinkUserId]);
    expect(tokenRow).toBeTruthy();
    expect(res.body.resetUrl).toContain(tokenRow.token);
  });

  test('calling it again replaces the previous token (single active link)', async () => {
    const token = makeToken('administrator');
    const firstRow = get('SELECT token FROM password_reset_tokens WHERE user_id = ?', [resetLinkUserId]);
    const res = await request(app)
      .post(`/v1/admin/users/${resetLinkUserId}/generate-reset-link`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = all('SELECT token FROM password_reset_tokens WHERE user_id = ?', [resetLinkUserId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe(firstRow.token);
  });
});

// ── POST /v1/admin/users/:id/send-reset ───────────────────────────────────────

describe('POST /v1/admin/users/:id/send-reset', () => {
  let sendResetUserId;

  beforeAll(() => {
    sendResetUserId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'send-reset-target@admin-test.com', 'x', 'company_user')`,
      [sendResetUserId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM password_reset_tokens WHERE user_id = ?', [sendResetUserId]);
    run('DELETE FROM users WHERE id = ?', [sendResetUserId]);
  });

  test('404 for non-existent user', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${uuidv4()}/send-reset`)
      .set('Authorization', `Bearer ${makeToken('administrator')}`);
    expect(res.status).toBe(404);
  });

  test('200 sends a company account its own reset link: a token row, no link in the answer', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${sendResetUserId}/send-reset`)
      .set('Authorization', `Bearer ${makeToken('administrator')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, email: 'send-reset-target@admin-test.com' });
    const rows = all('SELECT token FROM password_reset_tokens WHERE user_id = ?', [sendResetUserId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(rows[0].token);
  });
});

// ── GET /v1/admin/config ───────────────────────────────────────────────────────

describe('GET /v1/admin/config', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/v1/admin/config');
    expect(res.status).toBe(401);
  });

  test('403 for non-administrator', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .get('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('200 returns config schema and server_info for administrator', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .get('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.config).toBeTruthy();
    expect(res.body.config).toHaveProperty('MAX_CONCURRENT_RUNS');
    expect(res.body.config.MAX_CONCURRENT_RUNS).toHaveProperty('value');
    expect(res.body.config.MAX_CONCURRENT_RUNS).toHaveProperty('type', 'number');
    expect(res.body.config).toHaveProperty('LOG_LEVEL');
    expect(res.body.config.LOG_LEVEL).toHaveProperty('options');
    expect(res.body.server_info).toBeTruthy();
    expect(res.body.server_info).toHaveProperty('node_version');
    expect(res.body.server_info).toHaveProperty('platform');
    expect(typeof res.body.server_info.uptime_seconds).toBe('number');
  });

  test('sensitive SMTP_PASS value is masked when set', async () => {
    const token = makeToken('administrator');
    // Set a SMTP_PASS value directly so we can assert the masking behaviour,
    // then restore the prior value so we don't leak state into other tests.
    const prior = get(`SELECT value FROM server_config WHERE key = 'SMTP_PASS'`);
    run(
      `INSERT INTO server_config (key, value, updated_at, updated_by)
       VALUES ('SMTP_PASS', 'xsmtpsib-supersecretvalue12345', datetime('now'), 'test-setup')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    const res = await request(app)
      .get('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.config.SMTP_PASS.value).toMatch(/^xsmt\*{4}$/);
    // restore
    if (prior) {
      run(`UPDATE server_config SET value = ? WHERE key = 'SMTP_PASS'`, [prior.value]);
    } else {
      run(`DELETE FROM server_config WHERE key = 'SMTP_PASS'`);
    }
  });
});

// ── PATCH /v1/admin/config ─────────────────────────────────────────────────────

describe('PATCH /v1/admin/config', () => {
  afterAll(() => {
    // Restore MAX_CONCURRENT_RUNS to a sane default in case a test above left
    // it altered — other suites (outside this file) may read server_config.
    run(`DELETE FROM server_config WHERE key = 'MAX_CONCURRENT_RUNS'`);
    run(`INSERT INTO server_config (key, value) VALUES ('MAX_CONCURRENT_RUNS', '10')`);
  });

  test('401 without token', async () => {
    const res = await request(app).patch('/v1/admin/config').send({ MAX_CONCURRENT_RUNS: 5 });
    expect(res.status).toBe(401);
  });

  test('403 for non-administrator', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 5 });
    expect(res.status).toBe(403);
  });

  test('200 updates a known numeric key within range', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 7 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(expect.arrayContaining([{ key: 'MAX_CONCURRENT_RUNS', value: '7' }]));
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.config.MAX_CONCURRENT_RUNS.value).toBe('7');
    const row = get(`SELECT value FROM server_config WHERE key = 'MAX_CONCURRENT_RUNS'`);
    expect(row.value).toBe('7');
  });

  test('MAX_CONCURRENT_RUNS takes 50 and refuses 51 (#1004)', async () => {
    const token = makeToken('administrator');
    const ok = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 50 });
    expect(ok.status).toBe(200);
    expect(ok.body.config.MAX_CONCURRENT_RUNS.value).toBe('50');
    const over = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 51 });
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body)).toMatch(/MAX_CONCURRENT_RUNS/);
    expect(get(`SELECT value FROM server_config WHERE key = 'MAX_CONCURRENT_RUNS'`).value).toBe('50');
  });

  test('400 when the only submitted key is unknown', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ NOT_A_REAL_CONFIG_KEY: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Unknown config key/);
  });

  test('400 when numeric value is out of range', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 999 });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/maximum is/);
  });

  test('400 when numeric value is not a number', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/must be a number/);
  });

  test('400 when enum value is not one of the allowed options', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ LOG_LEVEL: 'not-a-real-level' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/must be one of/);
  });

  test('200 updates LOG_LEVEL enum value', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ LOG_LEVEL: 'debug' });
    expect(res.status).toBe(200);
    expect(res.body.config.LOG_LEVEL.value).toBe('debug');
    // restore to a production-friendly default so other suites aren't noisy
    run(`UPDATE server_config SET value = 'info' WHERE key = 'LOG_LEVEL'`);
  });

  test('a masked (unchanged) sensitive value is skipped rather than overwritten', async () => {
    const token = makeToken('administrator');
    // Seed a real SMTP_PASS, then PATCH with the masked placeholder shape —
    // the route should skip it and leave the real value untouched.
    run(
      `INSERT INTO server_config (key, value, updated_at, updated_by)
       VALUES ('SMTP_PASS', 'realsecretvalue123', datetime('now'), 'test-setup')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ SMTP_PASS: 'real****' });
    expect(res.status).toBe(200);
    const row = get(`SELECT value FROM server_config WHERE key = 'SMTP_PASS'`);
    expect(row.value).toBe('realsecretvalue123');
    run(`DELETE FROM server_config WHERE key = 'SMTP_PASS'`);
  });

  test('surfaces a soft warning when SMTP_FROM equals SMTP_USER', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ SMTP_USER: 'a731f1001@smtp-brevo.com', SMTP_FROM: 'a731f1001@smtp-brevo.com' });
    expect(res.status).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    expect(res.body.warnings[0]).toHaveProperty('key', 'SMTP_FROM');
    // restore
    run(`DELETE FROM server_config WHERE key IN ('SMTP_USER', 'SMTP_FROM')`);
  });

  test('errors for unknown keys are returned alongside successful updates in the same request', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .patch('/v1/admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ MAX_CONCURRENT_RUNS: 8, BOGUS_KEY_XYZ: 'x' });
    expect(res.status).toBe(200); // partial success — updated.length > 0
    expect(res.body.updated).toEqual(expect.arrayContaining([{ key: 'MAX_CONCURRENT_RUNS', value: '8' }]));
    expect(res.body.errors.some(e => e.includes('BOGUS_KEY_XYZ'))).toBe(true);
  });
});

// ── POST /v1/admin/alertmanager/apply ─────────────────────────────────────────

describe('POST /v1/admin/alertmanager/apply', () => {
  test('401 without token', async () => {
    const res = await request(app).post('/v1/admin/alertmanager/apply');
    expect(res.status).toBe(401);
  });

  test('403 for non-administrator', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .post('/v1/admin/alertmanager/apply')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('200 with a graceful ok:false when SMTP_HOST is not configured', async () => {
    // Test env has no SMTP_HOST / ALERT_RECIPIENTS configured — renderConfig()
    // throws before any file write is attempted, and applyConfig() catches
    // that and returns a diagnostic payload rather than writing to disk.
    const priorHost = get(`SELECT value FROM server_config WHERE key = 'SMTP_HOST'`);
    run(`DELETE FROM server_config WHERE key = 'SMTP_HOST'`);

    const token = makeToken('administrator');
    const res = await request(app)
      .post('/v1/admin/alertmanager/apply')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.written).toBe(false);
    expect(res.body.reloaded).toBe(false);
    expect(res.body.error).toMatch(/SMTP_HOST is empty/);

    if (priorHost) {
      run(`INSERT INTO server_config (key, value) VALUES ('SMTP_HOST', ?)`, [priorHost.value]);
    }
  });
});

// ── POST /v1/admin/test-email ─────────────────────────────────────────────────

describe('POST /v1/admin/test-email', () => {
  test('401 without token', async () => {
    const res = await request(app).post('/v1/admin/test-email').send({ to: 'someone@example.com' });
    expect(res.status).toBe(401);
  });

  test('403 for non-administrator', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .post('/v1/admin/test-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: 'someone@example.com' });
    expect(res.status).toBe(403);
  });

  test('400 when "to" is missing', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post('/v1/admin/test-email')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 when "to" is not a valid email address', async () => {
    const token = makeToken('administrator');
    const res = await request(app)
      .post('/v1/admin/test-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('409 when SMTP is not configured', async () => {
    // Test env's server_config has no SMTP_HOST/SMTP_USER/SMTP_PASS — the
    // dev/no-SMTP path returns 409 with a diagnostic detail rather than
    // attempting a real network send.
    const token = makeToken('administrator');
    const res = await request(app)
      .post('/v1/admin/test-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: 'recipient@admin-test.com' });
    expect(res.status).toBe(409);
    expect(res.body.title).toBe('SMTP Not Configured');
    expect(res.body.detail).toMatch(/SMTP_HOST, SMTP_USER and SMTP_PASS/);
  });
});

// ── POST /v1/admin/rotate-jwt-secret ──────────────────────────────────────────
// IMPORTANT: this mutates process.env.JWT_SECRET (and the persisted config
// value) as a side effect of the route itself — every makeToken() call after
// this executes would sign against the OLD secret and start failing auth.
// This suite therefore runs LAST in the file and restores process.env.JWT_SECRET
// immediately after asserting, so it cannot bleed into any other test file
// that happens to share the Jest worker process.

describe('POST /v1/admin/rotate-jwt-secret', () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  test('401 without token', async () => {
    const res = await request(app).post('/v1/admin/rotate-jwt-secret');
    expect(res.status).toBe(401);
  });

  test('403 for non-administrator', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .post('/v1/admin/rotate-jwt-secret')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('200 rotates the persisted JWT secret and updates process.env.JWT_SECRET', async () => {
    const token = makeToken('administrator');
    const priorPersisted = get(`SELECT value FROM server_config WHERE key = 'JWT_SECRET'`);
    const priorEnvSecret = process.env.JWT_SECRET;

    const res = await request(app)
      .post('/v1/admin/rotate-jwt-secret')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rotated).toBe(true);
    expect(res.body.message).toMatch(/all existing sessions/i);

    const newPersisted = get(`SELECT value FROM server_config WHERE key = 'JWT_SECRET'`);
    expect(newPersisted).toBeTruthy();
    expect(newPersisted.value).not.toBe(priorPersisted && priorPersisted.value);
    // The route also overwrites process.env.JWT_SECRET in-process — confirm
    // that's exactly what changed (this is the part that would otherwise
    // break every subsequent makeToken() call in this file).
    expect(process.env.JWT_SECRET).toBe(newPersisted.value);
    expect(process.env.JWT_SECRET).not.toBe(priorEnvSecret);
  });
});
