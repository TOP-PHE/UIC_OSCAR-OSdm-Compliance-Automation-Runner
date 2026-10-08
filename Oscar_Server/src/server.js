// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * server.js — OSCAR Express application entry point
 *
 * Starts the API server, mounts all routes, and serves:
 *  - Static UI files from /public
 *  - Company data files at /data/:slug-datafile.json  (fetched by Bruno during runs)
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('node:path');
const fs      = require('node:fs');
const crypto  = require('node:crypto');
const dotenv  = require('dotenv');

const ENV_PRIMARY  = path.resolve(__dirname, '../oscar-server.env');
const ENV_FALLBACK = path.resolve(__dirname, '../.env');

const loaded = dotenv.config({ path: ENV_PRIMARY });
if (loaded.error && fs.existsSync(ENV_FALLBACK)) {
  dotenv.config({ path: ENV_FALLBACK });
}

// ── Validate required env vars before anything else ───────────────────────────
const REQUIRED_ENV = ['ENCRYPTION_KEY', 'COLLECTION_PATH', 'BRU_CMD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[server] FATAL: Missing required environment variables: ${missing.join(', ')}`);
  console.error(`[server] Copy .env.example to oscar-server.env and fill in the values.`);
  process.exit(1);
}

// ── Initialise structured logger ─────────────────────────────────────────────
const log = require('./utils/logger');

// ── Version info + compatibility check (logs warning if combo not tested) ────
const { getVersionInfo } = require('./utils/versionInfo');

// ── Initialise DB (runs schema migration on startup) ──────────────────────────
require('./db/db');

// ── Persistent JWT secret — stored in DB so sessions survive restarts ─────────
// On first boot, generate a random secret and persist it. On subsequent boots,
// reuse the stored secret. Admins can rotate via POST /v1/admin/rotate-jwt-secret
// (which invalidates all current sessions intentionally).
const { get: dbGet, run: dbRun } = require('./db/db');
let jwtRow = dbGet('SELECT value FROM server_config WHERE key = ?', ['JWT_SECRET']);
if (!jwtRow) {
  const newSecret = crypto.randomBytes(32).toString('hex');
  dbRun('INSERT INTO server_config (key, value) VALUES (?, ?)', ['JWT_SECRET', newSecret]);
  jwtRow = { value: newSecret };
  log.info('JWT secret generated and persisted to DB');
}
process.env.JWT_SECRET = jwtRow.value;

// ── Attach queue event listeners ──────────────────────────────────────────────
const queue = require('./worker/queue');
const metricsForQueue = require('./utils/metrics');
queue.on('started',   ({ runId }) => log.info({ runId }, 'Run started'));
queue.on('completed', ({ runId, exitCode }) => {
  log.info({ runId, exitCode }, 'Run completed');
  metricsForQueue.runsTotal.inc({ status: exitCode === 0 ? 'COMPLETED' : 'FAILED' });
});
queue.on('failed', ({ runId, error }) => {
  log.error({ runId, error }, 'Run failed');
  metricsForQueue.runsTotal.inc({ status: 'FAILED' });
});

// ── Startup reconciliation — fail runs orphaned by the previous process exit ──
// The queue above is in-memory: on boot its pending list is empty, so any run
// still RUNNING/QUEUED in the DB was orphaned by the previous exit (deploy,
// crash, SIGTERM, docker restart) and would otherwise occupy company
// concurrency slots forever — wedging the queue (observed after a Watchtower
// deploy landed mid-batch: 4 orphaned RUNNING rows pinned all 4 slots, 2
// QUEUED could never start). Mark them FAILED so slots free and the dashboard
// reflects reality. Synchronous and safe here: DB migrations already ran
// (require('./db/db') above) and no job has been enqueued yet.
try {
  require('./worker/reconcile').reconcileOrphanedRuns();
} catch (e) {
  log.error({ err: e.message }, 'Startup run reconciliation threw (non-fatal)');
}

// Periodically refresh queue depth + active-runs gauges from the queue's
// own state. Every 5s — well below Prometheus's typical 15s scrape interval,
// so a scrape never sees a totally stale value.
setInterval(() => {
  try {
    if (typeof queue.depth === 'number')   metricsForQueue.queueDepth.set(queue.depth);
    if (typeof queue.running === 'number') metricsForQueue.activeRuns.set(queue.running);
  } catch (_e) { /* never let metric collection crash the server */ }
}, 5000).unref();   // .unref() so the interval doesn't keep Node alive on shutdown

