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
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
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
queue.on('started',   ({ runId }) => log.info({ runId }, 'Run started'));
queue.on('completed', ({ runId, exitCode }) => log.info({ runId, exitCode }, 'Run completed'));
queue.on('failed',    ({ runId, error   }) => log.error({ runId, error }, 'Run failed'));

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Trust the first proxy (nginx/Apache on VPS) so express-rate-limit reads
// the real client IP from X-Forwarded-For instead of always seeing 127.0.0.1.
app.set('trust proxy', 1);

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
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocalhost) return next();   // never redirect loopback traffic
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (proto !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
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

// ── Security: CORS — restrict to allowed origins in production ───────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length > 0
    ? (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error('CORS blocked'))
    : true,  // dev fallback: allow all if ALLOWED_ORIGINS not configured
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));  // 5 MB — covers largest expected datafile
app.use(express.urlencoded({ extended: true }));

// ── Serve data files (Bruno fetches these during runs) ────────────────────────
// Route: GET /data/:filename  →  data/datafiles/:filename
const DATAFILES_DIR = path.resolve(__dirname, '../data/datafiles');
app.use('/data', express.static(DATAFILES_DIR));

// ── Serve run artifacts (HTML reports, JSON results) ─────────────────────────
// Route: GET /artifacts/:runId/:filename
// No auth required — the run UUID in the path is unguessable (128-bit random).
// This allows the browser to open HTML reports directly in a new tab.
const ARTIFACTS_DIR = path.resolve(__dirname, '../data/artifacts');
app.use('/artifacts', express.static(ARTIFACTS_DIR));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/v1/auth',            require('./api/routes/auth'));
app.use('/v1/me/credentials',  require('./api/routes/me-credentials'));
app.use('/v1/company',         require('./api/routes/company'));
app.use('/v1/company',         require('./api/routes/company-test-framework'));
app.use('/v1/company',         require('./api/routes/company-test-resources'));
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
  const fs2 = require('fs');
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
  } catch (_e) {
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
const PUBLIC_DIR = path.resolve(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback — any unmatched GET returns index.html
app.get('*', (req, res) => {
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
const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  log.info({ port: PORT, collection: process.env.COLLECTION_PATH, bru: process.env.BRU_CMD, dataDir: DATAFILES_DIR },
    'OSCAR — OSDM Conformance Automation Runner started');
});

module.exports = app;
