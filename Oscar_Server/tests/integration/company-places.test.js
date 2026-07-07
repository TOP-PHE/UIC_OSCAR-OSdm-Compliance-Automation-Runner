// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-places.test.js — Integration tests for the OSDM stop-place cache +
 * lookup (/v1/company/places, issue #450).
 *
 * Covers:
 *   - Auth + role gating (lookup = vendor users; refresh = test_manager only;
 *     admin/certifier denied)
 *   - GET ?q= full-text filtering + prefix ranking + limit cap
 *   - GET (no q) returns cache metadata
 *   - POST /places/refresh: 400 with no api_base; happy-path pages through a
 *     stubbed vendor /places, dedupes across pages, and stops when a page adds
 *     nothing new (vendor that ignores ?page= returns the same list forever)
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-places-routes';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, encrypt } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company-places');

// ── Seed ────────────────────────────────────────────────────────────────────
const companyId       = uuidv4();   // has cached places + api_base
const noApiCompanyId  = uuidv4();   // no api_base → refresh 400
const tmId            = uuidv4();
const testerId        = uuidv4();
const certId          = uuidv4();
const adminId         = uuidv4();
const tmNoApiId       = uuidv4();

function makeToken(role, uid, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@places-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const SEED_PLACES = [
  { id: 'urn:uic:stn:8500010', name: 'Basel SBB', objectType: 'StopPlace' },
  { id: 'urn:uic:stn:8503000', name: 'Zürich HB', objectType: 'StopPlace' },
  { id: 'urn:uic:stn:8507000', name: 'Bern', objectType: 'StopPlace' },
  { id: 'urn:uic:stn:8768600', name: 'Basel Bad Bf', objectType: 'StopPlace' },
];

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug, api_base) VALUES (?, 'Places Test', 'places-test', 'https://vendor.example/osdm')`, [companyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Places NoApi', 'places-noapi')`, [noApiCompanyId]);
  // Bearer creds so resolveAccessToken returns a token with no network call.
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, 'tm@places-test.com', 'x', 'test_manager', 'bearer', ?)`, [tmId, companyId, encrypt('stub-bearer-token')]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tester@places-test.com', 'x', 'company_user')`, [testerId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'cert@places-test.com', 'x', 'certification_user')`, [certId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'admin@places-test.com', 'x', 'administrator')`, [adminId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm2@places-test.com', 'x', 'test_manager')`, [tmNoApiId, noApiCompanyId]);
  run(
    `INSERT INTO places_cache (company_id, places_json, place_count, cached_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET places_json = excluded.places_json, place_count = excluded.place_count`,
    [companyId, JSON.stringify(SEED_PLACES), SEED_PLACES.length]
  );
});

// ── Auth + role gating ────────────────────────────────────────────────────────
describe('places — auth + role gating', () => {
  test('401 on GET /places without a token', async () => {
    const res = await request(app).get('/v1/company/places');
    expect(res.status).toBe(401);
  });

  test('403 on GET /places for certification_user', async () => {
    const res = await request(app).get('/v1/company/places').set('Authorization', `Bearer ${makeToken('certification_user', certId)}`);
    expect(res.status).toBe(403);
  });

  test('403 on GET /places for administrator', async () => {
    const res = await request(app).get('/v1/company/places').set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
    expect(res.status).toBe(403);
  });

  test('200 on GET /places for a tester (read allowed)', async () => {
    const res = await request(app).get('/v1/company/places').set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(200);
    expect(res.body.place_count).toBe(SEED_PLACES.length);
    expect(res.body.cached_at).toBeTruthy();
  });

  test('403 on POST /places/refresh for a tester (write = test_manager only)', async () => {
    const res = await request(app).post('/v1/company/places/refresh').set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(403);
  });
});