// ── Prometheus metrics ────────────────────────────────────────────────────────
// Registry + custom counters/gauges/histograms used by the rest of the codebase.
// Endpoint is exposed below; nginx blocks /metrics externally so only the
// Prometheus container in the same Docker network can scrape it.
const metrics = require('./utils/metrics');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Trust the first proxy (nginx/Apache on VPS) so express-rate-limit reads
// the real client IP from X-Forwarded-For instead of always seeing 127.0.0.1.
app.set('trust proxy', 1);

// Record HTTP request duration on every response (Histogram). Mounted as
// early as possible so the timing covers any subsequent middleware too.
app.use(metrics.httpDurationMiddleware);

// ── Security: HTTPS enforcement (production only) ────────────────────────────
// In production, redirect any HTTP request to HTTPS. This is belt-and-suspenders
// since nginx/Caddy in front normally handles TLS, but it protects against
// misconfiguration where the proxy forwards HTTP traffic to the app.
// Honors X-Forwarded-Proto (set by reverse proxies). Skipped in dev for local testing.
//
// IMPORTANT: skip the redirect for localhost/127.0.0.1 — internal services
// (the Bruno worker fetches each company's datafile from
// http://localhost:PORT/data/...) must use plain HTTP because the app server
// itself does not terminate TLS — that is nginx/Caddy's job. Redirecting
// loopback traffic to https://localhost would fail with EPROTO since nothing
// is listening for TLS on the app port.
// Allow-list of hostnames the HTTPS-redirect handler will trust as redirect
// targets. Defense-in-depth against an attacker forging the Host: header to
// pivot the redirect to evil.com (Sonar S5146 open-redirect). nginx already
// restricts Host upstream in production, but this gives the app server its
// own guard. Comma-separated, case-insensitive. If empty (default), the
// previous behavior is preserved for backwards-compat — set this in any
// production deployment.
const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // /metrics is scraped by Prometheus over plain HTTP from inside the
    // Docker network using the internal hostname (oscar:3001). It is never
    // reached from the public internet — nginx returns 404 for /metrics
    // externally. Forcing HTTPS on this path produced a 301 → https://oscar/metrics
    // redirect loop because Prometheus can't speak TLS to the app port.
    if (req.path === '/metrics') return next();
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocalhost) return next();   // never redirect loopback traffic
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (proto !== 'https') {
      // Sonar S5146: validate Host: against the allow-list before redirecting.
      // If the operator did not configure an allow-list, fall back to the
      // historical behaviour (trust the Host header) so existing deployments
      // are not broken by the upgrade — but the warning is logged once.
      if (ALLOWED_REDIRECT_HOSTS.length > 0 && !ALLOWED_REDIRECT_HOSTS.includes(host)) {
        return res.status(400).set('Connection', 'close').send('Bad Request: invalid Host header');
      }
      // Sonar S5146 (second flow) — validate `req.url` too. With Host:
      // already allow-listed, the path component cannot pivot the redirect
      // to another origin in practice, but defense in depth: insist on a
      // safe local path (single leading "/", no protocol-relative "//evil",
      // no backslashes that can confuse downstream HTTP parsers / browsers).
      // Anything else falls back to "/".
      const safePath = (typeof req.url === 'string' && /^\/(?!\/)[^\\]*$/.test(req.url))
        ? req.url
        : '/';
      return res.redirect(301, `https://${host}${safePath}`);
    }
    next();
  });
}

// ── Security: HTTP headers (HSTS, X-Frame-Options, CSP, etc.) ────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],   // inline <script> blocks in HTML pages
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'https://uic.org', 'https://*.uic.org'],
      connectSrc:    ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ── Security: CORS — allowlist, and fail closed when none is set (S7-cors) ────
// An unset ALLOWED_ORIGINS used to reflect ANY origin with credentials. OSCAR is
// served same-origin, so with no allowlist we now permit no cross-origin at all
// (utils/corsPolicy); the same-origin app is unaffected. Set ALLOWED_ORIGINS to
// permit a cross-origin UI host.
const { corsOptions } = require('./utils/corsPolicy');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
if (ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV === 'production') {
  log.warn('ALLOWED_ORIGINS is not set — CORS is fail-closed (same-origin only). Set ALLOWED_ORIGINS to permit a cross-origin UI host.');
}
app.use(cors(corsOptions(ALLOWED_ORIGINS)));

