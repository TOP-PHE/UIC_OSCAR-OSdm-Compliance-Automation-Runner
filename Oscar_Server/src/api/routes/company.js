// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company.js — Company profile management routes
 *
 * GET    /v1/company                — get company profile (sanitised — no secrets)
 * PATCH  /v1/company                — update endpoint, auth mode, credentials, requestor
 * POST   /v1/company/datafile       — upload / replace the company data file (multipart)
 * PUT    /v1/company/datafile/json  — save the data file from the scenario editor
 * DELETE /v1/company/datafile       — remove the data file
 * GET    /v1/company/datafile       — serve data file download for browser
 */

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const { get, all, run, colDecrypt } = require('../../db/db');
const { annotateDatafile } = require('../../utils/frameworkGating');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope, requireTestManager, denyAdminAndCertifier } = require('../helpers/shared');
const { viewForTester, mergeTesterSave } = require('../../utils/datafileOwnership');
const { getRunSelection, setRunSelection } = require('../../utils/runSelections');
const { withDatafileLock } = require('../../utils/datafileLock');
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

// Read-side rate limiter for GET /datafile (CodeQL js/missing-rate-limiting).
// Even though the endpoint is auth-gated, a leaked session token shouldn't
// be usable to mass-download a datafile in a tight loop.
const datafileReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many datafile downloads in a short window.' }
});

// ── Datafile location ─────────────────────────────────────────────────────────
// One live file per company, data/datafiles/{slug}-datafile.json, always the
// OSCAR1 encrypted envelope. The slug comes from the companies row, never from
// the request; the prefix check keeps that property local to this function.
const DATAFILES_DIR = path.resolve(__dirname, '../../../data/datafiles');

function liveDatafilePath(slug) {
  const p = path.resolve(DATAFILES_DIR, `${slug}-datafile.json`);
  if (!p.startsWith(DATAFILES_DIR + path.sep)) {
    throw new Error('Datafile path escaped the datafiles directory.');
  }
  return p;
}

// ── Datafile write authorisation (S2 / S3, v1.11.195) ─────────────────────────
// Who may write a company's datafile, mounted as middleware so it runs BEFORE
// any body parsing. That ordering is the whole point for the multipart upload:
// multer used to run first, with a diskStorage whose filename WAS the live
// datafile, so the upload overwrote {slug}-datafile.json in plaintext before
// the role check ever ran. A tester, an administrator naming any company in
// ?company_id=, or a read-only certifier all got their 403 after the damage.
//
// Both policies below resolve to the caller's OWN company: they only admit
// non-platform roles, and resolveCompanyScope() ignores ?company_id= /
// X-Company-Id for those. Administrators and certifiers never write test data
// (issue #60), whichever route they try.
//
//   uploadPolicy — POST /datafile replaces the whole file with an arbitrary
//                  upload: Test Managers only, as it has always been.
//   savePolicy   — PUT /datafile/json is the scenario editor's Save & Apply.
//                  Testers need it: the Test Config page is on the tester menu,
//                  and it is how they author their own scenarios and choose
//                  scenariosToRun, which POST /v1/runs reads to decide what to
//                  run (Tester User Guide §4-5; Admin Guide §15.1 lists the
//                  datafile as "Tester + Test Manager of the owning company").
//                  Test-Manager-only here would stop every tester from
//                  running anything but the Test Manager's own selection.
//
// Not closed here, and deliberately so: a tester's save still replaces the
// whole file, so it can alter shared scenarios and other testers' private ones.
// The editor makes those read-only, but only in the browser. Enforcing it means
// merging per scenario on the server, which is a design change of its own.
const uploadPolicy = (req, res) => requireTestManager(req, res);
const savePolicy   = (req, res) => !denyAdminAndCertifier(req, res);

function authorizeDatafileWrite(policy) {
  return (req, res, next) => {
    if (!policy(req, res)) return;
    const targetCompanyId = resolveCompanyScope(req, res);
    if (targetCompanyId === null) return;
    if (!targetCompanyId) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company context resolved.' });
    }
    const company = get('SELECT id, slug FROM companies WHERE id = ?', [targetCompanyId]);
    if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
    req.datafileCompany = company;
    next();
  };
}

