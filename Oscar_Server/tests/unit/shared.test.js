'use strict';

/**
 * shared.test.js — Unit tests for the shared API helpers
 *
 * NOTE: Requires Node.js 22+ (node:sqlite). These tests are skipped
 * automatically on Node < 22 via the require() at the top of this file.
 *
 * Covers:
 *   - resolveRole: normalization + validation against ALLOWED_ROLES
 *   - ensurePlatformCompany: idempotent creation of the platform-root company
 *   - auditLog: inserts into auth_events; never throws on failure
 *   - resolveCompanyScope: 403 for certification_user, correct companyId for others
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-shared';

const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../../src/db/db');
const {
  resolveRole,
  ensurePlatformCompany,
  auditLog,
  resolveCompanyScope,
  ALLOWED_ROLES,
  PLATFORM_SLUG,
} = require('../../src/api/helpers/shared');

// ── resolveRole ───────────────────────────────────────────────────────────────

describe('resolveRole', () => {
  test('known role "company_user" returns "company_user"', () => {
    expect(resolveRole('company_user')).toBe('company_user');
  });

  test('known role "administrator" returns "administrator"', () => {
    expect(resolveRole('administrator')).toBe('administrator');
  });

  test('known role "certification_user" returns "certification_user"', () => {
    expect(resolveRole('certification_user')).toBe('certification_user');
  });

  test('known role "test_manager" returns "test_manager"', () => {
    expect(resolveRole('test_manager')).toBe('test_manager');
  });

  test('legacy "admin" is normalized to "company_user"', () => {
    expect(resolveRole('admin')).toBe('company_user');
  });

  test('legacy "member" is normalized to "company_user"', () => {
    expect(resolveRole('member')).toBe('company_user');
  });

  test('unknown role returns null', () => {
    expect(resolveRole('superuser')).toBeNull();
  });

  test('empty string returns "company_user" (normalizeRole falls back for falsy input)', () => {
    // normalizeRole('') defaults to 'company_user', which IS in ALLOWED_ROLES
    expect(resolveRole('')).toBe('company_user');
  });

  test('null input falls back to "company_user" (safe default)', () => {
    expect(resolveRole(null)).toBe('company_user');
  });

  test('ALLOWED_ROLES Set contains exactly the expected roles', () => {
    const expected = ['administrator', 'certification_user', 'test_manager', 'company_user'];
    for (const r of expected) expect(ALLOWED_ROLES.has(r)).toBe(true);
    expect(ALLOWED_ROLES.size).toBe(expected.length);
  });
});

// ── ensurePlatformCompany ─────────────────────────────────────────────────────

describe('ensurePlatformCompany', () => {
  test('creates the platform-root company when it does not exist', () => {
    // Ensure it doesn't exist first (clean test DB from setup.js)
    const before = get('SELECT id FROM companies WHERE slug = ?', [PLATFORM_SLUG]);
    if (before) run('DELETE FROM companies WHERE slug = ?', [PLATFORM_SLUG]);

    const company = ensurePlatformCompany();
    expect(company).toBeTruthy();
    expect(company.slug).toBe(PLATFORM_SLUG);
    expect(company.id).toBeTruthy();
  });

  test('is idempotent — calling twice returns same company id', () => {
    const first  = ensurePlatformCompany();
    const second = ensurePlatformCompany();
    expect(first.id).toBe(second.id);
  });

  test('returned company has id, name, and slug fields', () => {
    const company = ensurePlatformCompany();
    expect(company).toHaveProperty('id');
    expect(company).toHaveProperty('name');
    expect(company).toHaveProperty('slug');
  });
});

// ── auditLog ──────────────────────────────────────────────────────────────────

describe('auditLog', () => {
  let userId, companyId;

  beforeAll(() => {
    companyId = uuidv4();
    userId    = uuidv4();
    run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Audit Test Co', 'audit-test-co')`, [companyId]);
    run(
      `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'audit@test.com', 'x', 'company_user')`,
      [userId, companyId]
    );
  });

  afterAll(() => {
    run('DELETE FROM auth_events WHERE user_id = ?', [userId]);
    run('DELETE FROM users WHERE id = ?', [userId]);
    run('DELETE FROM companies WHERE id = ?', [companyId]);
  });

  test('inserts a row into auth_events', () => {
    const eventType = `test_event_${Date.now()}`;
    auditLog(userId, companyId, 'audit@test.com', eventType);
    const row = get('SELECT * FROM auth_events WHERE user_id = ? AND event_type = ?', [userId, eventType]);
    expect(row).toBeTruthy();
    expect(row.email).toBe('audit@test.com');
    expect(row.event_type).toBe(eventType);
  });

  test('never throws even on invalid data (swallows errors silently)', () => {
    // Passing a value that would violate FK constraints but auditLog catches all
    expect(() => auditLog(null, null, null, null)).not.toThrow();
  });
});

// ── resolveCompanyScope ───────────────────────────────────────────────────────

function mockReqRes({ user, companyId }) {
  const req = { user, companyId };
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b)     { this.body = b; return this; },
  };
  return { req, res };
}

describe('resolveCompanyScope', () => {
  test('certification_user gets 403 and null is returned', () => {
    const { req, res } = mockReqRes({ user: { role: 'certification_user', companyId: 'cid' }, companyId: null });
    const result = resolveCompanyScope(req, res);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  test('administrator gets req.companyId (the scoped target company)', () => {
    const { req, res } = mockReqRes({
      user: { role: 'administrator', companyId: 'platform-id' },
      companyId: 'target-company-id',
    });
    const result = resolveCompanyScope(req, res);
    expect(result).toBe('target-company-id');
    expect(res.statusCode).toBe(0);  // no error response sent
  });

  test('company_user gets req.user.companyId', () => {
    const { req, res } = mockReqRes({
      user: { role: 'company_user', companyId: 'my-company-id' },
      companyId: null,
    });
    const result = resolveCompanyScope(req, res);
    expect(result).toBe('my-company-id');
    expect(res.statusCode).toBe(0);
  });

  test('administrator with null req.companyId returns null (no target specified)', () => {
    const { req, res } = mockReqRes({
      user: { role: 'administrator', companyId: 'platform-id' },
      companyId: null,
    });
    const result = resolveCompanyScope(req, res);
    expect(result).toBeNull();
    // No error response (null companyId is valid for admins — means "all companies")
    expect(res.statusCode).toBe(0);
  });
});
