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
 * GET    /v1/company/datafile/download         — the file to save: stored bytes, or a tester's marked view (#549)
 * GET    /v1/company/datafile/previous         — what an upload replaced, if anything (#549)
 * POST   /v1/company/datafile/previous/restore — put it back (#549)
 */

const express   = require('express');
const path      = require('node:path');
const fs        = require('node:fs');
const crypto    = require('node:crypto');
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const { get, all, run, colDecrypt, colEncrypt } = require('../../db/db');
const { annotateDatafile } = require('../../utils/frameworkGating');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope, requireTestManager, denyAdminAndCertifier, companyEndpointChange, familyEndpointClash } = require('../helpers/shared');
const { viewForTester, mergeTesterSave } = require('../../utils/datafileOwnership');
const { templatesAddedBy, saveRefusal } = require('../../utils/datafileTemplates');
const { storedUrlRefusal } = require('../../utils/urlPolicy');
const { getRunSelection, setRunSelection } = require('../../utils/runSelections');
const { withDatafileLock } = require('../../utils/datafileLock');
const { datafileVersion, etag, staleSaveRefusal } = require('../../utils/datafileVersion');
const { schemaProblems, loadDatafileSchema } = require('../../utils/datafileSchema');
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
// One live file per company, data/datafiles/{slug}-datafile.json: see
// utils/datafileWrite.js, which also stores the files the server builds.
const { writeDatafile, liveDatafilePath, previousDatafilePath, DATAFILES_DIR } = require('../../utils/datafileWrite');

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
      cb(new UploadRefusal('Only JSON files are accepted.'));
    }
  }
});

// #549: a refusal of the parser is the client's mistake and is answered 400
// with its reason. It used to reach the global error handler, which only knows
// the size limit, and answered 500 "Internal Server Error".
class UploadRefusal extends Error {}

function parseUpload(req, res, next) {
  upload.single('datafile')(req, res, err => {
    if (!err) return next();
    if (err instanceof UploadRefusal) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: err.message });
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ status: 413, title: 'File Too Large', detail: 'Maximum upload size is 5 MB.' });
      }
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: `The upload could not be read (${err.code}). Send one file in the field "datafile".` });
    }
    return next(err);
  });
}

// ── What a download that is not the stored file carries (#549) ───────────────
// A tester's download is their view of the file (utils/datafileOwnership):
// their scenarios, the shared ones and their own run list. Uploaded as the
// company's file it would remove colleagues' private scenarios and replace the
// company run list, so it carries this root key and the upload refuses it.
// The schema allows extra root keys, and a tester's save never writes a
// company-level key, so the marker goes nowhere else.
const PERSONAL_VIEW_KEY = '__oscarPersonalView';
// Test Config's "Download unsaved edits" (public/js/scenarios.js) marks its
// copy of the page the same way: it is not the stored file either.
const NOT_THE_COMPANY_FILE = Object.freeze({
  [PERSONAL_VIEW_KEY]: 'This file is a tester\'s personal view of the data file, downloaded from Test Config: it leaves out other testers\' private scenarios and carries one person\'s run list. It cannot replace the company data file. Download the file as a Test Manager instead.',
  __oscarUnsavedEdits: 'This file is a copy of the Test Config page with edits that were not saved, not a data file downloaded from the server. It cannot replace the company data file. Save the edits in Test Config instead.',
});

