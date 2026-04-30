'use strict';

/**
 * company.js — Company profile management routes
 *
 * GET    /v1/company           — get company profile (sanitised — no secrets)
 * PATCH  /v1/company           — update endpoint, auth mode, credentials, requestor
 * POST   /v1/company/datafile  — upload / replace the company data file (multipart)
 * GET    /v1/company/datafile  — serve data file download for browser
 */

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const { get, all, run } = require('../../db/db');
const { requireAuth, isPlatformRole, isTestManagerOrAbove } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope } = require('../helpers/shared');
const log = require('../../utils/logger').child({ module: 'company' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

// ── Rate limiter for datafile write operations ────────────────────────────────
// Prevents a leaked session token from being used to hammer the filesystem.
// Limit is generous enough (20 uploads per 15 min) to not affect normal usage.
const datafileMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many datafile upload attempts. Please wait before trying again.' }
});

// ── Multer — datafile upload ───────────────────────────────────────────────────
// Files are stored as {slug}-datafile.json in data/datafiles/
function getRequestedCompanyId(req) {
  return req.query.company_id || req.headers['x-company-id'] || (req.body && req.body.company_id) || null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.resolve(__dirname, '../../../data/datafiles');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const companyId = isPlatformRole(req.user.role) ? getRequestedCompanyId(req) : req.user.companyId;
    const company = companyId ? get('SELECT slug FROM companies WHERE id = ?', [companyId]) : null;
    if (!company) return cb(new Error('Valid company_id is required for datafile upload.'));
    cb(null, `${company.slug}-datafile.json`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are accepted.'));
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeCompany(c) {
  // Company-level fields only. Per-tester credentials live on the user row
  // since v12 — see GET /v1/me/credentials for the auth profile.
  return {
    id:                  c.id,
    name:                c.name,
    slug:                c.slug,
    api_base:            c.api_base || null,
    datafile_hash:       c.datafile_hash || null,
    datafile_updated_at: c.datafile_updated_at || null,
    created_at:          c.created_at,
    updated_at:          c.updated_at
  };
}

function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── GET /v1/company ───────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  if (isPlatformRole(req.user.role) && !targetCompanyId) {
    const companies = all('SELECT * FROM companies ORDER BY created_at DESC LIMIT 200').map(safeCompany);
    return res.json({ companies });
  }

  const company = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found' });
  return res.json(safeCompany(company));
});

// ── PATCH /v1/company ─────────────────────────────────────────────────────────
router.patch('/', (req, res) => {
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  if (isPlatformRole(req.user.role) && !targetCompanyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'company_id is required for platform users.' });
  }

  // PATCH /v1/company now only handles company-shared fields. Per-tester
  // credentials moved to /v1/me/credentials in v12 — see me-credentials.js.
  const { api_base } = req.body || {};

  const company = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found' });

  // Reject any leftover credential field with a clear pointer to the new
  // endpoint so old API clients fail loudly instead of silently dropping.
  const STRAY_AUTH_FIELDS = ['auth_mode', 'token_url', 'oauth_profile', 'oauth_scope',
    'oauth_extra', 'oauth_custom_template', 'access_token', 'client_id', 'client_secret',
    'requestor', 'subscription_key'];
  const stray = STRAY_AUTH_FIELDS.filter(k => k in (req.body || {}));
  if (stray.length > 0) {
    return res.status(400).json({
      status: 400, title: 'Bad Request',
      detail: `Per-tester credentials moved to PATCH /v1/me/credentials in v12. Field${stray.length > 1 ? 's' : ''} not accepted here: ${stray.join(', ')}.`
    });
  }

  const updates = [];
  const values  = [];
  if (api_base) { updates.push('api_base = ?'); values.push(api_base.trim()); }

  if (updates.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No fields to update.' });
  }

  updates.push('updated_at = datetime(\'now\')');
  values.push(targetCompanyId);

  run(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);

  // Audit: log company configuration changes
  const changedFields = updates.filter(u => !u.startsWith('updated_at')).map(u => u.split(' = ')[0]);
  auditLog(req.user.id, targetCompanyId, req.user.email, `company_update:${changedFields.join(',')}`);

  const updated = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  return res.json(safeCompany(updated));
});