app.use(express.json({ limit: '5mb' }));  // 5 MB — covers largest expected datafile
app.use(express.urlencoded({ extended: true }));

// ── File-download rate limiter (CodeQL js/missing-rate-limiting) ──────────────
// Both /data/:filename and /artifacts/:runId/:filename perform filesystem
// reads. Even though both are auth-gated, defence-in-depth caps the request
// rate so a leaked session token cannot be used to enumerate / scrape every
// vendor's reports at speed. The cap is generous (300 file fetches per
// minute per IP) so legitimate UI use — opening a multi-scenario report
// dashboard — never trips it.
const fileDownloadLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many file downloads in a short window. Slow down or wait a minute.' }
});

// ── Serve data files (Bruno fetches these during runs) ────────────────────────
// Route: GET /data/:filename  →  data/datafiles/:filename
//
// SECURITY (issue #60, v1.10.0; tracker S8-loopback, v1.11.210): previously
// served via express.static with no auth at all. Now requires EITHER:
//   (a) the per-run secret the runner issued for a live run, bound to that
//       run's company (the Bruno subprocess fetching this run's own file), OR
//   (b) an authenticated Test Manager session whose company owns the slug,
//       or is the distributor of the provider that owns it (#540).
// Until v1.11.210 (b)'s alternative was "any request from 127.0.0.1 with no
// X-Forwarded-For", which trusted the source address; that is gone.
const DATAFILES_DIR = path.resolve(__dirname, '../data/datafiles');

// Filename sanitiser: only allow `{slug}-datafile.json`-style names.
// Rejects anything containing path separators, parent traversal, or hidden
// dotfiles. The slug itself is taken from the filename and looked up in DB
// to confirm a company exists with that slug (defence in depth — even if
// the regex slips, the DB lookup catches forged inputs).
const SAFE_DATAFILE_RE = /^([a-z0-9][a-z0-9-]*)-datafile\.json$/;

// ── Per-run loopback auth (tracker S8-loopback) ──────────────────────────────
// Bruno carries a per-run secret issued by the runner (utils/runSecrets) and
// sends it on the two loopback calls below. This replaced the old gate, which
// trusted any request that arrived from 127.0.0.1 with no X-Forwarded-For —
// a single condition any co-located process, or any L4 proxy that does not
// inject X-Forwarded-For, could satisfy to read every tenant's datafile and a
// live vendor token. Trust is now the secret, not the source address, so
// nothing here reads req.ip.
const runSecrets = require('./utils/runSecrets');

// The authenticated fallback on GET /data: a signed-in Test Manager of the
// company that owns the slug. Returns null when allowed, else the HTTP status
// to answer with. Kept out of the handler so the handler stays simple.
function datafileSessionDenial(req, company) {
  let user;
  try {
    const cookieAuth = require('./api/middleware/auth');
    user = cookieAuth.userFromRequest(req);     // parsed JWT or null
  } catch { user = null; }                       // malformed token → treated as no session
  if (!user) return 401;
  if (user.role !== 'test_manager') return 403;  // testers read their filtered view from /v1/company/datafile
  // The owning company, or a provider of it (#540): the rule enforceTenant uses.
  const { canUseCompany } = require('./api/helpers/provider-access');
  if (!canUseCompany(user, company.id)) return 403;
  return null;
}

// ── Route: GET /json_validator/datafile.schema.json (#333, v1.11.112) ───────
// Serve the JSON schema bundled with the Bruno collection. Before this
// route, operators had to set JSON_SCHEMA_URL to an external URL (the
// default in .env.example pointed at a deprecated GitHub branch:
// UnionInternationalCheminsdeFer/OSDM-testing/refs/heads/exch_dev/…) that
// produced false-positive validation failures. Serving the schema locally
// removes the external dependency entirely — the schema always matches
// the running collection's expectations because they're shipped together.
//
// Public: no auth, no rate limiter beyond the global expressjs default.
// The file is a single static read from a path entirely under operator
// control (COLLECTION_PATH bind-mount); there's no user-controlled
// component in the resolved path, so path-traversal is not a vector.
// Cache the file aggressively (the collection only changes on deploy).
const COLLECTION_PATH_SAFE = path.resolve(process.env.COLLECTION_PATH || '/collection');
const SCHEMA_FILE_PATH     = path.join(COLLECTION_PATH_SAFE, 'json_validator', 'datafile.schema.json');
// Apply the same rate limiter we already use for /data/:filename
// (CodeQL js/missing-rate-limiting — file-system access behind a route
// should be rate-limited even if it's auth-less, to prevent abusive
// polling). 300/min is generous — the schema is fetched once per scenario
// run via the loopback Bruno subprocess.
app.get('/json_validator/datafile.schema.json', fileDownloadLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.sendFile(SCHEMA_FILE_PATH, err => {
    // CodeQL js/trivial-conditional — err is only present on failure;
    // check explicitly against null/undefined and inspect the structured
    // err code so the conditional has visible truthiness semantics.
    if (err != null) {
      log.warn({ errMsg: err.message, errCode: err.code, path: SCHEMA_FILE_PATH },
        '[schema-route] sendFile failed — collection bind-mount missing or schema file moved?');
      if (!res.headersSent) res.status(404).type('text/plain').send('schema file not found');
    }
  });
});

