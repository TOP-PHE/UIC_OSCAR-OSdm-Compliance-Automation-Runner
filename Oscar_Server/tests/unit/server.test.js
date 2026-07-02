// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * server.test.js — unit tests for src/server.js.
 *
 * server.js is architecturally different from every other module tested in
 * this project: requiring it has real side effects — it validates required
 * env vars (process.exit(1) on failure), generates/persists a JWT secret,
 * wires queue event listeners, runs startup reconciliation, and — critically
 * — calls a real app.listen(PORT) that binds an OS port. This file is the
 * ONLY place that requires src/server.js, and does so exactly once (a
 * distinctive, unlikely-to-collide PORT is set first) — every test below
 * exercises the exported Express `app` via supertest, which wraps the app
 * object directly and does not depend on the real listening port at all.
 *
 * Deliberately OUT OF SCOPE (documented, not forced — see CHANGELOG):
 *  - The missing-required-env-var process.exit(1) path (line ~40) — cannot
 *    be exercised without either mocking process.exit (fragile/dangerous)
 *    or spawning a real subprocess (heavyweight); left untested.
 *  - The startup Alertmanager-config-seed hook — gated behind
 *    ALERTMANAGER_CONFIG_PATH, which tests/setup.js does not set, so it
 *    naturally never runs (matches real dev/CI behaviour with that env
 *    var unset).
 *  - Static UI file serving (express.static) and the SPA index.html
 *    fallback — Express's own well-tested behaviour, not ours.
 *  - The global error handler — no non-invasive way to force an unhandled
 *    throw through a real mounted route without modifying source.
 *
 * Real-filesystem note: DATAFILES_DIR and ARTIFACTS_DIR are (like
 * runner.js's ARTIFACTS_DIR) hardcoded to real, non-overridable paths under
 * this repo's data/ folder (itself entirely gitignored). Every file this
 * suite writes there uses a highly distinctive `servertest-` prefix and is
 * removed in a try/finally around each test — never in a bare afterEach —
 * so cleanup happens even if an assertion throws mid-test.
 */

const path = require('path');
const fs   = require('fs');
const jwt  = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('../../src/worker/access-token');
const { resolveAccessToken } = require('../../src/worker/access-token');

// Distinctive, unlikely-to-collide port for the one real app.listen() call
// this require triggers. supertest never actually dials this port — it
// wraps the exported `app` object directly — this only has to avoid
// EADDRINUSE against anything else that might be running.
process.env.PORT = '39481';

const app = require('../../src/server');
const { run, get } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');

const DATAFILES_DIR = path.resolve(__dirname, '../../data/datafiles');
const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');

// server.js overwrites process.env.JWT_SECRET at require-time (generates +
// persists one to the DB if none existed). Sign test tokens against
// whatever value it ended up with — NOT any value set before the require.
const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(role, uid, companyId) {
  return jwt.sign({ sub: uid, email: `${role}@server-test.com`, companyId, role, jti: uuidv4() }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function seedCompanyUser() {
  const companyId = uuidv4();
  const userId = uuidv4();
  const slug = `servertest-${companyId.slice(0, 8)}`;
  run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [companyId, 'Server Test Co', slug]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
    [userId, companyId, `tester@server-test.com-${userId.slice(0, 8)}`]);
  return { companyId, userId, slug };
}

// ── /health ────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  test('200 with all checks ok against the real (test) DB', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.data_dir.ok).toBe(true);
    expect(res.body.checks.process.node_version).toBe(process.version);
    expect(res.body.checks.queue).toBeTruthy();
    expect(res.body.server_version).toBeTruthy();
  });
});

// ── /metrics ───────────────────────────────────────────────────────────────
describe('GET /metrics', () => {
  test('200 with Prometheus exposition text', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toEqual(expect.any(String));
    expect(res.text.length).toBeGreaterThan(0);
  });
});

