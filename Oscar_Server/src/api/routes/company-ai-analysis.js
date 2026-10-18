// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-ai-analysis.js — the AI analysis of results, Test Manager side
 * (#801). PR 1: access; PR 2: the AI service.
 *
 *   GET  /v1/company/ai-analysis/access          — the text, and where the Test
 *                                                  Manager stands for the company
 *                                                  and each provider they may use
 *   POST /v1/company/ai-analysis/access/request  — { version, hash, companies }:
 *                                                  the text accepted, for these
 *   GET    /v1/company/ai-analysis/config        — the AI service of the request's
 *                                                  company or provider (never the key)
 *   PUT    /v1/company/ai-analysis/config        — save it; tested first when the
 *                                                  service, address, model or key changes
 *   POST   /v1/company/ai-analysis/config/test   — test the stored or the given one
 *   POST   /v1/company/ai-analysis/config/models — the models the Anthropic service
 *                                                  offers, with the stored or the given key (#831)
 *   DELETE /v1/company/ai-analysis/config        — remove it, key included
 *
 * The AI service is configured like the access is asked: per (company or
 * provider, Test Manager), and only where that Test Manager's access is
 * approved. The company or provider is the request's (X-Provider-Id), as on
 * every other page.
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
const { get, all, run, encrypt, decrypt } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, auditLog } = require('../helpers/shared');
const { canUseCompany } = require('../helpers/provider-access');
const A = require('../../utils/aiAccess');
const C = require('../../utils/aiConfig');
const M = require('../../utils/aiModels');
const { testConnection, listModels } = require('../../services/aiConnector');
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

// ── The AI service (PR 2) ────────────────────────────────────────────────────

const configLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many changes in a short window — please wait a moment.' }
});

// Each test is a call to the AI service, billed to the company's account.
const testLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many connection tests in a short window — please wait a moment.' }
});

// The request's company or provider, for a Test Manager. With `approved`, the
// Test Manager's access to it must be approved and its text accepted.
function configScope(req, res, { approved = true } = {}) {
  const company = scopeForTestManager(req, res);
  if (!company) return null;
  const target = get('SELECT id, name, parent_id FROM companies WHERE id = ?', [req.companyId]);
  if (!target) {
    res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
    return null;
  }
  if (approved) {
    const state = A.accessState(requestOf(target.id, req.user.id));
    if (state !== 'approved') {
      const detail = state === 'needs_acceptance'
        ? 'The commitment text has changed: accept it again on this page before you configure the AI service.'
        : `Your access to the AI analysis is not approved for ${target.name}.`;
      res.status(403).json({ status: 403, title: 'Forbidden', detail });
      return null;
    }
  }
  return target;
}

function configOf(companyId, userId) {
  return get('SELECT * FROM ai_config WHERE company_id = ? AND user_id = ?', [companyId, userId]) || null;
}

function storedKey(row) {
  return row?.api_key_enc ? decrypt(row.api_key_enc) : null;
}

const TITLES = { 400: 'Bad Request', 404: 'Not Found', 422: 'Unprocessable Content' };
const refuse = (res, status, detail) => res.status(status).json({ status, title: TITLES[status] || 'Error', detail });

// What a PUT or a test names: { next, key } or the refusal already sent.
function candidateOf(req, res, stored) {
  const checked = C.checkConfig(req.body);
  if (checked.refusal) { refuse(res, 400, checked.refusal); return null; }
  const next = checked.value;
  const keyProblem = C.keyRefusal(stored, next);
  if (keyProblem) { refuse(res, 400, keyProblem); return null; }
  return { next, key: next.apiKey || storedKey(stored) };
}

const testView = (t) => (t.ok
  ? { ok: true, answer: t.answer, stopReason: t.stopReason, model: t.model, usage: t.usage, ms: t.ms }
  : { ok: false, error: t.error, status: t.status ?? null });

// ── GET /ai-analysis/config ──────────────────────────────────────────────────
router.get('/ai-analysis/config', readLimiter, (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  return res.json({
    company: { id: target.id, name: target.name, provider: !!target.parent_id },
    config: C.configView(configOf(target.id, req.user.id)),
    connectors: C.connectorsForPage(),
    limits: { instruction: C.LIMITS.instruction, minTokenCap: C.LIMITS.minTokenCap, maxPrice: C.LIMITS.maxPrice },
    models: M.modelsForPage(),
    suggested: { monthlyTokenCap: M.SUGGESTED_MONTHLY_TOKENS, instruction: M.SUGGESTED_INSTRUCTION },
  });
});