app.get('/data/:filename', fileDownloadLimiter, (req, res) => {
  const filename = String(req.params.filename || '');
  const m = SAFE_DATAFILE_RE.exec(filename);
  if (!m) return res.status(400).send('Bad request');

  const slug = m[1];
  const company = dbGet('SELECT id, slug, parent_id FROM companies WHERE slug = ?', [slug]);
  if (!company) return res.status(404).send('Not found');

  // (a) The Bruno subprocess of a live run: a per-run secret the runner issued,
  //     bound to that run's company (tracker S8-loopback). A run may only read
  //     its own company's file — a secret for company A asking for company B's
  //     slug gets 404 (no disclosure). The runId travels in a header because
  //     this route is keyed on the slug, not the run.
  const runCompanyId = runSecrets.verify(req.get('X-OSCAR-Run-Id'), req.get('X-OSCAR-Run-Secret'));
  if (runCompanyId !== null) {
    if (runCompanyId !== company.id) return res.status(404).send('Not found');
  } else {
    // (b) No run secret: fall back to a signed-in Test Manager of the owning
    //     company (datafileSessionDenial). No page calls this path; it is only
    //     reached directly, and no certifier / admin path exists — they consume
    //     reports through /v1/runs with the per-run share gate.
    const denied = datafileSessionDenial(req, company);
    // #540: a provider's slug is not public; its file must not reveal that it
    // exists, so every refusal on it reads as an unknown slug.
    if (denied && company.parent_id) return res.status(404).send('Not found');
    if (denied) return res.status(denied).send(denied === 401 ? 'Unauthorized' : 'Forbidden');
  }

  // Resolve, traversal-guard, decrypt, send.
  // The datafile is encrypted at rest (Phase 2 of issue #60). Bruno on the
  // loopback path receives plaintext over the localhost connection — at the
  // application layer it is identical to legacy plaintext on disk; the
  // protection is against sysadmins reading the raw file.
  const filePath = path.resolve(DATAFILES_DIR, filename);
  if (!filePath.startsWith(DATAFILES_DIR + path.sep)) {
    return res.status(400).send('Bad request');
  }
  const fs = require('node:fs');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  let plaintext;
  try {
    const { decryptFromFile } = require('./utils/at-rest');
    plaintext = decryptFromFile(filePath);
  } catch (err) {
    return res.status(500).send('Decryption failed: ' + err.message);
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(plaintext.length));
  return res.end(plaintext);
});