// ── /json_validator/datafile.schema.json ─────────────────────────────────────
describe('GET /json_validator/datafile.schema.json', () => {
  test('404 when the schema file is not present under COLLECTION_PATH', async () => {
    // tests/setup.js's dummy COLLECTION_PATH has no json_validator/ subfolder.
    const res = await request(app).get('/json_validator/datafile.schema.json');
    expect(res.status).toBe(404);
  });

  test('200 + the file content when it exists', async () => {
    const schemaDir = path.join(process.env.COLLECTION_PATH, 'json_validator');
    const schemaFile = path.join(schemaDir, 'datafile.schema.json');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(schemaFile, JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#' }));
    try {
      const res = await request(app).get('/json_validator/datafile.schema.json');
      expect(res.status).toBe(200);
      expect(res.body.$schema).toContain('json-schema.org');
    } finally {
      fs.rmSync(schemaFile, { force: true });
    }
  });
});

// ── /data/:filename ────────────────────────────────────────────────────────
describe('GET /data/:filename', () => {
  test('400 on a filename that does not match {slug}-datafile.json', async () => {
    // A single-segment filename that reaches the route but fails
    // SAFE_DATAFILE_RE ('.' is not in [a-z0-9], the required first char).
    // (A literal "../" in the URL is normalized away by Express's own
    // routing before this route ever sees it — not this guard's job to
    // catch, so not what this test is for.)
    const res = await request(app).get('/data/..-datafile.json').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(400);
  });

  test('404 when no company has that slug', async () => {
    const res = await request(app).get('/data/no-such-company-xyz-datafile.json').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(404);
  });

  test('401 for a non-loopback request with no session', async () => {
    const { slug } = seedCompanyUser();
    // X-Forwarded-For makes isLoopbackBrunoCall() false, forcing the auth branch.
    const res = await request(app).get(`/data/${slug}-datafile.json`).set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(401);
  });

  test("403 when the session belongs to a different company", async () => {
    const { slug } = seedCompanyUser();
    const other = seedCompanyUser();
    const token = makeToken('company_user', other.userId, other.companyId);
    const res = await request(app).get(`/data/${slug}-datafile.json`)
      .set('X-Forwarded-For', '1.2.3.4')
      .set('Cookie', `oscar_session=${token}`);
    expect(res.status).toBe(403);
  });

  test('200 + decrypted content for the owning, authenticated company', async () => {
    const { companyId, userId, slug } = seedCompanyUser();
    const token = makeToken('company_user', userId, companyId);
    fs.mkdirSync(DATAFILES_DIR, { recursive: true });
    const filePath = path.join(DATAFILES_DIR, `${slug}-datafile.json`);
    const plaintext = Buffer.from(JSON.stringify({ scenarios: [] }));
    encryptToFile(plaintext, filePath);
    try {
      const res = await request(app).get(`/data/${slug}-datafile.json`)
        .set('X-Forwarded-For', '1.2.3.4')
        .set('Cookie', `oscar_session=${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ scenarios: [] });
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  test('200 for a loopback (Bruno subprocess) call — no session needed', async () => {
    const { slug } = seedCompanyUser();
    fs.mkdirSync(DATAFILES_DIR, { recursive: true });
    const filePath = path.join(DATAFILES_DIR, `${slug}-datafile.json`);
    encryptToFile(Buffer.from(JSON.stringify({ scenarios: ['loopback-ok'] })), filePath);
    try {
      // No X-Forwarded-For and supertest's in-process socket is loopback by
      // nature — isLoopbackBrunoCall() is true, bypassing session auth.
      const res = await request(app).get(`/data/${slug}-datafile.json`);
      expect(res.status).toBe(200);
      expect(res.body.scenarios).toContain('loopback-ok');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── /v1/runs/:runId/refresh-access-token (loopback-only) ──────────────────────
describe('POST /v1/runs/:runId/refresh-access-token', () => {
  test('400 on a malformed runId', async () => {
    const res = await request(app).post('/v1/runs/not-a-uuid/refresh-access-token');
    expect(res.status).toBe(400);
  });

  test('403 for a non-loopback caller even with a well-formed runId', async () => {
    const res = await request(app).post(`/v1/runs/${uuidv4()}/refresh-access-token`).set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(403);
  });

  test('404 when the run does not exist (loopback call)', async () => {
    const res = await request(app).post(`/v1/runs/${uuidv4()}/refresh-access-token`);
    expect(res.status).toBe(404);
  });

  test('200 + a fresh token on a real run, loopback call', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, companyId, userId]);
    resolveAccessToken.mockResolvedValueOnce('fresh-token-xyz');

    const res = await request(app).post(`/v1/runs/${runId}/refresh-access-token`);

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('fresh-token-xyz');
    expect(res.body.forced).toBe(false);
    expect(resolveAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: userId }),
      expect.anything(),
      expect.objectContaining({ forceRefresh: false })
    );
  });

  test('?force=1 is threaded through as forceRefresh:true', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, companyId, userId]);
    resolveAccessToken.mockResolvedValueOnce('forced-token');

    const res = await request(app).post(`/v1/runs/${runId}/refresh-access-token?force=1`);

    expect(res.status).toBe(200);
    expect(res.body.forced).toBe(true);
    expect(resolveAccessToken).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ forceRefresh: true })
    );
  });

  test('502 when resolveAccessToken rejects', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, companyId, userId]);
    resolveAccessToken.mockRejectedValueOnce(new Error('vendor rejected credentials'));

    const res = await request(app).post(`/v1/runs/${runId}/refresh-access-token`);

    expect(res.status).toBe(502);
    expect(res.body.detail).toMatch(/vendor rejected credentials/);
  });
});

// ── /artifacts/:runId/:filename ────────────────────────────────────────────────
describe('GET /artifacts/:runId/:filename', () => {
  test('400 on a malformed runId', async () => {
    const res = await request(app).get('/artifacts/not-a-uuid/report.html');
    expect(res.status).toBe(400);
  });

  test('400 on a filename containing path separators', async () => {
    const res = await request(app).get(`/artifacts/${uuidv4()}/..%2f..%2fetc%2fpasswd`);
    expect([400, 404]).toContain(res.status);
  });

  test('401 with no session', async () => {
    const res = await request(app).get(`/artifacts/${uuidv4()}/report.html`);
    expect(res.status).toBe(401);
  });

  test("404 when the run belongs to a different company (ownership check)", async () => {
    const { companyId, userId } = seedCompanyUser();
    const other = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, other.companyId, other.userId]);
    const token = makeToken('company_user', userId, companyId);
    const res = await request(app).get(`/artifacts/${runId}/report.html`).set('Cookie', `oscar_session=${token}`);
    expect(res.status).toBe(404);
  });

  test('404 when the run is owned by the caller but the file is not on disk', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, companyId, userId]);
    const token = makeToken('company_user', userId, companyId);
    const res = await request(app).get(`/artifacts/${runId}/missing.html`).set('Cookie', `oscar_session=${token}`);
    expect(res.status).toBe(404);
  });

  test('200 + decrypted HTML for an owned, on-disk artifact', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, companyId, userId]);
    const token = makeToken('company_user', userId, companyId);

    const runDir = path.join(ARTIFACTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const filePath = path.join(runDir, 'report.html');
    encryptToFile(Buffer.from('<html><body>ok</body></html>'), filePath);

    try {
      const res = await request(app).get(`/artifacts/${runId}/report.html`).set('Cookie', `oscar_session=${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<body>ok</body>');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('500 when an on-disk artifact fails to decrypt (tamper/corruption alert)', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, companyId, userId]);
    const token = makeToken('company_user', userId, companyId);

    const runDir = path.join(ARTIFACTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const filePath = path.join(runDir, 'report.html');
    // A real OSCAR1-encrypted file, then tampered: flip one byte well past
    // the 34-byte MAGIC+IV+TAG header (in the ciphertext region) so
    // isEncryptedBuffer() still recognizes it as encrypted (correct length +
    // MAGIC intact — does NOT fall back to legacy-plaintext) but the AES-GCM
    // auth tag no longer matches → decrypt throws.
    encryptToFile(Buffer.from('<html><body>ok</body></html>'), filePath);
    const bytes = fs.readFileSync(filePath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(filePath, bytes);

    try {
      const res = await request(app).get(`/artifacts/${runId}/report.html`).set('Cookie', `oscar_session=${token}`);
      expect(res.status).toBe(500);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});

// ── Mounted API routers respond (smoke check the app.use() wiring) ───────────
describe('mounted routers', () => {
  test('GET /v1/auth/register/companies is reachable (auth router mounted)', async () => {
    const res = await request(app).get('/v1/auth/register/companies');
    expect(res.status).toBe(200);
  });

  test('GET /v1/openapi.json serves the OpenAPI spec', async () => {
    const res = await request(app).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi || res.body.swagger).toBeTruthy();
  });

  test('unauthenticated GET /v1/runs is rejected (runs router mounted + auth-gated)', async () => {
    const res = await request(app).get('/v1/runs');
    expect(res.status).toBe(401);
  });
});

// ── HTTPS-redirect middleware (production only — issue Sonar S5146) ──────────
// The redirect block near the top of server.js only runs when
// NODE_ENV==='production', checked once at require-time via an `if` around
// `app.use(...)` — the only way to reach it is a SECOND, isolated require of
// server.js with NODE_ENV set beforehand. jest.resetModules() + a distinct
// PORT (avoids EADDRINUSE against the main `app`'s already-bound listener)
// makes this safe; this second app.listen() is, like the main one, never
// explicitly closed (server.js doesn't export the http.Server instance) —
// same accepted, contained tradeoff as the rest of this file.
describe('HTTPS-redirect middleware (NODE_ENV=production only)', () => {
  let prodApp;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPort = process.env.PORT;

  beforeAll(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.PORT = '39482';
    prodApp = require('../../src/server');
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.PORT = originalPort;
  });

  test('redirects http to https (no ALLOWED_REDIRECT_HOSTS configured → historical trust-Host behaviour)', async () => {
    const res = await request(prodApp).get('/health').set('Host', 'oscar.example.com').set('X-Forwarded-Proto', 'http');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://oscar.example.com/health');
  });

  test('does not redirect localhost (internal Bruno loopback calls stay plain HTTP)', async () => {
    const res = await request(prodApp).get('/health').set('Host', 'localhost:3001').set('X-Forwarded-Proto', 'http');
    expect(res.status).not.toBe(301);
  });

  test('does not redirect /metrics even over http (Prometheus cannot speak TLS to the app port)', async () => {
    const res = await request(prodApp).get('/metrics').set('Host', 'oscar.example.com').set('X-Forwarded-Proto', 'http');
    expect(res.status).not.toBe(301);
  });

  test('passes through unredirected when already https', async () => {
    const res = await request(prodApp).get('/health').set('Host', 'oscar.example.com').set('X-Forwarded-Proto', 'https');
    expect(res.status).not.toBe(301);
  });
});

afterAll(() => {
  // Order matters: runs.company_id cascades on company delete, but
  // runs.user_id has no cascade — deleting users first (while a run still
  // references them) would violate the FK constraint. Companies first.
  run("DELETE FROM companies WHERE slug LIKE 'servertest-%'");
  run("DELETE FROM users WHERE email LIKE '%server-test.com%'");
});
