// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-ai-checklist.js — the provider's filled set-up checklist, told to
 * the AI analysis (#827, PR A).
 *
 *   GET    /v1/company/ai-analysis/checklist   — what was imported, and when
 *   POST   /v1/company/ai-analysis/checklist   — import a filled checklist (.docx, field "checklist")
 *   DELETE /v1/company/ai-analysis/checklist   — remove it
 *
 * Test Managers of the company or provider (X-Provider-Id), as for the rest
 * of the AI analysis page; no AI access is needed to import one. The role and
 * company are checked before the upload is parsed, and the file is read in
 * memory: nothing of it reaches the disk. Only its answers are kept,
 * encrypted, and never the API Config or contact answers.
 */

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { get, run, colDecrypt, colEncrypt } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const CL = require('../../utils/checklistAnswers');
const { scopeForTestManager } = require('./company-ai-analysis');

const router = express.Router();
router.use(requireAuth, enforceTenant);

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});

const MAX_UPLOAD = 5 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class UploadRefusal extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (req, file, cb) => {
    // The guard below must have run: refuse an upload nobody has authorised.
    if (!req.checklistCompany) return cb(new Error('Checklist upload reached the parser without authorisation.'));
    if (file.mimetype === DOCX || /\.docx$/i.test(file.originalname || '')) return cb(null, true);
    return cb(new UploadRefusal('Only the Word file (.docx) of the set-up checklist is accepted.'));
  },
});

// Role and company first, then the parser.
function guard(req, res, next) {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  req.checklistCompany = req.companyId;
  next();
}

function parse(req, res, next) {
  upload.single('checklist')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof UploadRefusal) return res.status(400).json({ status: 400, title: 'Bad Request', detail: err.message });
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ status: 413, title: 'File Too Large', detail: 'Maximum upload size is 5 MB.' });
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: `The upload could not be read (${err.code}). Send one file in the field "checklist".` });
    }
    return next(err);
  });
}

/** The stored answers of a company or provider, or null. */
function checklistOf(companyId) {
  const row = get('SELECT * FROM provider_checklist WHERE company_id = ?', [companyId]);
  if (!row) return null;
  let answers = {};
  try { answers = JSON.parse(colDecrypt(row.answers_enc)); } catch { answers = {}; }
  return { answers, count: row.answer_count, fileName: row.file_name, importedAt: row.imported_at, importedBy: row.imported_by };
}

function view(stored) {
  if (!stored) return { checklist: null };
  const by = stored.importedBy ? get('SELECT email FROM users WHERE id = ?', [stored.importedBy]) : null;
  const context = CL.contextOf(stored.answers);
  return { checklist: { fileName: stored.fileName, answers: stored.count, importedAt: stored.importedAt, importedBy: by?.email || null,
    sent: context.answers, cut: context.cut } };
}

router.get('/ai-analysis/checklist', limiter, guard, (req, res) => {
  res.json(view(checklistOf(req.companyId)));
});

router.post('/ai-analysis/checklist', limiter, guard, parse, (req, res) => {
  if (!req.file) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Send the filled checklist in the field "checklist".' });
  const read = CL.answersOfDocx(req.file.buffer);
  if (read.refusal) return res.status(400).json({ status: 400, title: 'Bad Request', detail: read.refusal });
  const count = Object.keys(read.answers).length;
  const fileName = String(req.file.originalname || '').slice(0, 200) || null;
  run(`INSERT INTO provider_checklist (company_id, answers_enc, answer_count, file_name, imported_by, imported_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(company_id) DO UPDATE SET answers_enc = excluded.answers_enc, answer_count = excluded.answer_count,
         file_name = excluded.file_name, imported_by = excluded.imported_by, imported_at = excluded.imported_at`,
  [req.companyId, colEncrypt(JSON.stringify(read.answers)), count, fileName, req.user.id]);
  auditLog(req.user.id, req.companyId, req.user.email, `provider_checklist_imported:${count}`);
  res.json(view(checklistOf(req.companyId)));
});

router.delete('/ai-analysis/checklist', limiter, guard, (req, res) => {
  const done = run('DELETE FROM provider_checklist WHERE company_id = ?', [req.companyId]);
  if (!done.changes) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No checklist is imported here.' });
  auditLog(req.user.id, req.companyId, req.user.email, 'provider_checklist_removed');
  res.status(204).end();
});

module.exports = router;
module.exports.checklistOf = checklistOf;
