// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-checklist.js — a provider's filled set-up checklist sets up its
 * Test Framework and Test Data (#862).
 *
 *   GET  /v1/company/checklists                    — the imports kept, newest first
 *   POST /v1/company/checklists                    — import a filled checklist (.docx, field "checklist"); changes nothing
 *   GET  /v1/company/checklists/:id/preview        — what applying it would change (?testData=add|replace&scenarios=copy|none)
 *   POST /v1/company/checklists/:id/apply          — apply it: { hash, testData, scenarios }, the hash of the preview shown
 *   POST /v1/company/checklists/:id/discard        — set it aside
 *
 * Test Managers of the company or provider (X-Provider-Id). Each import is
 * kept with its date, its answers encrypted, never the API Config and contact
 * answers (as for #827); the file itself is not kept. An import changes
 * nothing: the Test Manager reads the preview, set against the checklist
 * applied before, and applies it with the preview's hash, so nothing is
 * applied that was not shown. Applying writes the framework and the Test
 * Data in one transaction, and makes the checklist the one the AI analysis
 * is told about (provider_checklist).
 *
 * PR 2: the reference scenarios of the catalogue that the new framework
 * declares everything for are copied too, unless the Test Manager says no
 * (utils/checklistScenarios.js). They are written after the framework and the
 * Test Data, under the data file lock; if that write fails, the framework and
 * the Test Data stay applied and the answer says the scenarios were not
 * copied, so they can be copied with Copy scenarios.
 */

const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../../db/db');
const { get, all, run, colDecrypt, colEncrypt } = db;
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope, requireTestManager } = require('../helpers/shared');
const { frameworkConfigOf, testResourcesOf, storeFramework, storeTestData } = require('../helpers/configurationStore');
const CL = require('../../utils/checklistAnswers');
const CC = require('../../utils/checklistConfiguration');
const { isOsdmVersion } = require('../../utils/osdmVersion');
const { distributionModesProblem } = require('../../utils/distributionModes');
const { fareDeclarationsProblem } = require('../../utils/fareDeclarations');
const CS = require('../../utils/checklistScenarios');
const { applyCopy } = require('../../utils/scenarioCopy');
const { templatesAddedBy, saveRefusal } = require('../../utils/datafileTemplates');
const { withDatafileLock } = require('../../utils/datafileLock');
const { writeDatafile } = require('../../utils/datafileWrite');
const { Refusal, readDatafile, readCatalogue, testDataChoices } = require('../helpers/catalogueSource');
const { copyReport } = require('../../../public/js/copy-report');
const log = require('../../utils/logger').child({ module: 'company-checklist' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});

const MAX_UPLOAD = 5 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MODES = Object.freeze(['add', 'replace']);
const LISTED = 50;

class UploadRefusal extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (req, file, cb) => {
    // The guard must have run: refuse an upload nobody has authorised.
    if (!req.checklistCompany) return cb(new Error('Checklist upload reached the parser without authorisation.'));
    if (file.mimetype === DOCX || /\.docx$/i.test(file.originalname || '')) return cb(null, true);
    return cb(new UploadRefusal('Only the Word file (.docx) of the set-up checklist is accepted.'));
  },
});

const problem = (res, status, title, detail, extra) => res.status(status).json({ status, title, detail, ...extra });

// Role and company first, then anything else.
function guard(req, res, next) {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return;
  if (!companyId || !get('SELECT id FROM companies WHERE id = ?', [companyId])) return problem(res, 404, 'Not Found', 'Company not found.');
  req.checklistCompany = companyId;
  next();
}

function parse(req, res, next) {
  upload.single('checklist')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof UploadRefusal) return problem(res, 400, 'Bad Request', err.message);
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return problem(res, 413, 'File Too Large', 'Maximum upload size is 5 MB.');
      return problem(res, 400, 'Bad Request', `The upload could not be read (${err.code}). Send one file in the field "checklist".`);
    }
    return next(err);
  });
}