// ── Loopback refresh of an OAuth access token mid-run (issue #204) ───────────
// Long-running scenarios (e.g. expiredBookingTest's ~15 min wait on Paxone)
// can outlive the OAuth token issued at run start. The provider then returns
// 403 "not authenticated" on the next request, masking the booking-expiry
// semantics the test is trying to grade. Bruno calls this loopback endpoint
// AFTER the wait to obtain a fresh token; the provider then sees a valid
// token and the test can observe the actual expiry behaviour.
//
// SECURITY (tracker S8-loopback, v1.11.210): the caller MUST carry the run's
// own secret (utils/runSecrets), issued by the runner to the Bruno child and
// sent as the X-OSCAR-Run-Secret header. There is no session/Bearer auth
// (Bruno is a spawned child process). The secret is bound to the run's
// company, so it only refreshes the token of the run it was minted for; it
// never crosses run boundaries. Until v1.11.210 this was gated on the source
// address (127.0.0.1, no X-Forwarded-For) alone.
//
// The SAFE_RUNID_RE used below is defined further down for the
// /artifacts/:runId path — declared inline here so the order doesn't matter.
const SAFE_RUNID_RE_FOR_REFRESH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/v1/runs/:runId/refresh-access-token', fileDownloadLimiter, async (req, res) => {
  const { runId } = req.params;
  if (!SAFE_RUNID_RE_FOR_REFRESH.test(runId || '')) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Invalid runId format.' });
  }
  // S8-loopback: the run's own secret, not the source address. A missing or
  // wrong secret is a 403 — the run is identified by the path and the secret
  // together, so this never hands a token to a guessed runId.
  const runCompanyId = runSecrets.verify(runId, req.get('X-OSCAR-Run-Secret'));
  if (runCompanyId === null) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'This endpoint requires the run secret.' });
  }
  const runRow = dbGet('SELECT id, user_id, company_id FROM runs WHERE id = ?', [runId]);
  if (!runRow) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Run not found.' });
  }
  // Defence in depth: the secret was issued for this run's company. A mismatch
  // cannot happen through the runner, so treat it as a forgery, not a 404.
  if (runRow.company_id !== runCompanyId) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Run secret does not match the run.' });
  }
  // #540: the user must still be allowed to use the run's company — access
  // withdrawn mid-run stops new tokens here, as it refuses a queued run.
  const runRowFull = dbGet('SELECT * FROM runs WHERE id = ?', [runId]);
  const scopeRefusal = require('./worker/runner').refusedRunScope(runRowFull, runCompanyId, runRow.user_id);
  if (scopeRefusal) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: scopeRefusal });
  }
  // The credentials of the run's user for the run's company (#540).
  const { credentialsFor } = require('./utils/testerCredentials');
  const userRow = credentialsFor(runRow.user_id, runRow.company_id);
  if (!userRow) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User for this run not found.' });
  }
  // Query: ?force=1 / ?force=true → force a fresh fetch (skip the server-side
  // cache). Default (no query) → respect the cache (returns the cached token
  // when valid). This lets Bruno call us at scenario start as a cheap
  // refresh-if-needed check (#204 token-watchdog), AND call us with force=1
  // after a known long wait (the expired-booking test) to guarantee a fresh
  // token regardless of what the cache thinks.
  const force = req.query.force === '1' || String(req.query.force).toLowerCase() === 'true';
  try {
    const { resolveAccessToken } = require('./worker/access-token');
    const accessToken = await resolveAccessToken(
      userRow,
      { info: (m) => log.info({ runId }, m), error: (m) => log.error({ runId }, m) },
      { forceRefresh: force }
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ access_token: accessToken, forced: force });
  } catch (err) {
    const detail = err?.message ? err.message : String(err);
    log.error({ runId, err: detail }, '[refresh-access-token] resolveAccessToken failed');
    return res.status(502).json({ status: 502, title: 'Bad Gateway', detail: `Token refresh failed: ${detail}` });
  }
});