// ── Multer — datafile upload ──────────────────────────────────────────────────
// Memory storage, not disk: the upload is held in req.file.buffer until it has
// been authorised AND validated, and the only disk write is the atomic
// encrypted one in the handler. With diskStorage the upload landed on the live
// path first, so a rejected upload still replaced the file — and a failed
// validation then unlinked it, leaving the company with no datafile at all
// while companies.datafile_path still pointed at one. 5 MB is small enough to
// buffer; the limit still aborts before the whole body is read.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB max
  fileFilter: (req, file, cb) => {
    // Belt-and-braces: authorizeDatafileWrite must already have run. If this
    // parser is ever mounted without it, refuse rather than accept an upload
    // nobody has authorised.
    if (!req.datafileCompany || req.user.role !== 'test_manager') {
      return cb(new Error('Datafile upload reached the parser without authorisation.'));
    }
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
    id:                           c.id,
    name:                         c.name,
    slug:                         c.slug,
    api_base:                     c.api_base || null,
    datafile_hash:                c.datafile_hash || null,
    datafile_updated_at:          c.datafile_updated_at || null,
    // v1.11.15: the company-wide share_reports_with_certifier toggle was
    // retired. Certifier visibility is now per-report (the test_manager
    // shares individual runs from the dashboard). The DB column is kept for
    // backward compatibility but is no longer surfaced or writable here.
    extra_headers:                parseExtraHeaders(c.extra_headers),
    created_at:                   c.created_at,
    updated_at:                   c.updated_at
  };
}

// ── Dedicated headers (issue #426) ────────────────────────────────────────────
// Company-wide custom request headers — a JSON array of { name, value } stored
// on companies.extra_headers and injected on every OSDM request by the Bruno
// collection's before-request hook. value may be a literal or carry {{var}}
// templates resolved against the env at send time (e.g. {{requestor}},
// {{Ocp-Apim-Subscription-Key}}, {{access_token}}).
const MAX_EXTRA_HEADERS    = 25;
const MAX_HEADER_NAME_LEN  = 128;
const MAX_HEADER_VALUE_LEN = 4096;
// RFC 7230 field-name: a non-empty sequence of token characters.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function parseExtraHeaders(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// Validate + normalise an incoming extra_headers array. Drops rows whose name
// is blank (the UI may submit empty trailing rows). Returns either
// { ok: true, value: [{name,value}, ...] } or { ok: false, detail }.
function normalizeExtraHeaders(input) {
  if (!Array.isArray(input)) {
    return { ok: false, detail: 'extra_headers must be an array of { name, value } objects.' };
  }
  const rows = input.filter(h =>
    h && typeof h === 'object' && String(h.name == null ? '' : h.name).trim() !== '');
  if (rows.length > MAX_EXTRA_HEADERS) {
    return { ok: false, detail: `Too many dedicated headers (max ${MAX_EXTRA_HEADERS}).` };
  }
  const out = [];
  for (const h of rows) {
    const name  = String(h.name).trim();
    const value = h.value == null ? '' : String(h.value);
    if (name.length > MAX_HEADER_NAME_LEN || !HEADER_NAME_RE.test(name)) {
      return { ok: false, detail: `Invalid header name "${name}". Use a valid HTTP header token (letters, digits and !#$%&'*+-.^_\`|~).` };
    }
    if (/[\r\n]/.test(value)) {
      return { ok: false, detail: `Header "${name}" value must not contain CR or LF characters.` };
    }
    if (value.length > MAX_HEADER_VALUE_LEN) {
      return { ok: false, detail: `Header "${name}" value is too long (max ${MAX_HEADER_VALUE_LEN} characters).` };
    }
    out.push({ name, value });
  }
  return { ok: true, value: out };
}