function notTheCompanyFile(uploaded) {
  if (!uploaded || typeof uploaded !== 'object' || Array.isArray(uploaded)) return null;
  const key = Object.keys(NOT_THE_COMPANY_FILE).find(k => Object.hasOwn(uploaded, k));
  return key ? NOT_THE_COMPANY_FILE[key] : null;
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function scenarioCount(datafile) {
  return Array.isArray(datafile?.scenarios) ? datafile.scenarios.length : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Dedicated-header values are vendor secrets (S6). They are decrypted here only
// to be handed to the owning Test Manager (who set them and needs them to
// edit); for every other caller — a platform administrator, a tester, a
// certifier, and the platform list-all path — the value is withheld and only
// the name + whether a value is set is returned. The run engine reads the
// decrypted values straight from the DB, never from this response.
function maskHeaderValues(headers) {
  return headers.map(h => ({ name: h.name, value: '', has_value: h.value != null && String(h.value) !== '' }));
}

function safeCompany(c, canSeeHeaderValues = false) {
  // Company-level fields only. Per-tester credentials live on the user row
  // since v12 — see GET /v1/me/credentials for the auth profile.
  const headers = parseExtraHeaders(colDecrypt(c.extra_headers));
  return {
    id:                           c.id,
    name:                         c.name,
    slug:                         c.slug,
    parent_id:                    c.parent_id || null,   // #540: set for a provider
    api_base:                     c.api_base || null,
    datafile_hash:                c.datafile_hash || null,
    datafile_updated_at:          c.datafile_updated_at || null,
    // v1.11.15: the company-wide share_reports_with_certifier toggle was
    // retired. Certifier visibility is now per-report (the test_manager
    // shares individual runs from the dashboard). The DB column is kept for
    // backward compatibility but is no longer surfaced or writable here.
    extra_headers:                canSeeHeaderValues ? headers : maskHeaderValues(headers),
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
  } catch {
    // Not valid JSON: treated as no extra headers.
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
    // Platform list-all: header values are withheld (the S6 bulk-leak path).
    // `.map(safeCompany)` would pass the array index as canSeeHeaderValues — be
    // explicit and keep it false.
    const companies = all('SELECT * FROM companies ORDER BY created_at DESC LIMIT 200').map(c => safeCompany(c, false));
    return res.json({ companies });
  }

  const company = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found' });
  // Only the owning Test Manager gets the header values back (to edit them).
  return res.json(safeCompany(company, req.user.role === 'test_manager'));
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

  // The endpoint (#544) — only a Test Manager changes it; decided before
  // anything is written. The rule is companyEndpointChange() in shared.js.
  const endpoint = companyEndpointChange(req.user.role, api_base, company.api_base);
  if (endpoint.status) {
    return res.status(endpoint.status).json({
      status: endpoint.status,
      title: endpoint.status === 403 ? 'Forbidden' : 'Bad Request',
      detail: endpoint.detail
    });
  }
  // S5: an endpoint that is actually changing must be a public https address —
  // not loopback, the private network or a Docker service name. Structural only
  // here (no DNS in the request path); the runner re-checks, with DNS, at use.
  if (endpoint.write !== null) {
    const urlRefusal = storedUrlRefusal(endpoint.write, 'OSDM endpoint');
    if (urlRefusal) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: urlRefusal });
    }
  }
  // #540: within a distributor and its providers, one endpoint per company,
  // unless the Test Manager confirms the duplicate (audited below).
  let duplicateOf = null;
  if (endpoint.write !== null && endpoint.write !== company.api_base) {
    duplicateOf = familyEndpointClash(company.id, company.parent_id, endpoint.write);
    if (duplicateOf && req.body?.allow_duplicate_endpoint !== true) {
      return res.status(409).json({ status: 409, title: 'Conflict',
        detail: `This OSDM endpoint is already used by ${duplicateOf}. Send allow_duplicate_endpoint: true to use it anyway.` });
    }
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
  if (endpoint.write !== null) { updates.push('api_base = ?'); values.push(endpoint.write); }
  if (extra_headers !== undefined) {
    // Store null (not "[]") when the list is emptied so the column reads clean.
    // S6: encrypt at rest — these values may be vendor API keys. colDecrypt
    // reads both this and any legacy plaintext row (migration 27 backfills).
    updates.push('extra_headers = ?');
    values.push(normalizedExtra.length ? colEncrypt(JSON.stringify(normalizedExtra)) : null);
  }

  if (updates.length === 0) {
    // A tester who only sent back the stored endpoint asked for no change.
    if (endpoint.echoed) return res.json(safeCompany(company));
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No fields to update.' });
  }

  updates.push('updated_at = datetime(\'now\')');
  values.push(targetCompanyId);

  run(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);

  // Audit: log company configuration changes
  const changedFields = updates.filter(u => !u.startsWith('updated_at')).map(u => u.split(' = ')[0]);
  auditLog(req.user.id, targetCompanyId, req.user.email, `company_update:${changedFields.join(',')}`);
  if (duplicateOf) auditLog(req.user.id, targetCompanyId, req.user.email, 'company_update:api_base:duplicate_endpoint_confirmed');

  const updated = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  // The owning Test Manager sees the values back (they just set them); an
  // administrator editing cross-company does not.
  return res.json(safeCompany(updated, req.user.role === 'test_manager'));
});

