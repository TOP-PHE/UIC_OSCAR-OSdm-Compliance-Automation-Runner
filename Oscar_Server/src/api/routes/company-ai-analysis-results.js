// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-ai-analysis-results.js — the AI analysis itself (#801, PR 3).
 *
 *   GET  /v1/company/ai-analysis/batches        — the batches that can be read
 *   POST /v1/company/ai-analysis/preview        — { batches: [id] | [id, id], language }:
 *                                                 exactly what would be sent, its size,
 *                                                 its estimated tokens and its hash
 *   POST /v1/company/ai-analysis/run            — the same, plus { hash } of the preview
 *                                                 confirmed: starts the analysis (202)
 *   GET  /v1/company/ai-analysis/history        — the analyses of this company or provider
 *   GET  /v1/company/ai-analysis/history/:id    — one, with its result
 *
 * The company or provider is the request's (X-Provider-Id), as everywhere.
 * Running one needs the Test Manager's approved access and their configured
 * AI service there (part 1 and 2). Reading the history needs only to be a
 * Test Manager who may use the company or provider: canUseCompany(), through
 * enforceTenant, is the one rule.
 *
 * The call runs after the answer (202): a model may take minutes. Its row
 * says `running` until it ends; one left running by a restart reads as
 * interrupted after STALE_AFTER_MS.
 */

const express = require('express');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { get, all, run, colDecrypt, colEncrypt } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const { toApiFinding } = require('../helpers/findings');
const { failuresOfBatch, batchesOf, runsOfBatch, MAX_FAILURES } = require('../helpers/batchFailures');
const { decryptFromFileAsync } = require('../../utils/at-rest');
const C = require('../../utils/aiConfig');
const AN = require('../../utils/aiAnalysis');
const { callModel } = require('../../services/aiConnector');
const { scopeForTestManager, configScope, configOf, storedKey } = require('./company-ai-analysis');
const log = require('../../utils/logger').child({ module: 'company-ai-analysis-results' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});
// Each analysis is billed to the company's account.
const runLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many analyses in an hour — please wait a moment.' },
});

const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = ANALYSIS_TIMEOUT_MS + 60 * 1000;

const refuse = (res, status, detail) => res.status(status).json({ status, title: {
  400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Content',
}[status] || 'Error', detail });

// ── What is sent ─────────────────────────────────────────────────────────────

async function scenariosOf(companyId) {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!row?.datafile_path || !fs.existsSync(row.datafile_path)) return [];
  try {
    const df = JSON.parse((await decryptFromFileAsync(row.datafile_path)).toString('utf8'));
    return Array.isArray(df?.scenarios) ? df.scenarios.filter((x) => x && typeof x === 'object') : [];
  } catch (err) {
    log.warn({ err: err.message, companyId }, 'AI analysis: data file unreadable, scenarios sent without descriptions');
    return [];
  }
}

function frameworkOf(companyId) {
  const row = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
  if (!row) return null;
  try { return JSON.parse(colDecrypt(row.config)); } catch { return null; }
}

// The batches a request names, earlier first, or the refusal to send.
function chosenBatches(companyId, body) {
  const ids = body?.batches;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.every((x) => typeof x === 'string' && x.trim() && x.length <= 100)) {
    return { refusal: [400, 'Choose one batch, or two to compare.'] };
  }
  if (ids.length === 2 && ids[0] === ids[1]) return { refusal: [400, 'Choose two different batches to compare.'] };
  const known = new Map(batchesOf(companyId).map((b) => [b.batchId, b]));
  const batches = [];
  for (const id of ids) {
    const runs = runsOfBatch(companyId, id);
    if (runs.length === 0) return { refusal: [404, 'No batch of this company or provider with that id.'] };
    const meta = known.get(id) || { batchId: id, runs: runs.length, finishedRuns: 0, started: null };
    batches.push(meta);
  }
  batches.sort((a, b) => String(a.started || '').localeCompare(String(b.started || '')));
  return { batches };
}

const languageOf = (body) => (AN.LANGUAGES.includes(body?.language) ? body.language : 'English');