// At-rest encryption for company datafiles (Phase 2 of issue #60, v1.11.0).
// Helpers used by the upload / JSON-save / serve paths below to keep the
// datafile encrypted on disk while preserving plaintext-content hashing.
const { encryptToFileAsync, decryptFromFileAsync } = require('../../utils/at-rest');

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
  const { api_base, extra_headers } = req.body || {};

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

  // v1.11.15: share_reports_with_certifier is no longer accepted here. If an
  // old client still sends it, fail loudly with a pointer to the new model
  // (per-report sharing from the dashboard) rather than silently ignoring it.
  if ('share_reports_with_certifier' in (req.body || {})) {
    return res.status(400).json({
      status: 400, title: 'Bad Request',
      detail: 'The company-wide share_reports_with_certifier toggle was removed in v1.11.15. Certifier visibility is now per-report — a test_manager shares individual runs from the dashboard (POST /v1/runs/:id/share).'
    });
  }

  // Dedicated headers (issue #426) — company-wide config, Test-Manager-only.
  // Validate before touching the row so a bad payload changes nothing.
  let normalizedExtra = null;
  if (extra_headers !== undefined) {
    if (req.user.role !== 'test_manager' && !isPlatformRole(req.user.role)) {
      return res.status(403).json({
        status: 403, title: 'Forbidden',
        detail: 'Only Test Managers can edit dedicated headers.'
      });
    }
    const norm = normalizeExtraHeaders(extra_headers);
    if (!norm.ok) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: norm.detail });
    }
    normalizedExtra = norm.value;
  }

  const updates = [];
  const values  = [];
  if (api_base) { updates.push('api_base = ?'); values.push(api_base.trim()); }
  if (extra_headers !== undefined) {
    // Store null (not "[]") when the list is emptied so the column reads clean.
    updates.push('extra_headers = ?');
    values.push(normalizedExtra.length ? JSON.stringify(normalizedExtra) : null);
  }

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

