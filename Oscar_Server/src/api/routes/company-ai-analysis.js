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
 *   GET  /v1/company/ai-analysis/access          — the text, and where the Test
 *                                                  Manager stands for the company
 *                                                  and each provider they may use
 *   POST /v1/company/ai-analysis/access/request  — { version, hash, companies }:
 *                                                  the text accepted, for these
 *
 * Access is asked and decided per company or provider: one request row per
 * (company or provider, Test Manager), so a refusal for one provider leaves
 * the others open. The targets are the distributor and the providers
 * canUseCompany() admits, whichever one the page is working on. Testers,
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
const { canUseCompany } = require('../helpers/provider-access');
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

// The distributor: the request's company, or the distributor of the provider
// it names.
function topCompanyOf(companyId) {
  const row = get('SELECT id, name, parent_id FROM companies WHERE id = ?', [companyId]);
  if (!row) return null;
  if (!row.parent_id) return row;
  return get('SELECT id, name, parent_id FROM companies WHERE id = ?', [row.parent_id]);
}

// What a Test Manager may ask access for: the distributor, then each provider
// they may use, by name.
function targetsOf(user, company) {
  const providers = all('SELECT id, name FROM companies WHERE parent_id = ? ORDER BY name', [company.id])
    .filter(p => canUseCompany(user, p.id));
  return [{ id: company.id, name: company.name, provider: false },
    ...providers.map(p => ({ id: p.id, name: p.name, provider: true }))];
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

function alreadyAsked(state) {
  return state === 'pending' ? 'Your request is already waiting for an administrator.' : 'You already have access.';
}

// The text accepted now: a new request waits for an administrator; a new
// version accepted by an approved Test Manager keeps the decision.
function saveAcceptance(existing, companyId, userId, reaccept) {
  if (!existing) {
    run(`INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash)
         VALUES (?, ?, ?, 'pending', ?, ?)`, [randomUUID(), companyId, userId, A.COMMITMENT.version, A.commitmentHash()]);
    return;
  }
  const keep = reaccept ? 1 : 0;
  run(`UPDATE ai_access_request
         SET state = ?, text_version = ?, text_hash = ?, accepted_at = datetime('now'),
             decided_by = CASE WHEN ? THEN decided_by ELSE NULL END,
             decided_at = CASE WHEN ? THEN decided_at ELSE NULL END,
             reason = NULL
       WHERE id = ?`,
  [reaccept ? 'approved' : 'pending', A.COMMITMENT.version, A.commitmentHash(), keep, keep, existing.id]);
}

// Fire-and-forget: the administrators' card is the reliable signal.
function notifyAdministrators(req, company, names) {
  const admins = all("SELECT email FROM users WHERE role = 'administrator' AND (status IS NULL OR status = 'active')").map(r => r.email);
  if (!admins.length) return;
  sendAiAccessNotice({
    to: admins,
    subject: `OSCAR — AI analysis access requested (${company.name})`,
    heading: 'AI analysis access requested',
    lines: [`${req.user.email} (${company.name}) asks for access to the AI analysis of results, and has accepted version ${A.COMMITMENT.version} of the commitment text.`,
      `For: ${names.join(', ')}.`,
      'Approve or refuse each one in Manage Companies.'],
    url: `${appUrl(req)}/admin.html?tab=companies`,
  }).catch(err => log.warn({ err: err.message }, 'AI access request notice not sent'));
}

function targetView(target, userId) {
  const request = requestOf(target.id, userId);
  return { ...target, state: A.accessState(request), request: toApiRequest(request) };
}

const MAX_TARGETS = 100;

// The targets a request names, or the refusal to send.
function chosenTargets(body, targets) {
  const ids = body?.companies;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TARGETS || !ids.every(id => typeof id === 'string')) {
    return { refusal: { status: 400, title: 'Bad Request', detail: 'Choose the company or the providers you ask access for.' } };
  }
  const chosen = targets.filter(t => ids.includes(t.id));
  if (chosen.length !== new Set(ids).size) {
    return { refusal: { status: 404, title: 'Not Found', detail: 'Company or provider not found.' } };
  }
  return { chosen };
}

// ── GET /ai-analysis/access ──────────────────────────────────────────────────
router.get('/ai-analysis/access', readLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  return res.json({
    company: { id: company.id, name: company.name },
    targets: targetsOf(req.user, company).map(t => targetView(t, req.user.id)),
    commitment: A.commitmentForPage(),
  });
});

// ── POST /ai-analysis/access/request ─────────────────────────────────────────
router.post('/ai-analysis/access/request', requestLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const body = req.body || {};
  if (!A.acceptsCurrentText(body)) {
    return res.status(400).json({ status: 400, title: 'Bad Request',
      detail: 'The text you accepted is not the one in force. Reload the page and read it again.' });
  }
  const plan = chosenTargets(body, targetsOf(req.user, company));
  if (plan.refusal) return res.status(plan.refusal.status).json(plan.refusal);
  const refused = plan.chosen.map(t => targetView(t, req.user.id)).filter(t => !A.mayRequest(t.state));
  if (refused.length) {
    return res.status(409).json({ status: 409, title: 'Conflict',
      detail: refused.map(t => `${t.name}: ${alreadyAsked(t.state)}`).join(' ') });
  }

  // An approved Test Manager accepting a new version of the text keeps the
  // approval; any other request waits for an administrator again.
  const asked = [];
  for (const target of plan.chosen) {
    const existing = requestOf(target.id, req.user.id);
    const reaccept = A.accessState(existing) === 'needs_acceptance';
    saveAcceptance(existing, target.id, req.user.id, reaccept);
    auditLog(req.user.id, target.id, req.user.email,
      `${reaccept ? 'ai_access_reaccepted' : 'ai_access_requested'}:v${A.COMMITMENT.version}`);
    if (!reaccept) asked.push(target.name);
  }
  if (asked.length) notifyAdministrators(req, company, asked);

  return res.status(asked.length ? 201 : 200).json({
    targets: plan.chosen.map(t => targetView(t, req.user.id)),
  });
});

module.exports = router;
module.exports.topCompanyOf = topCompanyOf;
