// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth-middleware.test.js — JWT validation and role-checking middleware
 *
 * Covers:
 *   - requireAuth rejects missing/invalid tokens, accepts valid tokens
 *   - requireRole rejects users without the required role
 *   - normalizeRole maps legacy roles to current ones
 *   - isPlatformRole correctly identifies admin/certifier
 */

const jwt = require('jsonwebtoken');

// Mock db.js so this unit test runs on any Node version (db.js needs node:sqlite ≥ 22).
// requireAuth calls get() to check the token blacklist; returning null means "not revoked".
jest.mock('../../src/db/db', () => ({ get: () => null }));

process.env.JWT_SECRET = 'test-jwt-secret-deterministic';

const { requireAuth, requireRole, normalizeRole, isPlatformRole, requireNotRole } = require('../../src/api/middleware/auth');

function mockReqRes(headers = {}) {
  const req = { headers, user: undefined };
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

function makeToken(payload, opts = {}) {
  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h', ...opts });
}

describe('normalizeRole', () => {
  test('maps legacy "admin" → "company_user"', () => {
    expect(normalizeRole('admin')).toBe('company_user');
  });
  test('maps legacy "member" → "company_user"', () => {
    expect(normalizeRole('member')).toBe('company_user');
  });
  test('passes through current roles unchanged', () => {
    expect(normalizeRole('administrator')).toBe('administrator');
    expect(normalizeRole('certification_user')).toBe('certification_user');
    expect(normalizeRole('company_user')).toBe('company_user');
  });
  test('null/undefined → company_user (safe default)', () => {
    expect(normalizeRole(null)).toBe('company_user');
    expect(normalizeRole(undefined)).toBe('company_user');
  });
});

describe('isPlatformRole', () => {
  test('true for administrator and certification_user', () => {
    expect(isPlatformRole('administrator')).toBe(true);
    expect(isPlatformRole('certification_user')).toBe(true);
  });
  test('false for company_user', () => {
    expect(isPlatformRole('company_user')).toBe(false);
  });
  test('false for null (cannot escalate via missing role)', () => {
    expect(isPlatformRole(null)).toBe(false);
    expect(isPlatformRole(undefined)).toBe(false);
  });
});

describe('requireAuth', () => {
  test('401 when no Authorization header', () => {
    const { req, res } = mockReqRes({});
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.title).toBe('Unauthorized');
  });

  test('401 when Authorization header is malformed', () => {
    const { req, res } = mockReqRes({ authorization: 'Token abc' });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('401 when token is invalid', () => {
    const { req, res } = mockReqRes({ authorization: 'Bearer invalid.token.here' });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('401 when token signed with wrong secret', () => {
    const badToken = jwt.sign({ sub: 'u1', email: 'x@y.com', companyId: 'c1', role: 'company_user' }, 'wrong-secret');
    const { req, res } = mockReqRes({ authorization: `Bearer ${badToken}` });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('401 when token is expired', () => {
    const expired = makeToken({ sub: 'u1', email: 'x@y.com', companyId: 'c1', role: 'company_user' }, { expiresIn: '-1s' });
    const { req, res } = mockReqRes({ authorization: `Bearer ${expired}` });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('attaches req.user when token is valid', (done) => {
    const token = makeToken({ sub: 'user-1', email: 'a@b.com', companyId: 'company-1', role: 'company_user' });
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(req.user).toEqual({ id: 'user-1', email: 'a@b.com', companyId: 'company-1', role: 'company_user' });
      done();
    });
  });

  test('normalizes legacy role on the JWT', (done) => {
    const token = makeToken({ sub: 'u', email: 'a@b.com', companyId: 'c', role: 'admin' });  // legacy
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(req.user.role).toBe('company_user');
      done();
    });
  });
});

describe('requireRole', () => {
  test('403 when user has wrong role', () => {
    const { req, res } = mockReqRes();
    req.user = { role: 'company_user' };
    requireRole('administrator')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(403);
  });

  test('passes when user has the required role', () => {
    const { req, res } = mockReqRes();
    req.user = { role: 'administrator' };
    let nextCalled = false;
    requireRole('administrator')(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  test('accepts multiple allowed roles', () => {
    const { req, res } = mockReqRes();
    req.user = { role: 'certification_user' };
    let nextCalled = false;
    requireRole('administrator', 'certification_user')(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  test('401 when no req.user', () => {
    const { req, res } = mockReqRes();
    requireRole('administrator')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });
});

describe('requireNotRole', () => {
  test('403 when user role is in excluded list', () => {
    const { req, res } = mockReqRes();
    req.user = { role: 'certification_user' };
    requireNotRole('certification_user')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(403);
  });

  test('passes when user role is NOT excluded', () => {
    const { req, res } = mockReqRes();
    req.user = { role: 'company_user' };
    let nextCalled = false;
    requireNotRole('certification_user')(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });
});