async function buildFor(target, user, body) {
  const chosen = chosenBatches(target.id, body);
  if (chosen.refusal) return chosen;
  const batches = chosen.batches.map((b) => {
    const records = failuresOfBatch(target.id, b.batchId);
    return { ...b, records, truncated: records.length >= MAX_FAILURES };
  });
  const findings = all('SELECT * FROM finding WHERE company_id = ?', [target.id]).map(toApiFinding);
  const built = AN.buildInput({ batches, framework: frameworkOf(target.id), findings, scenarios: await scenariosOf(target.id) });
  const stored = configOf(target.id, user.id);
  const system = AN.systemPrompt({ language: languageOf(body), instruction: stored?.instruction || null, compare: batches.length === 2 });
  return { batches, built, system, hash: AN.inputHash(system, built.text), stored };
}

// Tokens this Test Manager's analyses used this month, for this company or provider.
function tokensThisMonth(companyId, userId) {
  const row = get(`SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS used
                     FROM ai_analysis
                    WHERE company_id = ? AND user_id = ? AND created_at >= datetime('now', 'start of month')`, [companyId, userId]);
  return row?.used || 0;
}

function monthly(stored, companyId, userId) {
  return { cap: stored?.monthly_token_cap ?? null, used: tokensThisMonth(companyId, userId) };
}

// ── GET /ai-analysis/batches ─────────────────────────────────────────────────
router.get('/ai-analysis/batches', readLimiter, (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  res.json({ batches: batchesOf(target.id), languages: AN.LANGUAGES });
});

// ── POST /ai-analysis/preview ────────────────────────────────────────────────
router.post('/ai-analysis/preview', readLimiter, async (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  const plan = await buildFor(target, req.user, req.body);
  if (plan.refusal) return refuse(res, ...plan.refusal);
  if (!plan.stored) return refuse(res, 409, 'Configure the AI service of this company or provider first.');
  const { built } = plan;
  res.json({
    batches: plan.batches.map(({ records, truncated, ...b }) => ({ ...b, failedChecks: records.length, truncated })),
    mode: plan.batches.length === 2 ? 'compare' : 'one',
    connector: plan.stored.connector, model: plan.stored.model,
    instructions: plan.system,
    input: built.text,
    chars: built.chars + plan.system.length,
    estimatedTokens: AN.estimateTokens(plan.system) + built.estimatedTokens,
    summarisedByStep: built.summarisedByStep,
    tooLarge: built.tooLarge,
    counts: built.counts,
    monthly: monthly(plan.stored, target.id, req.user.id),
    hash: plan.hash,
  });
});

// ── POST /ai-analysis/run ────────────────────────────────────────────────────

function finish(id, fields) {
  run(`UPDATE ai_analysis SET status = ?, input_tokens = ?, output_tokens = ?, result_enc = ?, error = ?, finished_at = datetime('now')
        WHERE id = ?`, [fields.status, fields.input ?? null, fields.output ?? null, fields.result ? colEncrypt(JSON.stringify(fields.result)) : null,
    fields.error ?? null, id]);
}

async function carryOut(id, config, request, compare, audit) {
  try {
    const answer = await callModel(config, request, { timeoutMs: ANALYSIS_TIMEOUT_MS, purpose: 'analysis' });
    if (!answer.ok) {
      finish(id, { status: 'failed', error: answer.error });
      audit(`ai_analysis_failed:${id}`);
      return;
    }
    const read = AN.readResult(answer.text, { compare });
    const tokens = { input: answer.usage?.input, output: answer.usage?.output };
    if (read.ok) {
      finish(id, { status: 'done', ...tokens, result: read.result });
    } else {
      finish(id, { status: 'unreadable', ...tokens, error: read.reason, result: { raw: String(answer.text).slice(0, 20000) } });
    }
    audit(`ai_analysis_${read.ok ? 'done' : 'unreadable'}:${id}:in=${tokens.input ?? '?'}:out=${tokens.output ?? '?'}`);
  } catch (err) {
    log.error({ err: err.message, id }, 'AI analysis failed unexpectedly');
    finish(id, { status: 'failed', error: 'The analysis failed on the OSCAR server.' });
  }
}

