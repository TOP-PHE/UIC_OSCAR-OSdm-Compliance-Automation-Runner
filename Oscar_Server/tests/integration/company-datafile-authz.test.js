// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-authz.test.js — S2 / S3 (v1.11.195): nothing touches a
 * company's live datafile until the write has been authorised AND validated.
 *
 * Each rejected write must leave the live datafile byte-for-byte as it was,
 * still decrypting to the baseline, with companies.datafile_hash still
 * describing it. A status code on its own proves nothing here: before this
 * release the tester, administrator and certifier uploads below all returned
 * 403 *after* multer had already written the upload over the live file.
 *
 * Policy under test: POST (whole-file upload) is Test-Manager-only; PUT (the
 * scenario editor's save) admits testers and Test Managers of the company and
 * refuses administrators and certifiers. Both are pinned to the caller's own
 * company whatever ?company_id= / X-Company-Id says.
 *
 * Kept apart from company-routes.test.js on purpose. Every request here goes
 * through datafileMutationLimiter (20 per 15 min per client), and a module
 * registry of its own gives this file its own bucket. For the same reason the
 * per-test baseline is seeded straight to disk + DB rather than through the
 * rate-limited route. The company slug is unique per run because
 * data/datafiles/ is a real directory shared by test files running in
 * parallel.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-datafile-authz';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

// ── Identities ────────────────────────────────────────────────────────────────
const companyId  = crypto.randomUUID();
const slug       = `datafile-authz-${companyId.slice(0, 8)}`;
const liveName   = `${slug}-datafile.json`;
const otherCoId  = crypto.randomUUID();   // a second tenant, for the cross-company attempts
const otherSlug  = `datafile-authz-other-${otherCoId.slice(0, 8)}`;
const testMgrId  = crypto.randomUUID();
const testerId   = crypto.randomUUID();
const certId     = crypto.randomUUID();
const adminId    = crypto.randomUUID();
const platformCo = crypto.randomUUID();   // a platform role's own JWT companyId; the target is x-company-id

const DATAFILES_DIR = path.resolve(__dirname, '../../data/datafiles');
const LIVE_PATH     = path.join(DATAFILES_DIR, liveName);
const OTHER_PATH    = path.join(DATAFILES_DIR, `${otherSlug}-datafile.json`);

function makeToken(role, uid, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@datafile-authz.test`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const BASELINE = { scenarios: [{ code: 'OTST_BASELINE_SENTINEL' }], scenariosToRun: ['OTST_BASELINE_SENTINEL'] };
const HOSTILE  = { scenarios: [{ code: 'OTST_HOSTILE_OVERWRITE' }], scenariosToRun: ['OTST_HOSTILE_OVERWRITE'] };
const hostileFile = Buffer.from(JSON.stringify(HOSTILE), 'utf8');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── Fixtures ──────────────────────────────────────────────────────────────────
beforeAll(() => {
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Datafile Authz Test', ?)`, [companyId, slug]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Datafile Authz Other', ?)`, [otherCoId, otherSlug]);
  for (const [id, role] of [[testMgrId, 'test_manager'], [testerId, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [id, companyId, `${role}-${id}@datafile-authz.test`, role]);
  }
});

// Seed the baseline the same way PUT /datafile/json stores one — encrypted
// envelope on disk, sha256 of the plaintext in companies.datafile_hash — but
// without spending a rate-limited request on it.
//
// Only rewrite a file that is not already the intact baseline (checked by
// decrypting it — a read). On a Windows checkout inside OneDrive, renaming over
// a file that was written milliseconds earlier fails with EPERM now and then
// (see CLAUDE.md §2), and reseeding both companies before every test was 22 such
// renames per run. Every test still starts from a verified baseline.
const BASELINE_CONTENT = JSON.stringify(BASELINE, null, 4);
const BASELINE_HASH    = sha256(BASELINE_CONTENT);

function seedBaseline(id, p) {
  const c = get('SELECT datafile_path, datafile_hash FROM companies WHERE id = ?', [id]);
  const intact = c.datafile_path === p && c.datafile_hash === BASELINE_HASH && fs.existsSync(p)
    && sha256(decryptFromFile(p).toString('utf8')) === BASELINE_HASH;
  if (intact) return;
  encryptToFile(BASELINE_CONTENT, p);
  run(`UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now') WHERE id = ?`,
    [p, BASELINE_HASH, id]);
}

beforeEach(() => {
  seedBaseline(companyId, LIVE_PATH);
  seedBaseline(otherCoId, OTHER_PATH);
});

afterAll(() => {
  for (const f of fs.readdirSync(DATAFILES_DIR).filter(n => n.startsWith(slug) || n.startsWith(otherSlug))) {
    try { fs.unlinkSync(path.join(DATAFILES_DIR, f)); } catch (_) { /* ignore */ }
  }
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  safe('DELETE FROM auth_events WHERE company_id IN (?, ?)', [companyId, otherCoId]);
  safe('DELETE FROM companies WHERE id IN (?, ?)', [companyId, otherCoId]);   // before users: runs.user_id does not cascade
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function liveDatafile(id = companyId) {
  const c = get('SELECT datafile_path, datafile_hash FROM companies WHERE id = ?', [id]);
  return {
    path:  c.datafile_path,
    hash:  c.datafile_hash,
    bytes: fs.readFileSync(c.datafile_path),
    plain: decryptFromFile(c.datafile_path).toString('utf8'),
  };
}

function expectUntouched(before, id = companyId) {
  const after = liveDatafile(id);
  expect(after.bytes.equals(before.bytes)).toBe(true);
  expect(after.plain).toContain('OTST_BASELINE_SENTINEL');
  expect(after.plain).not.toContain('OTST_HOSTILE_OVERWRITE');
  expect(after.hash).toBe(before.hash);
  expect(sha256(after.plain)).toBe(after.hash);
}

function strayFiles() {
  return fs.readdirSync(DATAFILES_DIR).filter(n => n.startsWith(slug) && n !== liveName);
}

// ── Unauthorised callers ──────────────────────────────────────────────────────
const asTester = ['a tester on their own company', () => makeToken('company_user', testerId), {}];
const platform = [
  ['an administrator naming the company', () => makeToken('administrator', adminId, platformCo), { 'x-company-id': companyId }],
  ['a certifier naming the company',      () => makeToken('certification_user', certId, platformCo), { 'x-company-id': companyId }],
];

// The upload replaces the whole file from an arbitrary document — Test
// Managers only, so a tester is refused here too.
describe.each([asTester, ...platform])('POST /v1/company/datafile by %s', (_label, token, headers) => {
  test('403, and the live datafile is untouched', async () => {
    const before = liveDatafile();
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token()}`)
      .set(headers)
      .attach('datafile', hostileFile, 'datafile.json');
    expect(res.status).toBe(403);
    expectUntouched(before);
    expect(strayFiles()).toEqual([]);
  });
});

describe.each(platform)('PUT /v1/company/datafile/json by %s', (_label, token, headers) => {
  test('403, and the live datafile is untouched', async () => {
    const before = liveDatafile();
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token()}`)
      .set(headers)
      .send(HOSTILE);
    expect(res.status).toBe(403);
    expectUntouched(before);
  });
});

// ── Testers and the scenario editor's save ────────────────────────────────────
// Testers keep PUT /datafile/json: the Test Config page is on their menu and it
// is how they author scenarios and set scenariosToRun, which POST /v1/runs
// reads. What they must not do is reach another company — and they cannot,
// because resolveCompanyScope() ignores the company headers for non-platform
// roles.
describe('PUT /v1/company/datafile/json by a tester', () => {
  test('saves their own company\'s datafile (the Test Config workflow)', async () => {
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`)
      .send(HOSTILE);
    expect(res.status).toBe(200);
    const after = liveDatafile();
    expect(after.plain).toContain('OTST_HOSTILE_OVERWRITE');
    expect(sha256(after.plain)).toBe(after.hash);
  });

  test('naming another company in x-company-id or ?company_id= cannot reach it', async () => {
    const other = liveDatafile(otherCoId);
    const res = await request(app)
      .put(`/v1/company/datafile/json?company_id=${otherCoId}`)
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`)
      .set('x-company-id', otherCoId)
      .send(HOSTILE);
    // The save lands on the tester's own company, never the one named.
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe(liveName);
    expectUntouched(other, otherCoId);
    expect(liveDatafile().plain).toContain('OTST_HOSTILE_OVERWRITE');
  });
});