// ── POST /v1/company/datafile ─────────────────────────────────────────────────
// Order matters: authorizeDatafileWrite runs before upload.single, so nothing
// is parsed, buffered or written for a caller who may not write (S2).
router.post('/datafile', datafileMutationLimiter, authorizeDatafileWrite(uploadPolicy), upload.single('datafile'), async (req, res) => {
  const company = req.datafileCompany;

  if (!req.file) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No file uploaded. Use field name "datafile".' });
  }

  // Validate it's parseable JSON, hash the plaintext, then encrypt-and-store.
  // The hash is computed on plaintext so testers can independently verify
  // the contents (sha256 of the file they uploaded — the encryption is
  // transparent to them). The file on disk is the OSCAR1 envelope.
  const plaintext = req.file.buffer;
  try {
    JSON.parse(plaintext.toString('utf8'));
  } catch (_e) {
    // Nothing was written, so there is nothing to clean up — the previous
    // datafile is still the live one.
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Uploaded file is not valid JSON.' });
  }

  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  const livePath = liveDatafilePath(company.slug);
  // Atomic temp+rename inside the helper: a crash mid-write leaves the
  // previous datafile intact, which matters because Bruno reads it during runs.
  // Under the per-company lock so it cannot interleave with a tester's merge.
  try {
    await withDatafileLock(company.id, async () => {
      await encryptToFileAsync(plaintext, livePath);
      run(
        `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        [livePath, hash, company.id]
      );
    });
  } catch (err) {
    log.error({ err, companyId: company.id }, 'Failed to encrypt-write datafile');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file.' });
  }

  auditLog(req.user.id, company.id, req.user.email, 'datafile_uploaded');

  return res.json({
    filename:   path.basename(livePath),
    size:       plaintext.length,
    hash,
    uploaded_at: new Date().toISOString()
  });
});

// ── PUT /v1/company/datafile/json — save datafile as JSON body from UI ────────
// NOTE: body is already parsed by the global express.json({limit:'5mb'}) in
// server.js.  Do NOT add a second express.json() here — it would try to parse
// an already-consumed stream.
// S3 (v1.11.195): this route blocked certification_user and nobody else, so an
// administrator could rewrite ANY company's datafile by naming it in
// ?company_id= / X-Company-Id — a cross-tenant write, and a breach of issue #60.
// Now savePolicy: administrators and certifiers are refused, and testers and
// Test Managers write their own company only. See authorizeDatafileWrite for
// why testers keep this route and what that still leaves open.
router.put('/datafile/json', datafileMutationLimiter, authorizeDatafileWrite(savePolicy), async (req, res) => {
  const { id: targetCompanyId, slug } = req.datafileCompany;

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

  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  const filePath = liveDatafilePath(slug);
  const isTester = req.user.role === 'company_user';

  return withDatafileLock(targetCompanyId, async () => {
    // S3, second half (v1.11.197): a tester's save is merged into the stored
    // file rather than replacing it — only their own scenarios change, shared
    // and other people's scenarios stay exactly as stored, and what they tick
    // becomes their personal run list. See utils/datafileOwnership. A Test
    // Manager still saves the whole file.
    let toStore = body;
    let merge = null;
    if (isTester) {
      // The personal run list is keyed on the users row. A tester deleted while
      // their session is still open would otherwise have their save written
      // and then fail on that key — reported as "NOT saved" after the fact.
      if (!get('SELECT 1 AS ok FROM users WHERE id = ?', [req.user.id])) {
        return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'This account no longer exists. Sign in again.' });
      }
      let stored = {};
      const current = get('SELECT datafile_path FROM companies WHERE id = ?', [targetCompanyId]);
      if (current?.datafile_path && fs.existsSync(current.datafile_path)) {
        try {
          stored = JSON.parse((await decryptFromFileAsync(current.datafile_path)).toString('utf8'));
        } catch (err) {
          log.error({ err, companyId: targetCompanyId }, 'tester save: stored datafile unreadable — refusing to merge');
          return res.status(409).json({ status: 409, title: 'Conflict',
            detail: 'The stored data file cannot be read, so saving now could overwrite other people\'s scenarios. Ask your Test Manager to check it.' });
        }
      }
      merge = mergeTesterSave(stored, body, req.user.email);
      toStore = merge.datafile;
    }

    // Known-deviation projection (#398 / Test Findings register): knownDeviations[]
    // is server-managed — derived from the findings the test team has baselined
    // for runs — never hand-authored in the wizard. Overwrite whatever the client
    // sent so a datafile save can't wipe or tamper with it. Soft: a failure here
    // leaves the rest of the save intact.
    try {
      const { buildProjection } = require('../../utils/knownDeviationProjection');
      toStore.knownDeviations = buildProjection(targetCompanyId);
    } catch (err) {
      log.warn({ err: err.message, companyId: targetCompanyId }, 'datafile save: knownDeviations projection failed');
    }

    const content  = JSON.stringify(toStore, null, 4);
    // Hash the plaintext (so the hash matches the user-visible file content),
    // then encrypt at write — Phase 2 of issue #60. Atomic temp+rename in the
    // helper guarantees that a crash mid-write leaves the previous datafile
    // intact (matters because Bruno reads it during runs).
    try {
      await encryptToFileAsync(content, filePath);
    } catch (err) {
      log.error({ err, companyId: targetCompanyId }, 'Failed to encrypt-write datafile');
      return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file to disk.' });
    }

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    run(
      `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [filePath, hash, targetCompanyId]
    );
    // The file is saved at this point. A failure storing the run list must not
    // be reported as a failed save; the tester sees their previous list instead.
    let runListSaved = true;
    if (merge) {
      try { setRunSelection(targetCompanyId, req.user.id, merge.selection); }
      catch (err) {
        runListSaved = false;
        log.error({ err, companyId: targetCompanyId }, 'tester save: data file saved, personal run list not');
      }
    }

    // Return a summary so the UI can verify what was actually stored. For a
    // tester the counts describe their view and to_run is their own run list.
    const scenariosCount = merge ? viewForTester(toStore, req.user.email, merge.selection).scenarios.length : body.scenarios.length;
    const toRun = merge ? merge.selection : body.scenariosToRun;
    return res.json({
      filename:        path.basename(filePath),
      hash,
      saved_at:        new Date().toISOString(),
      scenarios_count: scenariosCount,
      to_run_count:    toRun.length,
      to_run:          toRun,
      ...(merge ? {
        // Shared scenarios a tester cannot change; the editor tells them their
        // edits to these were not kept.
        read_only_ignored: merge.ignoredReadOnly,
        // New scenarios of theirs whose code someone else's already used,
        // stored under a free code; the editor tells them the new name.
        renamed:           merge.renamed,
        resources_copied:  merge.forked.length,
        run_list_saved:    runListSaved,
      } : {}),
    });
  });
});

