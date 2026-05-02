// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tenant-middleware.test.js — multi-tenant scope enforcement
 *
 * Critical security test: a company_user must NEVER be able to specify
 * an arbitrary company_id and access another company's data. Only platform
 * roles (administrator/certification_user) can target other companies.
 */

const { v4: uuidv4 } = require('uuid');
const { run, get } = require('../../src/db/db');
const { enforceTenant } = require('../../src/api/middleware/tenant');

function mockReqRes({ user, query = {}, headers = {}, body = {} }) {
  const req = { user, query, headers, body, companyId: undefined };
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return { req, res };
}

let companyA, companyB;

beforeAll(() => {
  companyA = uuidv4();
  companyB = uuidv4();
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Company A', 'company-a')`, [companyA]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Company B', 'company-b')`, [companyB]);
});

describe('enforceTenant — company_user', () => {
  test('always scoped to req.user.companyId, ignoring query params', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'company_user', companyId: companyA },
      query: { company_id: companyB },  // attempt to access another company
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBe(companyA);  // forced to own company
      done();
    });
  });

  test('ignores X-Company-Id header for company_user', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'company_user', companyId: companyA },
      headers: { 'x-company-id': companyB },
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBe(companyA);
      done();
    });
  });

  test('ignores company_id in body for company_user', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'company_user', companyId: companyA },
      body: { company_id: companyB },
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBe(companyA);
      done();
    });
  });

  test('401 when user has no companyId', () => {
    const { req, res } = mockReqRes({ user: { role: 'company_user' } });
    enforceTenant(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });
});

describe('enforceTenant — administrator', () => {
  test('can target another company via query param', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'administrator', companyId: 'platform-root-id' },
      query: { company_id: companyA },
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBe(companyA);
      done();
    });
  });

  test('returns 404 when targeting non-existent company', () => {
    const fakeCompanyId = uuidv4();
    const { req, res } = mockReqRes({
      user: { role: 'administrator', companyId: 'platform-root-id' },
      query: { company_id: fakeCompanyId },
    });
    enforceTenant(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(404);
  });

  test('proceeds with null companyId when no target specified', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'administrator', companyId: 'platform-root-id' },
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBeNull();
      done();
    });
  });
});

describe('enforceTenant — certification_user', () => {
  test('can target a specific company via header', (done) => {
    const { req, res } = mockReqRes({
      user: { role: 'certification_user', companyId: 'platform-root-id' },
      headers: { 'x-company-id': companyB },
    });
    enforceTenant(req, res, () => {
      expect(req.companyId).toBe(companyB);
      done();
    });
  });
});

afterAll(() => {
  // Clean up test companies so re-runs don't interfere
  run('DELETE FROM companies WHERE id IN (?, ?)', [companyA, companyB]);
});
