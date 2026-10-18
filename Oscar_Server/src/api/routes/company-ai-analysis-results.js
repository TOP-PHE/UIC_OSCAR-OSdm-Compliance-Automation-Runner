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
 *   GET  /v1/company/ai-analysis/spend          — what the analyses cost: today, this
 *                                                 month, per month and per model (#831)
 *
 * #831: the model may be chosen per analysis (`model`, the configured one by
 * default), so that one batch can be read by two models and the answers
 * compared; it is part of the hash the run confirms. Each analysis stores its
 * cost at the model's list price (aiModels.js), or at the price the Test
 * Manager entered for a model OSCAR does not know.
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
const path = require('node:path');
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
const { checklistOf } = require('./company-ai-checklist');
const CL = require('../../utils/checklistAnswers');
const MK = require('../../utils/aiMask');
const M = require('../../utils/aiModels');
const FD = require('../../utils/faultDetection');
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

// The scenario catalogue's entries (#827: their purpose), from the collection
// the runs use, else the repository's copy; none when neither can be read.
function catalogueEntries() {
  const candidates = [
    path.join(path.resolve(process.env.COLLECTION_PATH || '/collection'), 'data_base', 'scenario_catalogue.json'),
    path.resolve(__dirname, '../../../../Bruno_Collection/data_base/scenario_catalogue.json'),
  ];
  for (const file of candidates) {
    try {
      const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
      if (Array.isArray(entries)) return entries;
    } catch { /* the next copy */ }
  }
  return [];
}

// What the provider's checklist tells the model (#827), or null when none is imported.
function checklistContext(companyId) {
  const stored = checklistOf(companyId);
  return stored ? CL.contextOf(stored.answers) : null;
}

// The masked request and answer of one stored request of the company (#827
// PR C), or null when it has neither. Never its headers or URL.
function sampleReader(companyId) {
  const decrypted = (v) => { try { return v ? colDecrypt(v) : null; } catch { return null; } };
  return (requestId) => {
    const row = get('SELECT request_body, response_body FROM run_requests WHERE id = ? AND company_id = ?', [requestId, companyId]);
    if (!row) return null;
    const request = MK.maskBody(decrypted(row.request_body));
    const response = MK.maskBody(decrypted(row.response_body));
    return request === null && response === null ? null : { request, response };
  };
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

// The model of this analysis: the one asked (#831), else the configured one.
function modelFor(body, stored) {
  if (body?.model === undefined || body.model === null || body.model === '') return { value: stored?.model || null };
  return C.checkModel(body.model);
}

// The Test Manager's price for a model OSCAR has no price for.
const customOf = (stored) => M.customPrice(stored?.price_input ?? null, stored?.price_output ?? null);

async function buildFor(target, user, body) {
  const stored = configOf(target.id, user.id);
  const model = modelFor(body, stored);
  if (model.refusal) return { refusal: [400, model.refusal] };
  const chosen = chosenBatches(target.id, body);
  if (chosen.refusal) return chosen;
  const batches = chosen.batches.map((b) => {
    const records = failuresOfBatch(target.id, b.batchId);
    return { ...b, records, truncated: records.length >= MAX_FAILURES };
  });
  const findings = all('SELECT * FROM finding WHERE company_id = ?', [target.id]).map(toApiFinding);
  const framework = frameworkOf(target.id);
  const built = AN.buildInput({ batches, framework, findings, scenarios: await scenariosOf(target.id),
    catalogue: catalogueEntries(), checklist: checklistContext(target.id), sampleOf: sampleReader(target.id) });
  const system = AN.systemPrompt({ language: languageOf(body), instruction: stored?.instruction || null, compare: batches.length === 2,
    osdmVersion: framework?.osdmVersion || null });
  return { batches, built, system, model: model.value, hash: AN.inputHash(system, built.text, model.value),
    contentHash: AN.inputHash(system, built.text), stored, price: M.priceOf(model.value, customOf(stored)) };
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
  const estimatedTokens = AN.estimateTokens(plan.system) + built.estimatedTokens;
  res.json({
    batches: plan.batches.map(({ records, truncated, ...b }) => ({ ...b, failedChecks: records.length, truncated })),
    mode: plan.batches.length === 2 ? 'compare' : 'one',
    connector: plan.stored.connector, model: plan.model, configuredModel: plan.stored.model,
    price: plan.price, estimatedCost: M.estimateOf(plan.price, estimatedTokens, AN.MAX_ANSWER_TOKENS),
    contentHash: plan.contentHash,
    instructions: plan.system,
    input: built.text,
    chars: built.chars + plan.system.length,
    estimatedTokens,
    summarisedByStep: built.summarisedByStep,
    tooLarge: built.tooLarge,
    counts: built.counts,
    monthly: monthly(plan.stored, target.id, req.user.id),
    hash: plan.hash,
  });
});