// ── Lookup (?q=) ──────────────────────────────────────────────────────────────
describe('places — full-text lookup', () => {
  const auth = () => `Bearer ${makeToken('company_user', testerId)}`;

  test('substring match over name is case-insensitive', async () => {
    const res = await request(app).get('/v1/company/places?q=basel').set('Authorization', auth());
    expect(res.status).toBe(200);
    const names = res.body.places.map(p => p.name);
    expect(names).toContain('Basel SBB');
    expect(names).toContain('Basel Bad Bf');
    expect(names).not.toContain('Bern');
  });

  test('name prefix matches rank ahead of mid-string matches', async () => {
    // "ba" prefixes "Basel …" (rank 0) and appears mid-word in nothing else here.
    const res = await request(app).get('/v1/company/places?q=ba').set('Authorization', auth());
    expect(res.body.places[0].name.toLowerCase().startsWith('ba')).toBe(true);
  });

  test('matches on the URN id too', async () => {
    const res = await request(app).get('/v1/company/places?q=8503000').set('Authorization', auth());
    expect(res.body.places).toHaveLength(1);
    expect(res.body.places[0].id).toBe('urn:uic:stn:8503000');
  });

  test('limit is capped', async () => {
    const res = await request(app).get('/v1/company/places?q=urn&limit=2').set('Authorization', auth());
    expect(res.body.places.length).toBeLessThanOrEqual(2);
  });
});

// ── Refresh (bulk download) ───────────────────────────────────────────────────
describe('places — refresh', () => {
  test('400 when the company has no api_base', async () => {
    const res = await request(app).post('/v1/company/places/refresh').set('Authorization', `Bearer ${makeToken('test_manager', tmNoApiId, noApiCompanyId)}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/api base/i);
  });

  test('pages through the vendor, dedupes, and stops when a page adds nothing new', async () => {
    // The test_manager has bearer creds (seeded above) so resolveAccessToken
    // returns a token with no network. We only stub global.fetch — the vendor
    // /places call. It returns page 1, then page 2, then repeats page 2 forever
    // (a vendor that ignores ?page=); the route must dedupe and stop.
    const page1 = { places: [
      { objectType: 'StopPlace', id: 'urn:uic:stn:1', name: 'Alpha' },
      { objectType: 'StopPlace', id: 'urn:uic:stn:2', name: 'Beta' },
    ] };
    const page2 = { places: [
      { objectType: 'StopPlace', id: 'urn:uic:stn:2', name: 'Beta' },   // dup across pages
      { objectType: 'StopPlace', id: 'urn:uic:stn:3', name: 'Gamma' },
      { objectType: 'Place',     id: 'urn:uic:stn:4' },                 // no name → falls back to id
    ] };
    let call = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      call++;
      const body = call === 1 ? page1 : page2;   // page 0 → page1, every later page → page2 (repeats)
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    try {
      const res = await request(app).post('/v1/company/places/refresh').set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
      expect(res.status).toBe(200);
      expect(res.body.place_count).toBe(4);   // 1,2,3,4 deduped
      expect(res.body.truncated).toBe(false);

      // The cache row was upserted with the normalized places.
      const row = get('SELECT places_json, place_count FROM places_cache WHERE company_id = ?', [companyId]);
      expect(row.place_count).toBe(4);
      const cached = JSON.parse(row.places_json);
      const noName = cached.find(p => p.id === 'urn:uic:stn:4');
      expect(noName.name).toBe('urn:uic:stn:4');   // name falls back to id
    } finally {
      global.fetch = origFetch;
    }
  });

  // #477: the company's Dedicated Headers (API Config) were previously never
  // applied on this route — only the Bruno run path read them.
  test('#477 — sends the company Dedicated Headers, resolving {{access_token}}', async () => {
    run(`UPDATE companies SET extra_headers = ? WHERE id = ?`, [
      JSON.stringify([{ name: 'accept-language', value: 'en' }, { name: 'authorization-echo', value: 'Bearer {{access_token}}' }]),
      companyId
    ]);
    const origFetch = global.fetch;
    let capturedHeaders = null;
    global.fetch = async (_url, opts) => { capturedHeaders = opts.headers; return { ok: true, status: 200, text: async () => JSON.stringify({ places: [] }) }; };
    try {
      const res = await request(app).post('/v1/company/places/refresh').set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
      expect(res.status).toBe(200);
      expect(capturedHeaders['accept-language']).toBe('en');
      expect(capturedHeaders['authorization-echo']).toBe('Bearer stub-bearer-token');
    } finally {
      global.fetch = origFetch;
      run(`UPDATE companies SET extra_headers = NULL WHERE id = ?`, [companyId]);
    }
  });
});

afterAll(() => {
  run('DELETE FROM places_cache WHERE company_id IN (?, ?)', [companyId, noApiCompanyId]);
  run("DELETE FROM users WHERE email LIKE '%@places-test.com'");
  run('DELETE FROM companies WHERE id IN (?, ?)', [companyId, noApiCompanyId]);
});