function answersOf(row) {
  try {
    const answers = JSON.parse(colDecrypt(row.answers_enc));
    return answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  } catch {
    return {};
  }
}

const emailOf = id => (id ? get('SELECT email FROM users WHERE id = ?', [id])?.email || null : null);

function view(row) {
  return {
    id: row.id, fileName: row.file_name, sha256: row.file_sha256, answers: row.answer_count,
    importedAt: row.imported_at, importedBy: emailOf(row.imported_by),
    status: row.status, decidedAt: row.decided_at, decidedBy: emailOf(row.decided_by),
  };
}

const importOf = (companyId, id) => get('SELECT * FROM checklist_import WHERE id = ? AND company_id = ?', [String(id), companyId]);

// The answers the new checklist is set against: the last one applied here,
// else the one imported for the AI analysis (#827).
function previousOf(companyId) {
  const applied = get(`SELECT * FROM checklist_import WHERE company_id = ? AND status = 'applied'
                        ORDER BY decided_at DESC, imported_at DESC LIMIT 1`, [companyId]);
  if (applied) return { answers: answersOf(applied), from: { kind: 'applied', ...view(applied) } };
  const ai = get('SELECT * FROM provider_checklist WHERE company_id = ?', [companyId]);
  if (ai) return { answers: answersOf(ai), from: { kind: 'ai_analysis', fileName: ai.file_name, importedAt: ai.imported_at } };
  return null;
}

const TRIPS = new Set(['TRAIN', 'JOURNEY']);
const tripResources = companyId => testResourcesOf(companyId).filter(r => TRIPS.has(r.resource_type));

// The reference scenarios a framework and Test Data would copy here, or
// { unavailable } when the catalogue or the data file cannot be read.
async function scenarioPlanFor(companyId, framework, resources) {
  try {
    const { catalogue, simulator } = readCatalogue();
    const existingCodes = CS.codesOf(await readDatafile(companyId));
    return CS.scenarioPlan({ catalogue, simulator, framework, testData: testDataChoices(resources), existingCodes });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return { unavailable: err.message };
  }
}

async function previewFor(companyId, row, mode, choice) {
  const previous = previousOf(companyId);
  const existing = testResourcesOf(companyId);
  const preview = CC.previewOf({
    importId: row.id,
    answers: answersOf(row),
    previous: previous ? previous.answers : null,
    current: frameworkConfigOf(companyId),
    existing,
    mode,
  });
  const plan = await scenarioPlanFor(companyId, preview.proposedFramework, CC.testDataAfter(existing, preview.incomingTestData, mode));
  preview.scenarios = plan.unavailable ? { choice, unavailable: plan.unavailable } : CS.shownPlan(plan, choice);
  preview.hash = CC.previewHash(preview);
  return { preview, previous: previous ? previous.from : null };
}

// #862 PR 2: copy the reference scenarios the framework and Test Data now
// stored allow, as Copy scenarios does. Returns what the answer says of them.
function copyReferenceScenarios(req, companyId) {
  return withDatafileLock(companyId, async () => {
    const stored = (await readDatafile(companyId)) || {};
    const resources = tripResources(companyId);
    const framework = frameworkConfigOf(companyId) || {};
    const { catalogue, simulator } = readCatalogue();
    const plan = CS.scenarioPlan({ catalogue, simulator, framework, testData: testDataChoices(resources), existingCodes: CS.codesOf(stored) });
    if (!plan.copy.length) return { copied: [] };
    const result = applyCopy(plan.source, stored, {
      codes: plan.copy.map(c => c.code), tripMap: plan.tripMap, frameworkConfig: framework, resources, email: req.user.email,
    });
    if (result.errors) throw new Refusal(400, result.errors.join(' '));
    const templateRefusal = saveRefusal(templatesAddedBy(stored, result.datafile));
    if (templateRefusal) throw new Refusal(400, templateRefusal);
    if (!('scenariosToRun' in result.datafile)) result.datafile.scenariosToRun = [];
    const company = get('SELECT id, slug FROM companies WHERE id = ?', [companyId]);
    await writeDatafile(company, result.datafile);
    const toComplete = new Map(plan.copy.map(c => [c.code, c.toComplete]));
    const copied = result.copied.map(c => ({ ...c, toComplete: toComplete.get(c.from) || [] }));
    auditLog(req.user.id, companyId, req.user.email, `checklist_scenarios_copied:${copied.length}`);
    return { copied, report: copyReport(copied.map(c => ({ code: c.to, toComplete: c.toComplete })), copied.map(c => c.to)) };
  });
}