// ── Serve run artifacts (HTML reports, JSON results) ─────────────────────────
// Route: GET /artifacts/:runId/:filename
//
// SECURITY (issue #60, v1.10.0): previously served via express.static with no
// auth — anyone who guessed (or saw in a log) a run UUID could download the
// report. The "UUID is unguessable" defence was lazy: UUIDs leak into logs,
// browser history, screenshots, audit trails. Now every request is gated by
// the same per-run-ownership check used for the JSON results endpoint, which
// covers per-company tenant isolation AND the v1.10 per-run share-with-
// certifier flag (commit 2 of this PR).
const ARTIFACTS_DIR = path.resolve(__dirname, '../data/artifacts');
const SAFE_RUNID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/artifacts/:runId/:filename', fileDownloadLimiter, (req, res) => {
  const { runId, filename } = req.params;
  if (!SAFE_RUNID_RE.test(runId || '')) return res.status(400).send('Bad request');
  // Filename: report*.html, *.json, no path separators, no parent traversal
  if (!/^[A-Za-z0-9._-]+$/.test(filename || '')) return res.status(400).send('Bad request');

  let user;
  try {
    const cookieAuth = require('./api/middleware/auth');
    user = cookieAuth.userFromRequest(req);
  } catch (_e) { /* fall through to 401 */ }
  if (!user) return res.status(401).send('Unauthorized');

  // Reuse the same ownership-check the /v1/runs endpoints apply. A miss
  // returns 404 (not 403) so existence is not disclosed — same shape as
  // the existing v15 certifier privacy guard.
  const { canUserSeeRun } = require('./api/helpers/run-access');
  const run = canUserSeeRun(runId, user);
  if (!run) return res.status(404).send('Not found');

  // Resolve + path-traversal guard (defence in depth)
  const filePath = path.resolve(ARTIFACTS_DIR, runId, filename);
  if (!filePath.startsWith(ARTIFACTS_DIR + path.sep)) {
    return res.status(400).send('Bad request');
  }
  const fs = require('node:fs');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  // Phase 2 of issue #60 (v1.11.0): files are encrypted at rest with the
  // OSCAR1 envelope (AES-256-GCM). decryptFromFile() handles both the new
  // encrypted format AND legacy plaintext (no MAGIC header → returned
  // as-is) so artifacts written before v1.11 keep working without forced
  // re-encryption. The whole-file approach is fine because artifacts are
  // bounded (HTML reports < 1 MB) — small enough to buffer in memory.
  const { decryptFromFile } = require('./utils/at-rest');
  let plaintext;
  try {
    plaintext = decryptFromFile(filePath);
  } catch (err) {
    // AES-GCM tag failure is a security alert — likely tampering or key
    // mismatch. Surface a 500 (not 404) so an operator notices.
    require('./utils/logger').error({ err: err.message, runId, filename }, 'artifact decrypt failed');
    return res.status(500).send('Artifact decryption failed');
  }

  const isHtml = filename.toLowerCase().endsWith('.html');
  res.setHeader('Content-Type', isHtml ? 'text/html; charset=utf-8' : 'application/json');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', String(plaintext.length));
  return res.end(plaintext);
});

// ── Prometheus scrape endpoint ────────────────────────────────────────────────
// Returns the entire metrics registry in Prometheus exposition format.
// No auth on the route itself; nginx is configured to return 404 on /metrics
// for external requests, so only the Prometheus container in the same Docker
// network (which reaches OSCAR via the internal hostname `oscar:3001`) can
// actually scrape this. See Documentation/Server_Operations/metrics-and-monitoring.md.
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    log.error({ err: err.message }, 'Failed to render /metrics');
    res.status(500).send('# Failed to render metrics\n');
  }
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/v1/auth',            require('./api/routes/auth'));
app.use('/v1/me/credentials',  require('./api/routes/me-credentials'));
app.use('/v1/company/users',   require('./api/routes/company-users'));
app.use('/v1/company/providers', require('./api/routes/company-providers'));
app.use('/v1/company',         require('./api/routes/company'));
app.use('/v1/company',         require('./api/routes/company-test-framework'));
app.use('/v1/company',         require('./api/routes/company-test-resources'));
app.use('/v1/company',         require('./api/routes/company-places'));
app.use('/v1/company',         require('./api/routes/company-findings'));
app.use('/v1/runs',            require('./api/routes/runs'));
app.use('/v1/reports',         require('./api/routes/reports'));
app.use('/v1/admin',           require('./api/routes/admin'));

// ── OpenAPI / Swagger UI ──────────────────────────────────────────────────────
// Interactive API explorer at /v1/docs, raw spec at /v1/openapi.json.
// No auth required — the spec describes public endpoints, and individual
// endpoints still require their own auth when invoked.
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./api/openapi');
app.get('/v1/openapi.json', (req, res) => res.json(openapiSpec));
app.use('/v1/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'OSCAR API Docs',
  customCss: '.topbar { display: none }',
}));

