// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-coverage-positions.js — the provider takes a position on a point
 * of the coverage by capability (#994).
 *
 *   POST /v1/company/coverage/positions   { point, days, position, comment }
 *
 * A Test Manager or a tester of the company or provider of the request
 * (X-Provider-Id), who sees the coverage; administrators and certifiers get
 * 403. The point is found again in the coverage as the person reads it (a
 * tester's own view of the data file), by its id, so only a point they see
 * can be answered.
 *
 * The position goes on the point's finding, opened from the point when it has
 * none; its #735 keys are linked to that finding (as an accepted draft is), so
 * the point keeps it, and the comment goes in the finding's thread. It counts
 * at once (maintainer, 2026-10-27); the Test Manager changes the finding on
 * Test Findings & Open Points to confirm or reopen it.
 */

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { get, run, transaction, colEncrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, auditLog } = require('../helpers/shared');
const { Refusal } = require('../helpers/catalogueSource');
const { createFinding, toApiFinding } = require('../helpers/findings');
const { buildCoverage, daysOf, MAX_DAYS } = require('./company-coverage');
const PP = require('../../utils/pointPositions');
const log = require('../../utils/logger').child({ module: 'company-coverage-positions' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

// Each position builds the whole coverage again: a few a minute is plenty.
const positionLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many positions taken. Wait a minute.' },
});

const MEMBERS = new Set(['test_manager', 'company_user']);
const POINT_ID = /^[0-9a-f]{32}$/;
// The body's fields, checked: { asked } or { refusal } (a 400's detail).
function bodyOf(body) {
  const b = body || {};
  if (typeof b.point !== 'string' || !POINT_ID.test(b.point)) return { refusal: 'point must be the id of a point of the coverage.' };
  const days = daysOf(b.days === undefined ? undefined : String(b.days));
  if (days === null) return { refusal: `days must be a whole number from 1 to ${MAX_DAYS}.` };
  if (!PP.isPosition(b.position)) return { refusal: `position must be one of: ${Object.keys(PP.POSITIONS).join(', ')}.` };
  const comment = PP.commentOf(b.comment);
  if (comment === null) return { refusal: `A position needs a comment of 1 to ${PP.MAX_COMMENT} characters.` };
  return { asked: { point: b.point, days, position: b.position, comment } };
}

// The point's #735 keys go to its finding: a key without a draft gets one
// already accepted, a draft waiting or rejected is accepted now. A key
// already accepted for another finding is left as it is.
function linkKeys(companyId, point, { findingId, position }, user) {
  const draft = colEncrypt(JSON.stringify(PP.findingFields(point, position)));
  const codes = JSON.stringify((point.tests || []).flatMap((t) => t.codes || []));
  const runs = JSON.stringify((point.runs || []).map((r) => r.runId));
  for (const key of point.keys || []) {
    const row = get('SELECT id, state FROM finding_suggestion WHERE company_id = ? AND group_key = ?', [companyId, key]);
    if (!row) {
      run(`INSERT INTO finding_suggestion (id, company_id, group_key, state, draft, scenarios, runs, occurrences, finding_id, decided_by, decided_at)
           VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [crypto.randomUUID(), companyId, key, draft, codes, runs, point.occurrences || 0, findingId, user.email]);
    } else if (row.state === 'draft' || row.state === 'rejected') {
      run(`UPDATE finding_suggestion SET state = 'accepted', finding_id = ?, decided_by = ?, decided_at = datetime('now'),
             updated_at = datetime('now') WHERE id = ?`, [findingId, user.email, row.id]);
    }
  }
}

// The position on the point's finding, its keys and its thread, in one go.
function take(companyId, point, { position, comment }, user) {
  let row = point.finding ? get('SELECT id FROM finding WHERE id = ? AND company_id = ?', [point.finding.id, companyId]) : null;
  if (!row) row = createFinding(companyId, PP.findingFields(point, position), user.email);
  const change = PP.findingChange(position);
  run(`UPDATE finding SET category = ?, status = ?, severity = COALESCE(?, severity), position = ?, position_by = ?, position_role = ?,
         position_at = datetime('now'), position_comment = ?, updated_at = datetime('now') WHERE id = ?`,
  [change.category, change.status, change.severity, position, user.email, user.role, comment, row.id]);
  linkKeys(companyId, point, { findingId: row.id, position }, user);
  run('INSERT INTO finding_comment (id, finding_id, author, role, body) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), row.id, user.email, user.role, PP.threadText(position, comment)]);
  return row.id;
}

router.post('/coverage/positions', positionLimiter, async (req, res) => {
  if (!MEMBERS.has(req.user.role)) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only the Test Managers and testers of a company take a position on its coverage.' });
  }
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return undefined;
  const { asked, refusal: invalid } = bodyOf(req.body);
  if (invalid) return res.status(400).json({ status: 400, title: 'Bad Request', detail: invalid });
  try {
    const report = await buildCoverage(companyId, asked.days, req.user);
    const point = (report.byCapability?.points || []).find((p) => p.id === asked.point);
    if (!point) {
      return res.status(404).json({ status: 404, title: 'Not Found', detail: 'This point is not in the coverage any more: show the coverage again.' });
    }
    const refusal = PP.positionRefusal(point, asked.position);
    if (refusal) return res.status(409).json({ status: 409, title: 'Conflict', detail: refusal });
    let findingId = null;
    transaction(() => { findingId = take(companyId, point, asked, req.user); });
    auditLog(req.user.id, companyId, req.user.email, `coverage_position:${asked.position}:${findingId}`);
    const finding = toApiFinding(get('SELECT * FROM finding WHERE id = ?', [findingId]));
    return res.json({ finding, position: PP.positionView(finding) });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ status: err.status, title: 'Conflict', detail: err.message });
    log.error({ err, companyId }, 'coverage position not taken');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The position could not be taken.' });
  }
});

module.exports = router;
