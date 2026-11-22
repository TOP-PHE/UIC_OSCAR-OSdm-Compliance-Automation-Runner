// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-test-requests.js — a Company API account asks for tests and reads
 * their verdicts (#1342 PR 3). The handlers are registered on the /v1/api
 * router (api.js), so the caller is already a key or an account, with its
 * scopes checked there.
 *
 *   POST /v1/api/test-requests        — run scenarios on one or more providers (runs:write)
 *     { providers: [id], scenarios: [code] | selection: {…} | suite: name, reference }
 *     Idempotency-Key: <key>  (optional: asked again, the same answer)
 *   GET  /v1/api/test-requests/:id    — its state and verdicts (runs:read)
 *     ?wait=<seconds>  (at most 60: answers as soon as it is finished; five
 *     waits at a time an account, a cheap count while waiting)
 *   GET  /v1/api/test-requests/:id/results — where each run failed and warned
 *     ?format=json | junit  (PR 5: JUnit XML for a CI tool)
 *
 * Only a Company API account launches; a read-only key gets 403. Everything
 * is checked for every provider before anything is queued: a provider the
 * account may not use is 404, one that cannot run (endpoint suspended,
 * endpoint, the account's credentials or the data file missing) is 409, and
 * nothing is queued anywhere. The account sees the company's shared
 * scenarios, never a tester's own (viewForTester's rule, visibleCodes()).
 * Answers name runs, codes, states, verdicts and check counts, never a body,
 * a log or a person; each run carries the address of its page in OSCAR.
 */

const rateLimit = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const { get, all, run } = require('../../db/db');
const { auditLog } = require('../helpers/shared');
const { canUseCompany } = require('../helpers/provider-access');
const { launchReadiness, enqueueBatch, waitingRoomRefusal } = require('../helpers/runLaunch');
const { facetsFor } = require('../helpers/runCandidates');
const { visibleCodes } = require('../../utils/datafileOwnership');
const RF = require('../../utils/runFilters');
const TR = require('../../utils/testRequests');
const S = require('../../utils/testSuites');
const Tokens = require('../../utils/apiAccessTokens');
const { detailOf } = require('../helpers/runDetail');
const { junitOf } = require('../../utils/junitReport');

// Per account: a CI pipeline asks a few times an hour.
const launchLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `test-request:${req.apiAccount?.id || req.user?.id}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'At most 30 test requests in 10 minutes for an account.' },
});

const NOT_FOUND = Object.freeze({ status: 404, title: 'Not Found', detail: 'No such test request.' });
const problem = (res, status, title, detail, extra = {}) => res.status(status).json({ status, title, detail, ...extra });

const COUNTS_SQL = `SELECT COUNT(*) AS total, SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed
  FROM run_assertions WHERE run_id = ?`;

// One run as a test request shows it; with `withDetail`, where it failed and
// warned (runDetail.js). A passing run's detail is read anyway, once and kept,
// to tell a pass with a known deviation.
function runAnswer(r, base, withDetail = false) {
  const counts = get(COUNTS_SQL, [r.id]) || {};
  const total = Number(counts.total) || 0;
  const failed = Number(counts.failed) || 0;
  const plain = TR.verdictOf(r, failed, total);
  const detail = withDetail || plain.verdict === 'passed' ? detailOf(r) : null;
  return {
    id: r.id,
    scenario_code: r.scenario_code,
    ...TR.verdictOf(r, failed, total, detail ? detail.deviations.length : 0),
    ...(withDetail ? detail : {}),
    checks: { total, passed: total - failed, failed },
    queued_at: r.queued_at || null,
    started_at: r.started_at || null,
    completed_at: r.completed_at || null,
    run_url: base ? `${base}/run-detail.html?id=${encodeURIComponent(r.id)}` : null,
  };
}

// The test request as stored, with each provider's runs as they are now.
function requestAnswer(row, base, withDetail = false) {
  const batches = JSON.parse(row.batches || '[]');
  const asked = JSON.parse(row.request);
  const everyRun = [];
  const providers = batches.map((b) => {
    const company = get('SELECT name FROM companies WHERE id = ?', [b.company_id]);
    const runs = b.batch_id
      ? all(`SELECT id, status, error_message, scenario_code, queued_at, started_at, completed_at FROM runs
              WHERE batch_id = ? AND company_id = ? AND user_id = ? ORDER BY +queued_at ASC, id ASC`,
      [b.batch_id, b.company_id, row.user_id]).map(r => runAnswer(r, base, withDetail))
      : [];
    everyRun.push(...runs);
    return { id: b.company_id, name: company?.name || null, batch_id: b.batch_id, not_found: b.not_found || [], ...TR.summaryOf(runs), runs };
  });
  return {
    id: row.id,
    reference: row.reference,
    created_at: row.created_at,
    asked: { scenarios: asked.scenarios || null, selection: asked.selection || null, suite: asked.suite || null },
    ...TR.summaryOf(everyRun),
    providers,
  };
}

const requestRow = (id, accountId) => get('SELECT * FROM test_request WHERE id = ? AND user_id = ?', [id, accountId]);

// Every provider is checked before anything is queued: { plans } or { refusal: [status, body] }.
// A provider that cannot run, as the API answers it: 404 when it is not
// there, else 409, naming the provider.
const companyName = companyId => get('SELECT name FROM companies WHERE id = ?', [companyId])?.name || companyId;

function providerRefusal(companyId, [status, body]) {
  const code = status === 404 ? 404 : 409;
  return [code, { ...body, status: code, title: code === 404 ? 'Not Found' : 'Conflict', detail: `${companyName(companyId)}: ${body.detail || body.title}`, provider: companyId }];
}

// At most this many codes a provider in the words of a refusal; the body lists them all.
const CODES_SAID = 5;

// Why nothing would run, in words (#1355): what each provider lacks, and the two
// reasons met in practice (a private scenario, another provider's code).
function nothingToRunText(request, plans) {
  if (request.scenarios) {
    const where = plans.map((p) => {
      const more = p.notFound.length > CODES_SAID ? ` and ${p.notFound.length - CODES_SAID} more` : '';
      return `${companyName(p.companyId)}: ${p.notFound.slice(0, CODES_SAID).join(', ')}${more}`;
    }).join('; ');
    return `Nothing would run: no scenario asked is a shared scenario of a provider named (${where}). `
      + 'The account runs shared scenarios only: one kept private in Test Config is not seen. Each code must be that provider\'s own.';
  }
  const what = request.suite ? `The suite "${request.suite}"` : 'The selection';
  return `Nothing would run: ${what} keeps no shared scenario on any provider named. `
    + 'The account runs shared scenarios only; on the run list, each provider runs what its own Test Config selects.';
}

// The scenarios a selection is cut from on one provider (#1353). With the run
// list as its base, that provider's run list as its Test Config sets it
// (`scenariosToRun`; none set or ALL = every scenario), among those `seen`, in
// the list's order: each provider runs its own. Else every scenario seen. A
// tester's personal run list is never read: a suite is the company's.
function selectionBaseOf(selection, datafile, seen) {
  if (selection?.base !== 'list' || !Array.isArray(datafile.scenariosToRun)) return seen;
  const known = new Set(seen);
  return [...new Set(datafile.scenariosToRun)].filter(c => known.has(c));
}

// What one provider runs of the request, among the scenarios `seen` there: { codes, notFound }.
async function codesFor(request, companyId, datafile, seen, user) {
  if (request.scenarios) {
    return { codes: request.scenarios.filter(c => seen.includes(c)), notFound: request.scenarios.filter(c => !seen.includes(c)) };
  }
  const selectedBy = async selection => RF.selectCodes(await facetsFor(companyId, datafile, selectionBaseOf(selection, datafile, seen), user), selection);
  if (request.suiteFound) {
    // A suite: the codes its selection keeps, then the codes it lists (#1342 PR 4).
    const suite = request.suiteFound;
    return S.suiteCodes(suite, seen, suite.selection ? await selectedBy(suite.selection) : null);
  }
  return { codes: await selectedBy(request.selection), notFound: [] };
}

async function plansFor(request, req) {
  const account = req.apiAccount;
  const plans = [];
  // One provider at a time, on purpose: each decrypts its data file and reads its
  // runs' facets in slices (#1256); all at once would hold the server's thread longer.
  for (const companyId of request.providers) {
    if (!canUseCompany(req.user, companyId)) {
      return { refusal: [404, { status: 404, title: 'Not Found', detail: `Unknown company or provider, or one this account is not given: ${companyId}.`, provider: companyId }] };
    }
    const ready = launchReadiness(account.id, companyId);
    if (ready.refusal) return { refusal: providerRefusal(companyId, ready.refusal) };
    // The company's shared scenarios and the old ones without an owner, never a tester's own.
    const seen = visibleCodes(ready.datafile, req.user.email).filter(c => typeof c === 'string' && c !== '');
    const { codes, notFound } = await codesFor(request, companyId, ready.datafile, seen, req.user);
    plans.push({ companyId, ready, codes, notFound });
  }
  return { plans };
}

// A suite is the company's, asked by its name (without case): found, it is
// request.suiteFound and the answer is true.
function findSuite(request, account) {
  const found = get('SELECT selection, codes FROM test_suite WHERE company_id = ? AND lower(name) = lower(?)', [account.companyId, request.suite]);
  if (!found) return false;
  request.suiteFound = { selection: found.selection ? JSON.parse(found.selection) : null, codes: found.codes ? JSON.parse(found.codes) : null };
  return true;
}

// A request asked again with its Idempotency-Key: the same answer (200), or a refusal.
function answerAgain(res, earlier, hash, base) {
  if (earlier.request_hash !== hash) return problem(res, 422, 'Unprocessable Entity', 'This Idempotency-Key was used for another request.');
  if (!earlier.batches) return problem(res, 409, 'Conflict', 'This request is still being made: ask again in a moment.');
  return res.status(200).location(`/v1/api/test-requests/${earlier.id}`).json(requestAnswer(earlier, base));
}

// One batch per provider with something to run: [{ company_id, batch_id, not_found }].
function queueAll(plans, account, request) {
  return plans.map((p) => {
    if (p.codes.length === 0) return { company_id: p.companyId, batch_id: null, not_found: p.notFound };
    const { company, credentials, concurrentLimit } = p.ready;
    // The batch keeps what it was chosen by: the selection, or the suite's (#1342 PR 4).
    const made = enqueueBatch({ companyId: p.companyId, userId: account.id, company, credentials, codes: p.codes, concurrentLimit,
      selection: request.selection || request.suiteFound?.selection || undefined });
    return { company_id: p.companyId, batch_id: made.batchId, not_found: p.notFound };
  });
}

async function launchHandler(req, res) {
  if (!req.apiAccount) {
    return problem(res, 403, 'Forbidden', 'A read-only API key does not launch tests: a Company API account does, with an access token holding runs:write.');
  }
  const account = req.apiAccount;
  const request = TR.requestOf(req.body);
  if (request.error) return problem(res, 400, 'Bad Request', request.error);
  const idempotency = TR.idempotencyKeyOf(req.get('Idempotency-Key'));
  if (idempotency.error) return problem(res, 400, 'Bad Request', idempotency.error);
  const key = idempotency.key;
  const hash = TR.hashOf(request);
  const base = Tokens.oscarBase(req);

  // The same Idempotency-Key: the same answer, or a refusal if it asked something else.
  const earlier = key ? get('SELECT * FROM test_request WHERE user_id = ? AND idempotency_key = ?', [account.id, key]) : null;
  if (earlier) return answerAgain(res, earlier, hash, base);

  if (request.suite && !findSuite(request, account)) {
    return problem(res, 404, 'Not Found', `Your company has no suite named "${request.suite}". GET /v1/api/suites lists them.`);
  }

  const planned = await plansFor(request, req);
  if (planned.refusal) return res.status(planned.refusal[0]).json(planned.refusal[1]);
  if (planned.plans.every(p => p.codes.length === 0)) {
    return problem(res, 400, 'Bad Request', nothingToRunText(request, planned.plans),
      { not_found: planned.plans.map(p => ({ provider: p.companyId, name: companyName(p.companyId), codes: p.notFound })) });
  }

  // #1369: the runs the account already has queued or running, plus those of
  // every provider of this request, must fit under the ceiling. Refused
  // before the request is recorded: its Idempotency-Key is not used up, and
  // nothing is queued for any provider.
  const full = waitingRoomRefusal(account.id, planned.plans.reduce((sum, p) => sum + p.codes.length, 0));
  if (full) return res.status(full[0]).json(full[1]);

  // The key is taken before anything is queued: two calls at once with it queue once.
  const id = randomUUID();
  try {
    run(`INSERT INTO test_request (id, user_id, company_id, reference, idempotency_key, request_hash, request)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, account.id, account.companyId, request.reference, key, hash,
      JSON.stringify({ providers: request.providers, scenarios: request.scenarios, selection: request.selection, suite: request.suite })]);
  } catch {
    return problem(res, 409, 'Conflict', 'This Idempotency-Key was just used: ask again in a moment.');
  }
  const batches = queueAll(planned.plans, account, request);
  run('UPDATE test_request SET batches = ? WHERE id = ?', [JSON.stringify(batches), id]);
  auditLog(account.id, account.companyId, req.user.email,
    `test_request_launched:${id}:${batches.filter(b => b.batch_id).length} provider(s)`);
  return res.status(202).location(`/v1/api/test-requests/${id}`).json(requestAnswer(requestRow(id, account.id), base));
}

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Long polls an account holds at once: beyond, a call answers at once.
const MAX_WAITING = 5;
const waiting = new Map();