// ── Health check ──────────────────────────────────────────────────────────────
// Returns 200 OK if all subsystems are healthy, 503 if any check fails.
// Useful for Docker/k8s liveness/readiness probes.
app.get('/health', (req, res) => {
  const queue_ = require('./worker/queue');
  const fs2 = require('node:fs');
  const checks = {};
  let overallOk = true;

  // 1. Database connectivity
  try {
    const row = dbGet('SELECT 1 AS ok');
    checks.database = { ok: !!row, status: 'ok' };
  } catch (err) {
    checks.database = { ok: false, status: 'error', error: err.message };
    overallOk = false;
  }

  // 2. Queue status
  checks.queue = { ok: true, depth: queue_.depth, running: queue_.running };

  // 3. Data directory writable
  try {
    const testFile = path.join(__dirname, '../data/.health-check');
    fs2.writeFileSync(testFile, 'ok');
    fs2.unlinkSync(testFile);
    checks.data_dir = { ok: true, status: 'writable' };
  } catch (err) {
    checks.data_dir = { ok: false, status: 'error', error: err.message };
    overallOk = false;
  }

  // 4. Disk space (Linux only)
  try {
    const stats = fs2.statfsSync ? fs2.statfsSync(path.resolve(__dirname, '..')) : null;
    if (stats) {
      const freeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
      checks.disk = { ok: freeMb > 100, free_mb: freeMb };
      if (freeMb <= 100) overallOk = false;
    } else {
      checks.disk = { ok: true, status: 'not_checked' };
    }
  } catch {
    // A failed disk check is reported, but it does not fail the health check.
    checks.disk = { ok: true, status: 'check_failed_non_critical' };
  }

  // 5. Process info
  const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  checks.process = {
    ok: true,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: memMb,
    node_version: process.version,
  };

  // 6. Version + compatibility (server / collection / release-label)
  const versionInfo = getVersionInfo();

  res.status(overallOk ? 200 : 503).json({
    status:  overallOk ? 'ok' : 'degraded',
    version: versionInfo.server_version,
    server_version:       versionInfo.server_version,
    collection_version:   versionInfo.collection_version,
    release_label:        versionInfo.release_label,
    compatibility_status: versionInfo.compatibility_status,
    checks,
  });
});

// ── Serve static UI ───────────────────────────────────────────────────────────
// #287: vanilla-jsoneditor (ISC) is **vendored** under public/vendor/ rather
// than installed as an npm dependency — keeps the dep tree (and package-lock)
// untouched and avoids re-resolving the whole graph for one front-end asset.
// The lazy `import('/vendor/vanilla-jsoneditor/standalone.js')` in run-detail.html
// is served by the same express.static below (CSP stays 'self', no extra mount).
const PUBLIC_DIR = path.resolve(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

// ── SPA shell rate limiter (CodeQL js/missing-rate-limiting) ─────────────────
// The fallback below stats and streams index.html from disk, so CodeQL sees
// filesystem access on an unauthenticated route and flags it — same rule,
// same remedy as `fileDownloadLimiter` above. It needs its OWN bucket rather
// than reusing that one: this is the entry point every browser navigation
// lands on, unauthenticated and shared by every tenant, so it must not draw
// down the same budget as report downloads. The cap is deliberately very
// generous (1200/min/IP = 20 page loads a second) because whole vendor teams
// reach OSCAR from one NATed office IP; it exists to bound a scripted flood,
// not to shape normal use. Only the HTML shell passes through here — static
// assets are served by express.static above and never reach this handler.
const spaShellLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many page loads in a short window. Slow down or wait a minute.' }
});

// SPA fallback — any unmatched GET returns index.html
app.get('/{*splat}', spaShellLimiter, (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ status: 404, title: 'Not Found' });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ status: 413, title: 'File Too Large', detail: 'Maximum upload size is 5 MB.' });
  }
  // Never expose internal error details to clients
  res.status(500).json({ status: 500, title: 'Internal Server Error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  log.info({ port: PORT, collection: process.env.COLLECTION_PATH, bru: process.env.BRU_CMD, dataDir: DATAFILES_DIR },
    'OSCAR — OSDM Conformance Automation Runner started');

  // ── Best-effort Alertmanager config seed (v1.9.0) ────────────────────────
  // If the operator has configured SMTP + ALERT_RECIPIENTS and the
  // alertmanager-config volume is mounted (env var present), template
  // alertmanager.yml from current DB values and try to reload Alertmanager.
  // Fire-and-forget — failure is logged but never blocks startup. The
  // common case where this matters: a fresh metrics-stack rollout with an
  // empty volume → without this, alertmanager would refuse to start
  // because there's no config file. With this, OSCAR seeds it on boot.
  if (process.env.ALERTMANAGER_CONFIG_PATH) {
    const amCfg = require('./utils/alertmanagerConfig');
    amCfg.applyConfig().then(r => {
      if (r.ok) log.info({ configPath: r.configPath }, 'Alertmanager config seeded + reloaded on startup');
      else log.warn({ result: r }, 'Alertmanager config seed on startup did not fully succeed (typically: SMTP/recipients not yet configured, or alertmanager not yet running) — admin can re-run via Server Config tab');
    }).catch(err => log.warn({ err: err.message }, 'Alertmanager config seed on startup threw'));
  }
});

module.exports = app;