// ── Role guard: test config write operations require test_manager or above ────
function requireTestManager(req, res) {
  if (!isTestManagerOrAbove(req.user.role) && !isPlatformRole(req.user.role)) {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers can modify test configuration.' });
    return false;
  }
  return true;
}

// ── POST /v1/company/datafile ─────────────────────────────────────────────────
router.post('/datafile', datafileMutationLimiter, upload.single('datafile'), (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  if (isPlatformRole(req.user.role) && !targetCompanyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'company_id is required for platform users.' });
  }

  if (!req.file) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No file uploaded. Use field name "datafile".' });
  }

  // Validate it's parseable JSON
  try {
    JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
  } catch (_e) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Uploaded file is not valid JSON.' });
  }

  const hash = fileHash(req.file.path);
  run(
    `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [req.file.path, hash, targetCompanyId]
  );

  auditLog(req.user.id, targetCompanyId, req.user.email, 'datafile_uploaded');

  return res.json({
    filename:   req.file.filename,
    size:       req.file.size,
    hash,
    uploaded_at: new Date().toISOString()
  });
});

// ── PUT /v1/company/datafile/json — save datafile as JSON body from UI ────────
// NOTE: body is already parsed by the global express.json({limit:'5mb'}) in
// server.js.  Do NOT add a second express.json() here — it would try to parse
// an already-consumed stream.
router.put('/datafile/json', datafileMutationLimiter, async (req, res) => {
  // Resolve company scope — same pattern as other routes
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot modify the data file.' });
  }

  let targetCompanyId;
  if (isPlatformRole(req.user.role)) {
    // Admin must pass ?company_id= or X-Company-Id header
    targetCompanyId = req.companyId;  // set by enforceTenant
    if (!targetCompanyId) {
      return res.status(400).json({
        status: 400, title: 'Bad Request',
        detail: 'Administrators must supply company_id (query param or X-Company-Id header) to save a data file.'
      });
    }
  } else {
    targetCompanyId = req.user.companyId;
  }

  if (!targetCompanyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company context resolved.' });
  }

  // Validate body
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Request body must be a JSON object.' });
  }
  if (!Array.isArray(body.scenarios)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'datafile must contain a "scenarios" array.' });
  }
  if (!Array.isArray(body.scenariosToRun)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'datafile must contain a "scenariosToRun" array.' });
  }

  const company = get('SELECT slug, datafile_path FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });

  const dir = path.resolve(__dirname, '../../../data/datafiles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${company.slug}-datafile.json`);
  const content  = JSON.stringify(body, null, 4);
  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
  } catch (err) {
    log.error({ err, companyId: targetCompanyId }, 'Failed to write datafile to disk');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file to disk.' });
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  run(
    `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [filePath, hash, targetCompanyId]
  );

  // Return a summary so the UI can verify what was actually stored
  return res.json({
    filename:        `${company.slug}-datafile.json`,
    hash,
    saved_at:        new Date().toISOString(),
    scenarios_count: body.scenarios.length,
    to_run_count:    body.scenariosToRun.length,
    to_run:          body.scenariosToRun
  });
});

// ── DELETE /v1/company/datafile ───────────────────────────────────────────────
router.delete('/datafile', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  if (isPlatformRole(req.user.role) && !targetCompanyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'company_id is required.' });
  }

  const company = get('SELECT slug, datafile_path FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found' });

  // Remove file from disk if it exists
  if (company.datafile_path && fs.existsSync(company.datafile_path)) {
    try { fs.unlinkSync(company.datafile_path); } catch (_) { /* ignore */ }
  }

  // Clear DB columns
  run(
    `UPDATE companies SET datafile_path = NULL, datafile_hash = NULL, datafile_updated_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    [targetCompanyId]
  );

  auditLog(req.user.id, targetCompanyId, req.user.email, 'datafile_deleted');
  return res.json({ deleted: true, message: 'Test configuration data file deleted.' });
});

// ── GET /v1/company/datafile ──────────────────────────────────────────────────
router.get('/datafile', (req, res) => {
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  if (isPlatformRole(req.user.role) && !targetCompanyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'company_id is required for platform users.' });
  }

  const company = get('SELECT datafile_path, slug FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company || !company.datafile_path || !fs.existsSync(company.datafile_path)) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No data file uploaded yet.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${company.slug}-datafile.json"`);
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(company.datafile_path).pipe(res);
});

module.exports = router;
