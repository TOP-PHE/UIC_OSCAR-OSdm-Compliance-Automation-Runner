// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-ai-analysis.js — the AI analysis of results, Test Manager side
 * (#801). PR 1: access only.
 *
 *   GET  /v1/company/ai-analysis/access          — where the Test Manager stands, and the text
 *   POST /v1/company/ai-analysis/access/request  — { version, hash } of the text accepted
 *
 * Access is decided per top-level company: a provider's request acts in its
 * distributor (users belong to top-level companies only, #540). Testers,
 * certifiers and administrators are refused; the administrator's side lives
 * in admin.js.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { get, all, run } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, auditLog } = require('../helpers/shared');
const A = require('../../utils/aiAccess');
const { sendAiAccessNotice } = require('../../utils/mailer');
const log = require('../../utils/logger').child({ module: 'company-ai-analysis' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many access requests in a short window — please wait a moment.' }
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' }
});

// The company the switch and the request belong to: the request's company,
// or the distributor of the provider it names.
function topCompanyOf(companyId) {
  const row = get('SELECT id, name, parent_id, ai_analysis_enabled FROM companies WHERE id = ?', [companyId]);
  if (!row) return null;
  if (!row.parent_id) return row;
  return get('SELECT id, name, parent_id, ai_analysis_enabled FROM companies WHERE id = ?', [row.parent_id]);
}

function scopeForTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers may use the AI analysis.' });
    return null;
  }
  const scope = resolveCompanyScope(req, res);
  if (scope === null) return null;
  const company = topCompanyOf(scope);
  if (!company) {
    res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
    return null;
  }
  return company;
}

function requestOf(companyId, userId) {
  return get('SELECT * FROM ai_access_request WHERE company_id = ? AND user_id = ?', [companyId, userId]) || null;
}

function toApiRequest(row) {
  if (!row) return null;
  return {
    state: row.state,
    textVersion: row.text_version,
    acceptedAt: row.accepted_at,
    decidedAt: row.decided_at,
    reason: row.reason,
  };
}

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// ── GET /ai-analysis/access ──────────────────────────────────────────────────
router.get('/ai-analysis/access', readLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const request = requestOf(company.id, req.user.id);
  return res.json({
    company: { id: company.id, name: company.name },
    enabled: !!company.ai_analysis_enabled,
    state: A.accessState(!!company.ai_analysis_enabled, request),
    request: toApiRequest(request),
    commitment: A.commitmentForPage(),
  });
});

// ── POST /ai-analysis/access/request ─────────────────────────────────────────
router.post('/ai-analysis/access/request', requestLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  if (!company.ai_analysis_enabled) {
    return res.status(409).json({ status: 409, title: 'Conflict',
      detail: 'The AI analysis is not enabled for your company. Ask an OSCAR administrator.' });
  }
  const { version, hash } = req.body || {};
  if (!A.acceptsCurrentText({ version, hash })) {
    return res.status(400).json({ status: 400, title: 'Bad Request',
      detail: 'The text you accepted is not the one in force. Reload the page and read it again.' });
  }
  const existing = requestOf(company.id, req.user.id);
  const state = A.accessState(true, existing);
  if (!A.mayRequest(state)) {
    return res.status(409).json({ status: 409, title: 'Conflict',
      detail: state === 'pending' ? 'Your request is already waiting for an administrator.' : 'You already have access.' });
  }

  // An approved Test Manager accepting a new version of the text keeps the
  // approval; any other request waits for an administrator again.
  const reaccept = state === 'needs_acceptance';
  if (existing) {
    run(`UPDATE ai_access_request
           SET state = ?, text_version = ?, text_hash = ?, accepted_at = datetime('now'),
               decided_by = CASE WHEN ? THEN decided_by ELSE NULL END,
               decided_at = CASE WHEN ? THEN decided_at ELSE NULL END,
               reason = NULL
         WHERE id = ?`,
    [reaccept ? 'approved' : 'pending', A.COMMITMENT.version, A.commitmentHash(), reaccept ? 1 : 0, reaccept ? 1 : 0, existing.id]);
  } else {
    run(`INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash)
         VALUES (?, ?, ?, 'pending', ?, ?)`, [randomUUID(), company.id, req.user.id, A.COMMITMENT.version, A.commitmentHash()]);
  }
  auditLog(req.user.id, company.id, req.user.email,
    `${reaccept ? 'ai_access_reaccepted' : 'ai_access_requested'}:v${A.COMMITMENT.version}`);

  if (!reaccept) {
    const admins = all("SELECT email FROM users WHERE role = 'administrator' AND (status IS NULL OR status = 'active')").map(r => r.email);
    if (admins.length) {
      sendAiAccessNotice({
        to: admins,
        subject: `OSCAR — AI analysis access requested (${company.name})`,
        heading: 'AI analysis access requested',
        lines: [`${req.user.email} (${company.name}) asks for access to the AI analysis of results, and has accepted version ${A.COMMITMENT.version} of the commitment text.`,
          'Approve or refuse the request in Manage Companies.'],
        url: `${appUrl(req)}/admin.html?tab=companies`,
      }).catch(err => log.warn({ err: err.message }, 'AI access request notice not sent'));
    }
  }

  const request = requestOf(company.id, req.user.id);
  return res.status(reaccept ? 200 : 201).json({
    state: A.accessState(true, request),
    request: toApiRequest(request),
  });
});

module.exports = router;
module.exports.topCompanyOf = topCompanyOf;