// ── POST /ai-analysis/run ────────────────────────────────────────────────────

function finish(id, fields) {
  run(`UPDATE ai_analysis SET status = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, result_enc = ?, error = ?, finished_at = datetime('now')
        WHERE id = ?`, [fields.status, fields.input ?? null, fields.output ?? null, fields.cost ?? null,
    fields.result ? colEncrypt(JSON.stringify(fields.result)) : null, fields.error ?? null, id]);
}

async function carryOut(id, config, request, { compare, price }, audit) {
  try {
    const answer = await callModel(config, request, { timeoutMs: ANALYSIS_TIMEOUT_MS, purpose: 'analysis' });
    if (!answer.ok) {
      finish(id, { status: 'failed', error: answer.error });
      audit(`ai_analysis_failed:${id}`);
      return;
    }
    const read = AN.readResult(answer.text, { compare });
    const tokens = { input: answer.usage?.input, output: answer.usage?.output };
    tokens.cost = M.costOf(price, tokens);
    if (read.ok) {
      finish(id, { status: 'done', ...tokens, result: read.result });
    } else {
      finish(id, { status: 'unreadable', ...tokens, error: read.reason, result: { raw: String(answer.text).slice(0, 20000) } });
    }
    audit(`ai_analysis_${read.ok ? 'done' : 'unreadable'}:${id}:in=${tokens.input ?? '?'}:out=${tokens.output ?? '?'}`
      + (tokens.cost === null ? '' : `:usd=${tokens.cost}`));
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
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, batch_b, language, connector, model, input_hash, content_hash,
         input_chars, summarised)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, target.id, req.user.id, compare ? 'compare' : 'one', plan.batches[0].batchId, compare ? plan.batches[1].batchId : null,
    languageOf(req.body), stored.connector, plan.model, plan.hash, plan.contentHash, plan.built.chars, plan.built.summarisedByStep ? 1 : 0]);
  const audit = (event) => auditLog(req.user.id, target.id, req.user.email, event);
  audit(`ai_analysis_started:${id}:${compare ? 'compare' : 'one'}:${stored.connector}:${plan.model}`);

  const config = { connector: stored.connector, baseUrl: stored.base_url, model: plan.model, apiKey: storedKey(stored) };
  const request = C.messageRequest(config, { system: plan.system, user: plan.built.text, maxTokens: AN.MAX_ANSWER_TOKENS });
  // Runs after the answer. carryOut catches its own errors; the catch here only logs.
  carryOut(id, config, request, { compare, price: plan.price }, audit).catch((err) => log.error({ err: err.message, id }, 'AI analysis: unexpected rejection'));
  res.status(202).json({ id, status: 'running' });
});

// ── History ──────────────────────────────────────────────────────────────────

function statusOf(row) {
  if (row.status === 'running' && Date.parse(row.created_at.replace(' ', 'T') + 'Z') < Date.now() - STALE_AFTER_MS) return 'interrupted';
  return row.status;
}

// The stored cost, else (an analysis from before #831) the list price now.
function costView(row) {
  if (Number.isFinite(row.cost_usd)) return row.cost_usd;
  return M.costOf(M.priceOf(row.model), { input: row.input_tokens, output: row.output_tokens });
}

