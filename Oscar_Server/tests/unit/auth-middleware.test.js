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
 *   - requireAuth reads the oscar_session cookie, checks the token blacklist
 *   - requireRole rejects users without the required role
 *   - requireNotRole rejects users whose role is excluded
 *   - normalizeRole maps legacy roles to current ones
 *   - isPlatformRole correctly identifies admin/certifier
 *   - isTestManagerOrAbove correctly identifies test_manager/administrator
 *   - userFromRequest mirrors requireAuth's lookup for non-middleware callers
 */

const jwt = require('jsonwebtoken');

// Mock db.js so this unit test runs on any Node version (db.js needs node:sqlite ≥ 22).
// requireAuth calls get() to check the token blacklist; returning null means "not revoked".
// jest.fn() (rather than a plain arrow function) so individual tests can override the
// return value to simulate a blacklisted jti.
jest.mock('../../src/db/db', () => ({ get: jest.fn(() => null) }));

process.env.JWT_SECRET = 'test-jwt-secret-deterministic';

const { get: mockGet } = require('../../src/db/db');
const {
  requireAuth,
  requireRole,
  requireNotRole,
  normalizeRole,
  isPlatformRole,
  isTestManagerOrAbove,
  userFromRequest,
} = require('../../src/api/middleware/auth');

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockReturnValue(null);   // default: token is not revoked
});

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