// ── The datafile as stored now, for the template rule (NEW-10) ───────────────
// What a write is compared with: only text the write adds or changes is looked
// at (utils/datafileTemplates.js). A file that is missing or cannot be read
// counts as empty, so the write is then looked at whole. Call under the lock.
async function storedDatafileOrEmpty(companyId) {
  const current = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!current?.datafile_path || !fs.existsSync(current.datafile_path)) return {};
  try {
    return JSON.parse((await decryptFromFileAsync(current.datafile_path)).toString('utf8'));
  } catch {
    return {};
  }
}

// ── The version of the stored file as this person sees it (#540) ─────────────
// What GET sends as its ETag and a save is checked against (utils/datafileVersion).
// null when there is no file; a file that cannot be decrypted has a version no
// page can hold, so a save that names one is refused. Call under the lock.
function viewerOf(req, companyId) {
  return req.user.role === 'company_user'
    ? { role: 'company_user', email: req.user.email, selection: getRunSelection(companyId, req.user.id) }
    : { role: req.user.role };
}

async function storedVersion(companyId, viewer) {
  const current = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!current?.datafile_path || !fs.existsSync(current.datafile_path)) return null;
  try {
    return datafileVersion(await decryptFromFileAsync(current.datafile_path), viewer);
  } catch {
    return 'unreadable';
  }
}