// What the page is shown: everything but the framework and Test Data
// written, which the apply works out again.
function shownPreview(row, { preview, previous }) {
  const shown = { ...preview };
  delete shown.proposedFramework;
  delete shown.incomingTestData;
  return { import: view(row), previous, ...shown };
}

router.get('/checklists', limiter, guard, (req, res) => {
  const rows = all('SELECT * FROM checklist_import WHERE company_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT ?', [req.checklistCompany, LISTED]);
  res.json({ imports: rows.map(view) });
});

router.post('/checklists', limiter, guard, parse, async (req, res) => {
  if (!req.file) return problem(res, 400, 'Bad Request', 'Send the filled checklist in the field "checklist".');
  const read = CL.answersOfDocx(req.file.buffer);
  if (read.refusal) return problem(res, 400, 'Bad Request', read.refusal);
  const companyId = req.checklistCompany;
  const id = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const fileName = String(req.file.originalname || '').slice(0, 200) || null;
  db.transaction(() => {
    // One checklist waits at a time: an earlier one waiting is set aside.
    run(`UPDATE checklist_import SET status = 'discarded', decided_by = ?, decided_at = datetime('now')
          WHERE company_id = ? AND status = 'waiting'`, [req.user.id, companyId]);
    run(`INSERT INTO checklist_import (id, company_id, answers_enc, answer_count, file_name, file_sha256, imported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, colEncrypt(JSON.stringify(read.answers)), Object.keys(read.answers).length, fileName, sha256, req.user.id]);
  });
  auditLog(req.user.id, companyId, req.user.email, `checklist_imported:${id}`);
  const row = importOf(companyId, id);
  res.status(201).json(shownPreview(row, await previewFor(companyId, row, 'add', 'copy')));
});

const modeOf = value => (value === undefined ? 'add' : value);
const choiceOf = value => (value === undefined ? 'copy' : value);

router.get('/checklists/:id/preview', limiter, guard, async (req, res) => {
  const row = importOf(req.checklistCompany, req.params.id);
  if (!row) return problem(res, 404, 'Not Found', 'No such checklist here.');
  const mode = modeOf(req.query.testData);
  if (!MODES.includes(mode)) return problem(res, 400, 'Bad Request', '"testData" must be add or replace.');
  const choice = choiceOf(req.query.scenarios);
  if (!CS.CHOICES.includes(choice)) return problem(res, 400, 'Bad Request', '"scenarios" must be copy or none.');
  res.json(shownPreview(row, await previewFor(req.checklistCompany, row, mode, choice)));
});

// What the apply's answer says of the reference scenarios: copied, or why not.
async function scenarioOutcomeOf(req, companyId, choice, planned) {
  if (choice !== 'copy' || !planned.copy?.length) return { choice, copied: [] };
  try {
    return { choice, ...(await copyReferenceScenarios(req, companyId)) };
  } catch (err) {
    if (!(err instanceof Refusal)) log.error({ err, companyId }, 'checklist apply: reference scenarios not copied');
    const reason = err instanceof Refusal ? ` ${err.message}` : '';
    return {
      choice, copied: [],
      error: `The reference scenarios were not copied.${reason} The Test Framework and the Test Data are applied: copy the scenarios with Copy scenarios.`,
    };
  }
}

router.post('/checklists/:id/apply', limiter, guard, async (req, res) => {
  const companyId = req.checklistCompany;
  const row = importOf(companyId, req.params.id);
  if (!row) return problem(res, 404, 'Not Found', 'No such checklist here.');
  if (row.status !== 'waiting') return problem(res, 409, 'Conflict', `This checklist is already ${row.status}. Import it again to apply it. Nothing was changed.`);
  const { hash, testData, scenarios } = req.body || {};
  const mode = modeOf(testData);
  if (!MODES.includes(mode)) return problem(res, 400, 'Bad Request', '"testData" must be add or replace.');
  const choice = choiceOf(scenarios);
  if (!CS.CHOICES.includes(choice)) return problem(res, 400, 'Bad Request', '"scenarios" must be copy or none.');
  if (typeof hash !== 'string' || !hash) return problem(res, 400, 'Bad Request', 'Send the "hash" of the preview you read.');
  const computed = await previewFor(companyId, row, mode, choice);
  if (computed.preview.hash !== hash) {
    return problem(res, 409, 'Conflict', 'The Test Framework or the Test Data changed since this preview was made. Read the new preview before applying. Nothing was changed.',
      { preview: shownPreview(row, computed) });
  }
  const { proposedFramework, incomingTestData } = computed.preview;
  const version = proposedFramework.osdmVersion;
  if (version != null && version !== '' && !isOsdmVersion(version)) {
    return problem(res, 400, 'Bad Request', `The checklist names the OSDM version "${String(version).slice(0, 40)}", which is not a version. Nothing was changed.`);
  }
  // #936 / #937: the distribution modes and fare declarations, as the Test Framework route checks them.
  const modesProblem = distributionModesProblem(proposedFramework.distributionModes) || fareDeclarationsProblem(proposedFramework.fares);
  if (modesProblem) return problem(res, 400, 'Bad Request', `${modesProblem} Nothing was changed.`);
  let testDataOutcome;
  try {
    db.transaction(() => {
      storeFramework(companyId, proposedFramework);
      testDataOutcome = storeTestData(companyId, incomingTestData, mode);
      run(`UPDATE checklist_import SET status = 'applied', decided_by = ?, decided_at = datetime('now') WHERE id = ?`, [req.user.id, row.id]);
      // The AI analysis is told about the checklist applied (#827).
      run(`INSERT INTO provider_checklist (company_id, answers_enc, answer_count, file_name, imported_by, imported_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(company_id) DO UPDATE SET answers_enc = excluded.answers_enc, answer_count = excluded.answer_count,
             file_name = excluded.file_name, imported_by = excluded.imported_by, imported_at = excluded.imported_at`,
      [companyId, row.answers_enc, row.answer_count, row.file_name, row.imported_by, row.imported_at]);
    });
  } catch (err) {
    log.error({ err, companyId }, 'checklist apply failed');
    return problem(res, 500, 'Internal Server Error', 'The checklist could not be applied. Nothing was changed.');
  }
  auditLog(req.user.id, companyId, req.user.email, `checklist_applied:${row.id}`);
  const scenarioOutcome = await scenarioOutcomeOf(req, companyId, choice, computed.preview.scenarios);
  res.json({
    applied: true, import: view(importOf(companyId, row.id)),
    framework: { changes: computed.preview.framework.changes.length }, testData: testDataOutcome, scenarios: scenarioOutcome,
  });
});

router.post('/checklists/:id/discard', limiter, guard, (req, res) => {
  const companyId = req.checklistCompany;
  const row = importOf(companyId, req.params.id);
  if (!row) return problem(res, 404, 'Not Found', 'No such checklist here.');
  if (row.status !== 'waiting') return problem(res, 409, 'Conflict', `This checklist is already ${row.status}.`);
  run(`UPDATE checklist_import SET status = 'discarded', decided_by = ?, decided_at = datetime('now') WHERE id = ?`, [req.user.id, row.id]);
  auditLog(req.user.id, companyId, req.user.email, `checklist_discarded:${row.id}`);
  res.json({ import: view(importOf(companyId, row.id)) });
});

module.exports = router;