// ── DELETE /v1/company/datafile ───────────────────────────────────────────────
// v1.11.197: under the per-company lock like every other datafile writer. A
// tester's save or a findings re-projection already in flight would otherwise
// finish after the delete and write the whole old file back.
router.delete('/datafile', datafileMutationLimiter, authorizeDatafileWrite(uploadPolicy), async (req, res) => {
  const { id: targetCompanyId } = req.datafileCompany;
  await withDatafileLock(targetCompanyId, async () => {
    const company = get('SELECT datafile_path FROM companies WHERE id = ?', [targetCompanyId]);

    // Remove file from disk if it exists
    if (company.datafile_path && fs.existsSync(company.datafile_path)) {
      try { fs.unlinkSync(company.datafile_path); } catch (_) { /* ignore */ }
    }

    // Clear DB columns
    run(
      `UPDATE companies SET datafile_path = NULL, datafile_hash = NULL, datafile_updated_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      [targetCompanyId]
    );
  });

  auditLog(req.user.id, targetCompanyId, req.user.email, 'datafile_deleted');
  return res.json({ deleted: true, message: 'Test configuration data file deleted.' });
});

// ── GET /v1/company/datafile ──────────────────────────────────────────────────
router.get('/datafile', datafileReadLimiter, async (req, res) => {
  // Issue #60 (v1.10.0) — datafile is test data. Administrators no longer
  // have read access; certifiers never had a use case here.
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to company data files (issue #60).' });
  }

  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const company = get('SELECT datafile_path, slug FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company || !company.datafile_path || !fs.existsSync(company.datafile_path)) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No data file uploaded yet.' });
  }
  // Datafile is encrypted at rest (Phase 2 of issue #60). Decrypt before
  // streaming. The helper handles legacy plaintext files (no MAGIC header)
  // transparently.
  let plaintext;
  try { plaintext = await decryptFromFileAsync(company.datafile_path); }
  catch (err) {
    log.error({ err, companyId: targetCompanyId }, 'Failed to decrypt datafile');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Datafile decryption failed.' });
  }

  // ── #218 follow-up: framework-gating annotation ─────────────────────────
  // Each scenario whose armed field isn't declared in the current framework
  // gets `__featureNotDeclaredWarnings: [field, ...]` so the Bruno collection
  // can emit a [WARNING] log line at scenario load (golden rule: what's not
  // declared in the framework can't be tested). The on-disk file is NOT
  // changed; only the bytes served to the client are augmented. If the
  // framework can't be read for any reason we serve the raw datafile —
  // soft validation: the warning is best-effort, never blocks the run.
  let serveBytes = plaintext;

  // S3, second half (v1.11.197): a tester sees their own scenarios and the
  // shared ones — not other people's private scenarios — and their personal run
  // list in place of the company's scenariosToRun. See utils/datafileOwnership.
  // Test Managers get the whole file, as before. Bruno never comes through here:
  // it reads the unfiltered file from /data/:filename (server.js).
  let testerView = null;
  if (req.user.role === 'company_user') {
    let parsed = null;
    try { parsed = JSON.parse(plaintext.toString('utf8')); } catch (_) { /* not JSON: nothing to filter */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      testerView = viewForTester(parsed, req.user.email, getRunSelection(targetCompanyId, req.user.id));
      serveBytes = Buffer.from(JSON.stringify(testerView), 'utf8');
    }
  }

  try {
    const fwRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
    if (fwRow && fwRow.config) {
      let fwConfig = null;
      try { fwConfig = JSON.parse(colDecrypt(fwRow.config)); } catch (_) {}
      if (fwConfig) {
        const df = testerView || JSON.parse(plaintext.toString('utf8'));
        const { annotatedCount } = annotateDatafile(df, fwConfig);
        if (annotatedCount > 0) {
          log.info({ companyId: targetCompanyId, annotatedCount }, 'datafile: annotated scenarios with feature-not-declared warnings');
        }
        serveBytes = Buffer.from(JSON.stringify(df), 'utf8');
      }
    }
  } catch (err) {
    log.warn({ err, companyId: targetCompanyId }, 'datafile annotator failed — serving unannotated bytes');
    // Never fall back to the raw file for a tester: it holds the scenarios
    // their view leaves out.
    serveBytes = testerView ? Buffer.from(JSON.stringify(testerView), 'utf8') : plaintext;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${company.slug}-datafile.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(serveBytes.length));
  return res.end(serveBytes);
});

module.exports = router;