// ── The stored file, read for a write that replaces it (#549) ────────────────
// { plain, parsed }: plain is null when there is no file, parsed is {} when it
// is not a JSON object (the template rule then looks at the write whole). A
// file that cannot be decrypted throws, unless `unreadableIsNone`.
async function currentDatafile(companyId, unreadableIsNone) {
  const current = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  let plain = null;
  if (current?.datafile_path && fs.existsSync(current.datafile_path)) {
    try { plain = await decryptFromFileAsync(current.datafile_path); }
    catch (err) {
      if (!unreadableIsNone) throw err;
      log.warn({ err, companyId }, 'datafile upload: the file replaced cannot be read and is not kept');
    }
  }
  let parsed = {};
  try { if (plain) parsed = JSON.parse(plain.toString('utf8')); } catch { parsed = {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  return { plain, parsed };
}

// The write of an upload, under the lock: the template rule (NEW-10), then the
// file replaced is kept, then the upload is stored. Keeping comes first: if it
// fails, nothing is replaced. Atomic temp+rename inside the writer: a crash
// mid-write leaves the previous datafile intact, which matters because Bruno
// reads it during runs. Returns { refusal } or { previous }.
async function storeUpload(company, plaintext, uploaded, hash) {
  const current = await currentDatafile(company.id, true);
  const refusal = saveRefusal(templatesAddedBy(current.parsed, uploaded));
  if (refusal) return { refusal };
  let previous = null;
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  if (current.plain) {
    await encryptToFileAsync(current.plain, previousDatafilePath(company.slug));
    previous = {
      hash: crypto.createHash('sha256').update(current.plain).digest('hex'),
      scenarios_count: scenarioCount(current.parsed),
    };
  }
  const livePath = liveDatafilePath(company.slug);
  await encryptToFileAsync(plaintext, livePath);
  run(
    `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [livePath, hash, company.id]
  );
  return { previous };
}

// ── POST /v1/company/datafile ─────────────────────────────────────────────────
// Order matters: authorizeDatafileWrite runs before the parser, so nothing
// is parsed, buffered or written for a caller who may not write (S2).
//
// #549: an upload replaces the data file and nothing else, and only with a
// data file. Before anything is replaced it must be JSON, not a download that
// is not the stored file (NOT_THE_COMPANY_FILE), pass the checks the runs apply
// (utils/datafileSchema) and add no template (NEW-10). The file it replaces is
// kept as the company's previous file, which GET /datafile/previous describes
// and POST /datafile/previous/restore puts back. The uploaded bytes are stored
// as they are, so a Test Manager's download uploaded again changes nothing,
// hash included. Not checked against If-Match (#540): an upload replaces the
// whole file on purpose.
router.post('/datafile', datafileMutationLimiter, authorizeDatafileWrite(uploadPolicy), parseUpload, async (req, res) => {
  const company = req.datafileCompany;
  const refuse = (detail, extra) => res.status(400).json({ status: 400, title: 'Bad Request', detail, ...extra });

  if (!req.file) {
    return refuse('No file uploaded. Use field name "datafile".');
  }

  // The hash is computed on plaintext so testers can independently verify
  // the contents (sha256 of the file they uploaded — the encryption is
  // transparent to them). The file on disk is the OSCAR1 envelope.
  const plaintext = req.file.buffer;
  let uploaded;
  try {
    uploaded = JSON.parse(plaintext.toString('utf8'));
  } catch {
    // Nothing was written, so there is nothing to clean up — the previous
    // datafile is still the live one.
    return refuse('Uploaded file is not valid JSON.');
  }
  const markedRefusal = notTheCompanyFile(uploaded);
  if (markedRefusal) return refuse(markedRefusal);

  let schema;
  try {
    schema = loadDatafileSchema();
  } catch (err) {
    log.error({ err, companyId: company.id }, 'datafile upload: schema not readable — refusing the upload');
    return res.status(503).json({ status: 503, title: 'Service Unavailable',
      detail: 'The data file schema could not be read, so the file cannot be checked. Nothing was changed.' });
  }
  const { problems, more } = schemaProblems(uploaded, schema);
  if (problems.length) {
    return refuse(`This file is not a valid data file: ${problems.length}${more ? ' or more' : ''} problem(s), the first being: ${problems[0]} Nothing was changed.`,
      { problems, problems_truncated: more });
  }

  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const livePath = liveDatafilePath(company.slug);
  // Under the per-company lock so it cannot interleave with a tester's merge.
  let outcome;
  try {
    outcome = await withDatafileLock(company.id, () => storeUpload(company, plaintext, uploaded, hash));
  } catch (err) {
    log.error({ err, companyId: company.id }, 'Failed to encrypt-write datafile');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file.' });
  }
  if (outcome.refusal) {
    return refuse(outcome.refusal);
  }

  auditLog(req.user.id, company.id, req.user.email, 'datafile_uploaded');

  return res.json({
    filename:        path.basename(livePath),
    size:            plaintext.length,
    hash,
    uploaded_at:     new Date().toISOString(),
    scenarios_count: scenarioCount(uploaded),
    // What the upload replaced, now the previous file; null when there was none.
    previous:        outcome.previous,
  });
});

// ── GET /v1/company/datafile/download (#549) ─────────────────────────────────
// The file Test Config's "Download JSON" saves. For a Test Manager, the stored
// file byte for byte: no annotation, no re-indenting, so uploading it again
// changes nothing. For a tester, their view (as GET /datafile gives it, without
// the annotation), marked as a personal view so that the upload refuses it.
// The name says which company, which day and, for a tester, that it is a view.
router.get('/datafile/download', datafileReadLimiter, authorizeDatafileWrite(savePolicy), async (req, res) => {
  const { id: companyId, slug } = req.datafileCompany;
  const current = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!current?.datafile_path || !fs.existsSync(current.datafile_path)) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No data file uploaded yet.' });
  }
  let bytes;
  try { bytes = await decryptFromFileAsync(current.datafile_path); }
  catch (err) {
    log.error({ err, companyId }, 'Failed to decrypt datafile');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Datafile decryption failed.' });
  }
  let filename = `${slug}-datafile-${utcDate()}.json`;
  if (req.user.role === 'company_user') {
    let parsed = null;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Never the raw file for a tester: it holds what their view leaves out.
      return res.status(409).json({ status: 409, title: 'Conflict',
        detail: 'The stored data file cannot be read. Ask your Test Manager to check it.' });
    }
    const view = viewForTester(parsed, req.user.email, getRunSelection(companyId, req.user.id));
    const marked = {
      [PERSONAL_VIEW_KEY]: {
        note: 'A tester\'s personal view of the company data file: their own scenarios, the shared ones and their own run list. It cannot be uploaded as the company data file.',
        company: slug,
        downloaded_by: req.user.email,
        downloaded_at: new Date().toISOString(),
      },
      ...view,
    };
    bytes = Buffer.from(JSON.stringify(marked, null, 4), 'utf8');
    filename = `${slug}-datafile-personal-view-${utcDate()}.json`;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(bytes.length));
  return res.end(bytes);
});

// ── The previous data file (#549) ─────────────────────────────────────────────
// What the last upload (or restore) replaced. Test Managers only, like the
// upload. Read under the lock, as every writer of these files holds it.
async function readPreviousDatafile(slug) {
  const file = previousDatafilePath(slug);
  if (!fs.existsSync(file)) return null;
  const plain = await decryptFromFileAsync(file);
  let parsed = null;
  try { parsed = JSON.parse(plain.toString('utf8')); } catch { parsed = null; }
  return { plain, parsed, replacedAt: fs.statSync(file).mtime.toISOString() };
}

router.get('/datafile/previous', datafileReadLimiter, authorizeDatafileWrite(uploadPolicy), async (req, res) => {
  const { id: companyId, slug } = req.datafileCompany;
  let prev;
  try { prev = await withDatafileLock(companyId, () => readPreviousDatafile(slug)); }
  catch (err) {
    log.error({ err, companyId }, 'previous datafile unreadable');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The previous data file cannot be read.' });
  }
  if (!prev) return res.json({ exists: false });
  return res.json({
    exists:          true,
    hash:            crypto.createHash('sha256').update(prev.plain).digest('hex'),
    size:            prev.plain.length,
    replaced_at:     prev.replacedAt,
    scenarios_count: scenarioCount(prev.parsed),
  });
});

// Restoring swaps the two files, so a restore can itself be undone. The file
// restored was the company's file once and is put back as it was (bytes and
// hash); the template rule (NEW-10) still applies, as to every write. Under
// the lock; returns { status, detail } or the restored file's summary.
async function restorePrevious(companyId, slug) {
  const prev = await readPreviousDatafile(slug);
  if (!prev) return { status: 404, detail: 'There is no previous data file to restore.' };
  if (!prev.parsed || typeof prev.parsed !== 'object' || Array.isArray(prev.parsed)) {
    return { status: 409, detail: 'The previous data file is not a JSON object and cannot be restored.' };
  }
  const current = await currentDatafile(companyId, false);
  const refusal = saveRefusal(templatesAddedBy(current.parsed, prev.parsed));
  if (refusal) return { status: 400, detail: refusal };

  const livePath = liveDatafilePath(slug);
  const prevPath = previousDatafilePath(slug);
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  await encryptToFileAsync(prev.plain, livePath);
  if (current.plain) await encryptToFileAsync(current.plain, prevPath);
  else fs.rmSync(prevPath, { force: true });
  const hash = crypto.createHash('sha256').update(prev.plain).digest('hex');
  run(
    `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [livePath, hash, companyId]
  );
  return { status: 200, hash, scenarios_count: scenarioCount(prev.parsed), previous_kept: !!current.plain };
}

router.post('/datafile/previous/restore', datafileMutationLimiter, authorizeDatafileWrite(uploadPolicy), async (req, res) => {
  const { id: companyId, slug } = req.datafileCompany;
  let outcome;
  try {
    outcome = await withDatafileLock(companyId, () => restorePrevious(companyId, slug));
  } catch (err) {
    log.error({ err, companyId }, 'Failed to restore the previous datafile');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The previous data file could not be restored.' });
  }
  if (outcome.status !== 200) {
    const title = { 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict' }[outcome.status];
    return res.status(outcome.status).json({ status: outcome.status, title, detail: outcome.detail });
  }
  auditLog(req.user.id, companyId, req.user.email, 'datafile_restored');
  return res.json({ restored: true, hash: outcome.hash, scenarios_count: outcome.scenarios_count, previous_kept: outcome.previous_kept });
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
    // #540: a save made from a data file that is no longer the current one is
    // refused, not written over what was saved in between. The page sends the
    // ETag of the file it loaded (If-Match), or If-None-Match: * when it loaded
    // none. A save with neither header goes ahead, as before this release.
    const staleRefusal = staleSaveRefusal(
      { ifMatch: req.get('If-Match'), ifNoneMatch: req.get('If-None-Match') },
      await storedVersion(targetCompanyId, viewerOf(req, targetCompanyId)));
    if (staleRefusal) {
      return res.status(412).json({ status: 412, title: 'Precondition Failed', detail: staleRefusal });
    }

    // S3, second half (v1.11.197): a tester's save is merged into the stored
    // file rather than replacing it — only their own scenarios change, shared
    // and other people's scenarios stay exactly as stored, and what they tick
    // becomes their personal run list. See utils/datafileOwnership. A Test
    // Manager still saves the whole file.
    let toStore = body;
    let merge = null;
    let stored = null;                   // read once: the merge and the template rule both need it
    if (isTester) {
      // The personal run list is keyed on the users row. A tester deleted while
      // their session is still open would otherwise have their save written
      // and then fail on that key — reported as "NOT saved" after the fact.
      if (!get('SELECT 1 AS ok FROM users WHERE id = ?', [req.user.id])) {
        return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'This account no longer exists. Sign in again.' });
      }
      stored = {};
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

    // NEW-10: a save may not add a double-brace template to scenario text. The
    // test engine fills such a template in, and the one naming the run's token
    // gives the token of whoever runs the scenario. Only what this save adds or
    // changes is looked at, so text stored earlier, by anyone, does not block a
    // save of something else; a run of it is refused instead (worker/runner.js).
    // For a tester this is looked at after the merge: it is what would be stored.
    if (stored === null) stored = await storedDatafileOrEmpty(targetCompanyId);
    const templateRefusal = saveRefusal(templatesAddedBy(stored, toStore));
    if (templateRefusal) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: templateRefusal });
    }

    // knownDeviations[] is server-managed (#398 / Test Findings register): the
    // projection of the findings the test team baselined, never the client's.
    // writeDatafile overwrites whatever was sent, then encrypts and writes
    // atomically (a crash mid-write leaves the previous file for Bruno).
    let hash;
    try {
      ({ hash } = await writeDatafile({ id: targetCompanyId, slug }, toStore));
    } catch (err) {
      log.error({ err, companyId: targetCompanyId }, 'Failed to encrypt-write datafile');
      return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file to disk.' });
    }
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
    // The version the next save from this page names: the stored file as this
    // person now sees it (for a tester, with the run list now stored).
    const version = datafileVersion(JSON.stringify(toStore), viewerOf(req, targetCompanyId));
    res.setHeader('ETag', etag(version));
    return res.json({
      filename:        path.basename(filePath),
      hash,
      version,
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
    // #549: and the file an upload replaced. A delete is a delete; the dialog
    // says it cannot be undone.
    fs.rmSync(previousDatafilePath(req.datafileCompany.slug), { force: true });


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
  if (!company?.datafile_path || !fs.existsSync(company.datafile_path)) {
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
    if (fwRow?.config) {
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

  // #540: the version a save from this load names (If-Match). Taken from the
  // stored file before annotation, as this person sees it.
  res.setHeader('ETag', etag(datafileVersion(plaintext, viewerOf(req, targetCompanyId))));
  res.setHeader('Content-Disposition', `attachment; filename="${company.slug}-datafile.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(serveBytes.length));
  return res.end(serveBytes);
});

module.exports = router;