// ── The authorised caller ─────────────────────────────────────────────────────
describe('POST /v1/company/datafile by the test manager', () => {
  // The same write-before-validate ordering hurt the legitimate caller too:
  // multer wrote the upload over the live file, then the handler unlinked it
  // when validation failed — leaving the company with no datafile on disk
  // while companies.datafile_path and datafile_hash still pointed at one.
  test('invalid JSON is refused with 400 and the previous datafile survives', async () => {
    const before = liveDatafile();
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${makeToken('test_manager', testMgrId)}`)
      .attach('datafile', Buffer.from('{ not valid json', 'utf8'), 'datafile.json');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/not valid json/i);
    expectUntouched(before);
    expect(strayFiles()).toEqual([]);
  });

  test('an oversized upload is refused and the previous datafile survives', async () => {
    const before = liveDatafile();
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${makeToken('test_manager', testMgrId)}`)
      .attach('datafile', Buffer.alloc(5 * 1024 * 1024 + 1, 0x20), 'datafile.json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectUntouched(before);
    expect(strayFiles()).toEqual([]);
  });

  test('an accepted upload replaces the file, the hash describes what is on disk, nothing is left behind', async () => {
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${makeToken('test_manager', testMgrId)}`)
      .attach('datafile', hostileFile, 'datafile.json');
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe(liveName);

    const after = liveDatafile();
    expect(after.path).toBe(LIVE_PATH);
    expect(after.plain).toContain('OTST_HOSTILE_OVERWRITE');
    expect(res.body.hash).toBe(after.hash);
    expect(sha256(after.plain)).toBe(after.hash);
    // Encrypted at rest — the plaintext upload never sits on disk.
    expect(after.bytes.toString('utf8')).not.toContain('OTST_HOSTILE_OVERWRITE');
    expect(strayFiles()).toEqual([]);
  });
});

describe('PUT /v1/company/datafile/json by the test manager', () => {
  test('200, and the hash describes what is on disk', async () => {
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${makeToken('test_manager', testMgrId)}`)
      .send(HOSTILE);
    expect(res.status).toBe(200);
    const after = liveDatafile();
    expect(after.plain).toContain('OTST_HOSTILE_OVERWRITE');
    expect(res.body.hash).toBe(after.hash);
    expect(sha256(after.plain)).toBe(after.hash);
  });
});