// ── PUT /ai-analysis/config ──────────────────────────────────────────────────
router.put('/ai-analysis/config', configLimiter, async (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  const stored = configOf(target.id, req.user.id);
  const candidate = candidateOf(req, res, stored);
  if (!candidate) return;
  const { next, key } = candidate;

  // A new service, address, model or key is tested before it is saved.
  let test = null;
  if (C.needsTest(stored, next)) {
    test = await testConnection({ connector: next.connector, baseUrl: next.baseUrl, model: next.model, apiKey: key });
    if (!test.ok) {
      return res.status(422).json({ status: 422, title: 'Unprocessable Content',
        detail: `Not saved: the connection test failed. ${test.error}`, test: testView(test) });
    }
  }

  const keyEnc = next.apiKey ? encrypt(next.apiKey) : (stored?.api_key_enc ?? null);
  const testedAt = test ? new Date().toISOString() : stored.tested_at;
  run(`INSERT INTO ai_config (company_id, user_id, connector, base_url, model, api_key_enc, monthly_token_cap, instruction,
         tested_at, tested_base_url, tested_model, price_input, price_output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, user_id) DO UPDATE SET
         connector = excluded.connector, base_url = excluded.base_url, model = excluded.model,
         api_key_enc = excluded.api_key_enc, monthly_token_cap = excluded.monthly_token_cap,
         instruction = excluded.instruction, tested_at = excluded.tested_at,
         tested_base_url = excluded.tested_base_url, tested_model = excluded.tested_model,
         price_input = excluded.price_input, price_output = excluded.price_output,
         updated_at = datetime('now')`,
  [target.id, req.user.id, next.connector, next.baseUrl, next.model, keyEnc, next.monthlyTokenCap, next.instruction,
    testedAt, next.baseUrl, next.model, next.priceInput, next.priceOutput]);
  const fields = C.changedFields(stored, next);
  auditLog(req.user.id, target.id, req.user.email,
    `ai_config_saved:${next.connector}${fields.length ? ':' + fields.join(',') : ''}${test ? ':tested' : ''}`);

  return res.status(stored ? 200 : 201).json({
    config: C.configView(configOf(target.id, req.user.id)),
    test: test ? testView(test) : null,
  });
});

// ── POST /ai-analysis/config/test ────────────────────────────────────────────
// No body: test the stored service. A body: test it without saving.
router.post('/ai-analysis/config/test', testLimiter, async (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  const stored = configOf(target.id, req.user.id);
  const given = req.body && typeof req.body === 'object' && req.body.connector !== undefined;
  let config;
  if (given) {
    const candidate = candidateOf(req, res, stored);
    if (!candidate) return;
    const { next, key } = candidate;
    config = { connector: next.connector, baseUrl: next.baseUrl, model: next.model, apiKey: key };
  } else if (stored) {
    config = { connector: stored.connector, baseUrl: stored.base_url, model: stored.model, apiKey: storedKey(stored) };
  } else {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No AI service is configured here yet.' });
  }

  const test = await testConnection(config);
  if (!given && test.ok) {
    run(`UPDATE ai_config SET tested_at = ? WHERE company_id = ? AND user_id = ?`, [new Date().toISOString(), target.id, req.user.id]);
  }
  auditLog(req.user.id, target.id, req.user.email, `ai_config_tested:${config.connector}:${test.ok ? 'ok' : 'failed'}`);
  return res.json({ test: testView(test) });
});

// ── POST /ai-analysis/config/models (#831) ───────────────────────────────────
// No body: the stored service. A body { connector, baseUrl, apiKey? }: that
// one, the stored key going only where it was typed for (keyRefusal).
function modelsSource(req, res, stored) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.connector === undefined) {
    if (stored) return { connector: stored.connector, baseUrl: stored.base_url, apiKey: storedKey(stored) };
    refuse(res, 404, 'No AI service is configured here yet: give its kind, address and key.');
    return null;
  }
  if (b.connector !== 'anthropic') { refuse(res, 400, 'Only an Anthropic service gives its list of models: type the model.'); return null; }
  const urlProblem = C.baseUrlRefusal(b.baseUrl);
  if (urlProblem) { refuse(res, 400, urlProblem); return null; }
  const typed = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  const next = { connector: b.connector, baseUrl: b.baseUrl.trim(), apiKey: typed || undefined };
  const keyProblem = C.keyRefusal(stored, next);
  if (keyProblem) { refuse(res, 400, keyProblem); return null; }
  return { connector: next.connector, baseUrl: next.baseUrl, apiKey: typed || storedKey(stored) };
}

router.post('/ai-analysis/config/models', testLimiter, async (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  const config = modelsSource(req, res, configOf(target.id, req.user.id));
  if (!config) return;
  const listed = await listModels(config);
  if (!listed.ok) return res.status(502).json({ status: 502, title: 'Bad Gateway', detail: listed.error, upstreamStatus: listed.status ?? null });
  return res.json({ models: listed.models });
});

// ── DELETE /ai-analysis/config ───────────────────────────────────────────────
// Removing one's own service is always allowed, approved or not.
router.delete('/ai-analysis/config', configLimiter, (req, res) => {
  const target = configScope(req, res, { approved: false });
  if (!target) return;
  const stored = configOf(target.id, req.user.id);
  if (!stored) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No AI service is configured here.' });
  run('DELETE FROM ai_config WHERE company_id = ? AND user_id = ?', [target.id, req.user.id]);
  auditLog(req.user.id, target.id, req.user.email, `ai_config_removed:${stored.connector}`);
  return res.status(204).end();
});

module.exports = router;
module.exports.topCompanyOf = topCompanyOf;
module.exports.scopeForTestManager = scopeForTestManager;
module.exports.configScope = configScope;
module.exports.configOf = configOf;
module.exports.storedKey = storedKey;