describe('isTestManagerOrAbove', () => {
  test('true for test_manager', () => {
    expect(isTestManagerOrAbove('test_manager')).toBe(true);
  });
  test('true for administrator', () => {
    expect(isTestManagerOrAbove('administrator')).toBe(true);
  });
  test('false for certification_user', () => {
    expect(isTestManagerOrAbove('certification_user')).toBe(false);
  });
  test('false for company_user', () => {
    expect(isTestManagerOrAbove('company_user')).toBe(false);
  });
  test('false for null/undefined (normalizes to company_user)', () => {
    expect(isTestManagerOrAbove(null)).toBe(false);
    expect(isTestManagerOrAbove(undefined)).toBe(false);
  });
  test('normalizes legacy roles before comparing (legacy "admin" is not administrator)', () => {
    // ROLE_MAP maps legacy 'admin' -> 'company_user', so it should NOT count as administrator.
    expect(isTestManagerOrAbove('admin')).toBe(false);
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

  test('attaches req.user from the oscar_session cookie', (done) => {
    const token = makeToken({ sub: 'user-2', email: 'c@d.com', companyId: 'company-2', role: 'company_user' });
    const { req, res } = mockReqRes({ cookie: `oscar_session=${token}` });
    requireAuth(req, res, () => {
      expect(req.user).toEqual({ id: 'user-2', email: 'c@d.com', companyId: 'company-2', role: 'company_user' });
      done();
    });
  });

  test('cookie takes priority over Authorization header when both are present', (done) => {
    const cookieToken  = makeToken({ sub: 'cookie-user', email: 'cookie@x.com', companyId: 'c1', role: 'company_user' });
    const bearerToken  = makeToken({ sub: 'bearer-user', email: 'bearer@x.com', companyId: 'c2', role: 'administrator' });
    const { req, res } = mockReqRes({ cookie: `oscar_session=${cookieToken}`, authorization: `Bearer ${bearerToken}` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('cookie-user');
      done();
    });
  });

  test('parses a multi-cookie header and picks out oscar_session', (done) => {
    const token = makeToken({ sub: 'user-3', email: 'e@f.com', companyId: 'company-3', role: 'company_user' });
    const { req, res } = mockReqRes({ cookie: `other=ignored; oscar_session=${token}; another=also_ignored` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('user-3');
      done();
    });
  });

  test('URL-decodes the cookie value', (done) => {
    // jwt tokens don't normally need decoding (base64url has no reserved chars), but the
    // cookie parser must decodeURIComponent() every value — assert that path is exercised
    // and doesn't corrupt a token that happens to need no actual decoding.
    const token = makeToken({ sub: 'user-4', email: 'g@h.com', companyId: 'company-4', role: 'company_user' });
    const { req, res } = mockReqRes({ cookie: `oscar_session=${encodeURIComponent(token)}` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('user-4');
      done();
    });
  });

  test('401 when cookie header has no oscar_session pair and no Authorization header', () => {
    const { req, res } = mockReqRes({ cookie: 'other=value; foo=bar' });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('drops a cookie pair with no "=" and falls through to Bearer header', (done) => {
    const token = makeToken({ sub: 'user-5', email: 'i@j.com', companyId: 'company-5', role: 'company_user' });
    // "malformed" has no '=' so parseCookies skips it (idx < 0 branch); oscar_session is absent,
    // so requireAuth must fall back to the Authorization header.
    const { req, res } = mockReqRes({ cookie: 'malformed', authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('user-5');
      done();
    });
  });

  test('drops a cookie whose name contains invalid RFC 6265 characters', (done) => {
    const token = makeToken({ sub: 'user-6', email: 'k@l.com', companyId: 'company-6', role: 'company_user' });
    // "bad name" contains a space, which is not a valid cookie-name token character, so the
    // allow-list regex drops it. oscar_session is absent, so falls back to the Bearer header.
    const { req, res } = mockReqRes({ cookie: 'bad name=x', authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('user-6');
      done();
    });
  });

  test('empty cookie header behaves like no cookie header', () => {
    const { req, res } = mockReqRes({ cookie: '' });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  test('401 when the token jti is present in the blacklist (revoked)', () => {
    mockGet.mockReturnValue({ jti: 'revoked-jti-1' });
    const token = makeToken({ sub: 'u1', email: 'x@y.com', companyId: 'c1', role: 'company_user', jti: 'revoked-jti-1' });
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    requireAuth(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.detail).toBe('Token has been revoked.');
  });

  test('passes when the token jti is present but NOT in the blacklist', (done) => {
    mockGet.mockReturnValue(null);   // not revoked
    const token = makeToken({ sub: 'u2', email: 'z@y.com', companyId: 'c1', role: 'company_user', jti: 'active-jti-1' });
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(req.user.id).toBe('u2');
      done();
    });
  });

  test('skips the blacklist lookup entirely when the token has no jti', (done) => {
    const token = makeToken({ sub: 'u3', email: 'nojti@y.com', companyId: 'c1', role: 'company_user' });  // no jti
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    requireAuth(req, res, () => {
      expect(mockGet).not.toHaveBeenCalled();
      expect(req.user.id).toBe('u3');
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

  test('401 when no req.user', () => {
    const { req, res } = mockReqRes();
    requireNotRole('certification_user')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
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

describe('userFromRequest', () => {
  test('returns the user object from a valid Bearer token', () => {
    const token = makeToken({ sub: 'user-7', email: 'm@n.com', companyId: 'company-7', role: 'company_user' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(userFromRequest(req)).toEqual({ id: 'user-7', email: 'm@n.com', companyId: 'company-7', role: 'company_user' });
  });

  test('returns the user object from a valid oscar_session cookie', () => {
    const token = makeToken({ sub: 'user-8', email: 'o@p.com', companyId: 'company-8', role: 'administrator' });
    const req = { headers: { cookie: `oscar_session=${token}` } };
    expect(userFromRequest(req)).toEqual({ id: 'user-8', email: 'o@p.com', companyId: 'company-8', role: 'administrator' });
  });

  test('normalizes legacy roles', () => {
    const token = makeToken({ sub: 'user-9', email: 'q@r.com', companyId: 'company-9', role: 'member' });  // legacy
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(userFromRequest(req).role).toBe('company_user');
  });

  test('returns null when there is no token', () => {
    const req = { headers: {} };
    expect(userFromRequest(req)).toBeNull();
  });

  test('returns null when the token is invalid', () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' } };
    expect(userFromRequest(req)).toBeNull();
  });

  test('returns null when the token is expired', () => {
    const expired = makeToken({ sub: 'u1', email: 'x@y.com', companyId: 'c1', role: 'company_user' }, { expiresIn: '-1s' });
    const req = { headers: { authorization: `Bearer ${expired}` } };
    expect(userFromRequest(req)).toBeNull();
  });

  test('returns null when the token jti is blacklisted', () => {
    mockGet.mockReturnValue({ jti: 'revoked-jti-2' });
    const token = makeToken({ sub: 'u1', email: 'x@y.com', companyId: 'c1', role: 'company_user', jti: 'revoked-jti-2' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(userFromRequest(req)).toBeNull();
  });

  test('returns the user object when the token jti is present but NOT blacklisted', () => {
    mockGet.mockReturnValue(null);   // not revoked
    const token = makeToken({ sub: 'user-10', email: 's@t.com', companyId: 'company-10', role: 'company_user', jti: 'active-jti-2' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(userFromRequest(req)).toEqual({ id: 'user-10', email: 's@t.com', companyId: 'company-10', role: 'company_user' });
  });

  test('does not throw when req.headers is missing entirely', () => {
    // requireAuth assumes req.headers always exists (Express guarantees it), but
    // userFromRequest is documented as "never throws" for any caller — verify that
    // contract holds even for a malformed req.
    const req = {};
    expect(() => userFromRequest(req)).not.toThrow();
    expect(userFromRequest(req)).toBeNull();
  });
});