router.post('/ai-analysis/run', runLimiter, async (req, res) => {
  const target = configScope(req, res);
  if (!target) return;
  const plan = await buildFor(target, req.user, req.body);
  if (plan.refusal) return refuse(res, ...plan.refusal);
  const stored = plan.stored;
  if (!stored) return refuse(res, 409, 'Configure the AI service of this company or provider first.');
  if (req.body?.hash !== plan.hash) {
    return refuse(res, 409, 'What would be sent has changed since the preview (new results, findings or settings). Look at the preview again.');
  }
  if (plan.built.tooLarge) return refuse(res, 422, 'These batches are too large to send, even summarised by step.');
  const m = monthly(stored, target.id, req.user.id);
  const estimate = AN.estimateTokens(plan.system) + plan.built.estimatedTokens;
  if (m.cap !== null && m.used + estimate > m.cap) {
    return refuse(res, 409, `Your monthly token limit here is ${m.cap}; ${m.used} are used, and this analysis needs about ${estimate} more.`);
  }
  if (get("SELECT id FROM ai_analysis WHERE user_id = ? AND status = 'running' AND created_at >= datetime('now', ?)",
    [req.user.id, `-${Math.round(STALE_AFTER_MS / 1000)} seconds`])) {
    return refuse(res, 409, 'One of your analyses is still running. Wait for it to end.');
  }

  const id = randomUUID();
  const compare = plan.batches.length === 2;
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, batch_b, language, connector, model, input_hash, input_chars, summarised)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, target.id, req.user.id, compare ? 'compare' : 'one', plan.batches[0].batchId, compare ? plan.batches[1].batchId : null,
    languageOf(req.body), stored.connector, stored.model, plan.hash, plan.built.chars, plan.built.summarisedByStep ? 1 : 0]);
  const audit = (event) => auditLog(req.user.id, target.id, req.user.email, event);
  audit(`ai_analysis_started:${id}:${compare ? 'compare' : 'one'}:${stored.connector}:${stored.model}`);

  const config = { connector: stored.connector, baseUrl: stored.base_url, model: stored.model, apiKey: storedKey(stored) };
  const request = C.messageRequest(config, { system: plan.system, user: plan.built.text, maxTokens: AN.MAX_ANSWER_TOKENS });
  // Runs after the answer. carryOut catches its own errors; the catch here only logs.
  carryOut(id, config, request, compare, audit).catch((err) => log.error({ err: err.message, id }, 'AI analysis: unexpected rejection'));
  res.status(202).json({ id, status: 'running' });
});

// ── History ──────────────────────────────────────────────────────────────────

function statusOf(row) {
  if (row.status === 'running' && Date.parse(row.created_at.replace(' ', 'T') + 'Z') < Date.now() - STALE_AFTER_MS) return 'interrupted';
  return row.status;
}

function rowView(row) {
  const user = get('SELECT email FROM users WHERE id = ?', [row.user_id]);
  return {
    id: row.id, mode: row.mode, batches: [row.batch_a, row.batch_b].filter(Boolean), language: row.language,
    connector: row.connector, model: row.model, status: statusOf(row), by: user?.email || null,
    inputChars: row.input_chars, summarisedByStep: !!row.summarised, inputHash: row.input_hash,
    tokens: { input: row.input_tokens, output: row.output_tokens }, error: row.error || null,
    createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

router.get('/ai-analysis/history', readLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const rows = all('SELECT * FROM ai_analysis WHERE company_id = ? ORDER BY created_at DESC LIMIT 50', [req.companyId]);
  res.json({ analyses: rows.map(rowView) });
});

router.get('/ai-analysis/history/:id', readLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const row = get('SELECT * FROM ai_analysis WHERE id = ? AND company_id = ?', [String(req.params.id), req.companyId]);
  if (!row) return refuse(res, 404, 'No analysis with that id here.');
  let result = null;
  if (row.result_enc) {
    try { result = JSON.parse(colDecrypt(row.result_enc)); } catch { result = null; }
  }
  res.json({ ...rowView(row), result });
});

module.exports = router;
module.exports.ANALYSIS_TIMEOUT_MS = ANALYSIS_TIMEOUT_MS;