// The test request's runs still queued or running: one indexed count per
// provider (runs(company_id, batch_id)), never the whole answer.
function runsGoing(row) {
  let going = 0;
  for (const b of JSON.parse(row.batches || '[]')) {
    if (!b.batch_id) continue;
    going += get(`SELECT COUNT(*) AS n FROM runs WHERE company_id = ? AND batch_id = ? AND user_id = ? AND status IN ('QUEUED', 'RUNNING')`,
      [b.company_id, b.batch_id, row.user_id]).n;
  }
  return going;
}

// Waits until the request's runs are all finished, the wait ends or the
// caller leaves (`gone()`), looking every 2 s.
async function waitFor(row, deadline, gone) {
  while (runsGoing(row) > 0 && Date.now() < deadline && !gone()) {
    await pause(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

async function readHandler(req, res) {
  if (!req.apiAccount) return res.status(404).json(NOT_FOUND);
  const wait = TR.waitOf(req.query.wait);
  if (wait === null) return problem(res, 400, 'Bad Request', `wait must be a whole number of seconds from 0 to ${TR.MAX_WAIT_S}.`);
  const id = String(req.params.id);
  const accountId = req.apiAccount.id;
  if (!requestRow(id, accountId)?.batches) return res.status(404).json(NOT_FOUND);
  const held = waiting.get(accountId) || 0;
  if (wait > 0 && held < MAX_WAITING) {
    // The response's close before it is sent is the caller leaving.
    let closed = false;
    res.on('close', () => { closed = true; });
    waiting.set(accountId, held + 1);
    try {
      await waitFor(requestRow(id, accountId), Date.now() + wait * 1000, () => closed);
    } finally {
      const left = (waiting.get(accountId) || 1) - 1;
      if (left > 0) waiting.set(accountId, left); else waiting.delete(accountId);
    }
    if (closed) return undefined;
  }
  // The answer is built once, as the request is now.
  const row = requestRow(id, accountId);
  if (!row) return res.status(404).json(NOT_FOUND);
  return res.json(requestAnswer(row, Tokens.oscarBase(req)));
}

// GET /v1/api/test-requests/:id/results (?format=junit): where each run failed
// and warned, as JSON, or as JUnit XML for a CI tool. Results only (D4).
function resultsHandler(req, res) {
  if (!req.apiAccount) return res.status(404).json(NOT_FOUND);
  const format = req.query.format === undefined ? 'json' : req.query.format;
  if (format !== 'json' && format !== 'junit') return problem(res, 400, 'Bad Request', 'format must be json or junit.');
  const row = requestRow(String(req.params.id), req.apiAccount.id);
  if (!row?.batches) return res.status(404).json(NOT_FOUND);
  const answer = requestAnswer(row, Tokens.oscarBase(req), true);
  if (format === 'junit') return res.type('application/xml').send(junitOf(answer));
  return res.json(answer);
}

module.exports = { launchLimiter, launchHandler, readHandler, resultsHandler };