function rowView(row) {
  const user = get('SELECT email FROM users WHERE id = ?', [row.user_id]);
  return {
    id: row.id, mode: row.mode, batches: [row.batch_a, row.batch_b].filter(Boolean), language: row.language,
    connector: row.connector, model: row.model, status: statusOf(row), by: user?.email || null,
    inputChars: row.input_chars, summarisedByStep: !!row.summarised, inputHash: row.input_hash,
    tokens: { input: row.input_tokens, output: row.output_tokens }, error: row.error || null,
    cost: costView(row), contentHash: row.content_hash || null,
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

// ── GET /ai-analysis/fault-detection (#833 PR D) ─────────────────────────────
// For a batch run against the OSDM simulator with faults asked for
// (`simulatorFaults`): which faults OSCAR detected, and, with `analysis`,
// whether that AI analysis explained them. Reads the runs only: no model is
// called. Any Test Manager of the company or provider, like the history.

const MAX_FAULT_EVENTS = 20000;

// The [WARNING] lines the runs logged (a log row may hold several lines).
function warningsOf(runIds) {
  if (!runIds.length) return [];
  const rows = all(
    `SELECT run_id, message FROM run_events WHERE run_id IN (${runIds.map(() => '?').join(', ')}) ORDER BY id ASC LIMIT ?`,
    [...runIds, MAX_FAULT_EVENTS]
  );
  const out = [];
  for (const row of rows) {
    let text = '';
    try { text = colDecrypt(row.message) || ''; } catch { text = ''; }
    for (const line of String(text).split('\n')) {
      if (line.includes('[WARNING]')) out.push({ runId: row.run_id, message: line.trim() });
    }
  }
  return out;
}

router.get('/ai-analysis/fault-detection', readLimiter, async (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const batchId = typeof req.query.batch === 'string' ? req.query.batch : '';
  const runs = batchId ? runsOfBatch(req.companyId, batchId) : [];
  if (!runs.length) return refuse(res, 404, 'No batch with that id here.');
  const scenarios = await scenariosOf(req.companyId);
  const faulty = new Set(scenarios.filter((s) => FD.faultsOfScenario(s).length).map((s) => s.code));
  const judged = runs.filter((r) => faulty.has(r.scenario_code));
  const ids = new Set(judged.map((r) => r.id));
  const report = FD.detect({
    runs: judged.map((r) => ({ runId: r.id, scenarioCode: r.scenario_code })),
    scenarios,
    failures: failuresOfBatch(req.companyId, batchId).filter((f) => ids.has(f.runId)).map((f) => ({ runId: f.runId, step: f.step, check: f.check })),
    warnings: warningsOf([...ids]),
  });
  let analysis = null;
  if (typeof req.query.analysis === 'string' && req.query.analysis) {
    const row = get('SELECT * FROM ai_analysis WHERE id = ? AND company_id = ?', [req.query.analysis, req.companyId]);
    if (!row) return refuse(res, 404, 'No analysis with that id here.');
    if (![row.batch_a, row.batch_b].includes(batchId)) return refuse(res, 400, 'That analysis did not read this batch.');
    let result = null;
    if (row.result_enc) {
      try { result = JSON.parse(colDecrypt(row.result_enc)); } catch { result = null; }
    }
    analysis = { id: row.id, model: row.model, status: statusOf(row), ...FD.scoreAnalysis(report, result) };
  }
  res.json({ batch: batchId, runs: runs.length, ...report, analysis });
});

// ── GET /ai-analysis/spend (#831) ────────────────────────────────────────────
// Every Test Manager's analyses of this company or provider, like the history;
// `mine` is the reader's own use this month, against their limit.
router.get('/ai-analysis/spend', readLimiter, (req, res) => {
  const company = scopeForTestManager(req, res);
  if (!company) return;
  const rows = all(`SELECT created_at, model, input_tokens, output_tokens, cost_usd FROM ai_analysis
                     WHERE company_id = ? AND created_at >= datetime('now', 'start of month', '-11 months')`, [req.companyId]);
  const stored = configOf(req.companyId, req.user.id);
  res.json({ currency: 'USD', ...M.spendOf(rows, new Date()), mine: monthly(stored, req.companyId, req.user.id) });
});

module.exports = router;
module.exports.ANALYSIS_TIMEOUT_MS = ANALYSIS_TIMEOUT_MS;
