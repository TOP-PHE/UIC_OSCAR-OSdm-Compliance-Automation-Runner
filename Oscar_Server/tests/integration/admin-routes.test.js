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
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-admin-routes';

const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/admin', '../../src/api/routes/admin');

// ── Test fixtures ─────────────────────────────────────────────────────────────

const adminId   = uuidv4();
const companyId = uuidv4();
let regularUserId;

function makeToken(role, uid = adminId) {
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
      .send({ email: `nocompany${Date.now()}@admin-test.com`, password: 'ValidPass1!Valid', role: 'company_user' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/company_id/i);
  });

  test('201 creates a company_user successfully', async () => {
    const email = `newuser${Date.now()}@admin-test.com`;
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email, password: 'ValidPass1!Valid', role: 'company_user', company_id: companyId });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe('company_user');
    regularUserId = res.body.user.id;
  });

  test('409 for duplicate email', async () => {
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email: 'admin@admin-test.com', password: 'ValidPass1!Valid', role: 'administrator' });
    expect(res.status).toBe(409);
  });

  test('creates administrator on the platform company (no company_id needed)', async () => {
    const email = `newadmin${Date.now()}@admin-test.com`;
    const res = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ email, password: 'ValidPass1!Valid', role: 'administrator' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('administrator');
    // Clean up
    run('DELETE FROM users WHERE id = ?', [res.body.user.id]);
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

  test('200 updates email', async () => {
    const token = makeToken('administrator');
    const newEmail = `patched${Date.now()}@admin-test.com`;
    const res = await request(app)
      .patch(`/v1/admin/users/${targetUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: newEmail });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(newEmail);
  });
});

// ── POST /v1/admin/users/:id/reset-password ───────────────────────────────────

describe('POST /v1/admin/users/:id/reset-password', () => {
  let resetTargetId;

  beforeAll(() => {
    resetTargetId = uuidv4();
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'reset-target@admin-test.com', 'x', 'company_user')`,
      [resetTargetId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM users WHERE id = ?', [resetTargetId]);
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
