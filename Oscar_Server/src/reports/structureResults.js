// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * structureResults.js — Post-run extraction of structured assertion results
 *
 * Reads .bru_results.json from a completed run's artifacts and populates
 * the three-level normalized tables (run_suites, run_requests, run_assertions)
 * with classified assertion data.
 *
 * Called by runner.js after Bruno completes and artifacts are copied.
 *
 * Returns: { suites: N, requests: N, assertions: N }
 */

const fs   = require('fs');
const path = require('path');
const { safeJoinUuid } = require('../utils/paths');
const { run: dbRun, get, transaction, colEncrypt } = require('../db/db');

// Inline UUID regex (see comment in reports/diff.js) — Sonar's taint
// analyzer (jssecurity:S6549) requires the validation to live in the
// same function as the filesystem call to recognise it as a sanitizer.
const RUN_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const {
  classifyCategory,
  classifyDomain,
  classifyOfferPart,
  classifySeverity,
  isParameterized,
  extractExpected,
  extractActual
} = require('./classifier');
const { extractRequestContext } = require('./contextExtractors');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');

// Maximum size (bytes) of a single request or response body persisted to DB.
// Bodies larger than this are truncated with a marker. Default 100 KB which
// covers ~99% of OSDM payloads while keeping per-run storage bounded.
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '102400', 10);

/**
 * Serialize an object/string to a JSON string of bounded size. Returns NULL
 * if the input is empty. If the serialization exceeds MAX_BODY_SIZE, the
 * result is truncated with a "[truncated NNN bytes]" suffix so the consumer
 * can detect the cut.
 */
function serializeBounded(value) {
  if (value === null || value === undefined || value === '') return null;
  let str;
  if (typeof value === 'string') str = value;
  else {
    try { str = JSON.stringify(value); } catch (_e) { return null; }
  }
  if (str.length <= MAX_BODY_SIZE) return str;
  const cut = MAX_BODY_SIZE - 32;
  return str.slice(0, cut) + `\n[truncated ${str.length - cut} bytes]`;
}

/**
 * Extract response body from Bruno's entry. Bruno's serialization varies
 * across versions / endpoints — try common shapes in order.
 */
function getResponseBody(entry) {
  const r = entry && entry.response;
  if (!r) return null;
  return r.data ?? r.body ?? r.json ?? r.text ?? null;
}

function getRequestBody(entry) {
  const r = entry && entry.request;
  if (!r) return null;
  return r.data ?? r.body ?? r.json ?? null;
}

function getHeaders(obj) {
  if (!obj || !obj.headers) return null;
  // Bruno headers can be: array of {name,value}, plain object, or Map-like
  if (Array.isArray(obj.headers)) {
    const out = {};
    for (const h of obj.headers) {
      if (h && h.name && !h.disabled) out[h.name] = h.value;
    }
    return out;
  }
  if (typeof obj.headers === 'object') return obj.headers;
  return null;
}

// ─── Credential redaction (issue #17 server-side path) ────────────────────────
// PR #21 redacted secrets in mergeReport.js (the Bruno-side merged HTML/JSON
// report), but the OSCAR server ALSO captures full request/response data into
// run_requests for the Report Builder (report-builder.html). That second path
// was leaking the same secrets — Authorization, Ocp-Apim-Subscription-Key,
// and the client_secret/access_token bodies of /token POSTs all rendered in
// clear text in the Report Builder's Headers / Body tabs.
//
// We redact at WRITE time (here) so the DB never holds the plaintext secret
// in run_requests — old data with the secret stays until overwritten by a
// new run, but no new data accumulates.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-subscription-key',
  'ocp-apim-subscription-key',
  'apikey',
  'api-key',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-requestor',          // custom OSDM operator header (carries identity)
  'requestor',            // OSDM Requestor header — identity, masked like the reports do
  'cookie',
  'set-cookie'
]);
const REDACTED_MARKER = '[REDACTED — credential]';

// Traces improvement: PARTIAL masking for credential header values. Keeping
// the head (scheme + token start) and the tail lets a tester verify "the
// right token was sent" and correlate two requests without exposing a usable
// secret — same idea as card-number masking. Graduated: long values (tokens)
// keep head 10 / tail 4; short identity-style values (Requestor) keep
// head 3 / tail 2; anything shorter is fully redacted.
function maskCredentialValue(v) {
  const s = String(v == null ? '' : v);
  if (s.length >= 24) {
    return `${s.slice(0, 10)}…[masked ${s.length - 14} chars]…${s.slice(-4)}`;
  }
  if (s.length >= 8) {
    return `${s.slice(0, 3)}…[masked ${s.length - 5} chars]…${s.slice(-2)}`;
  }
  return REDACTED_MARKER;
}

function redactHeaders(headersObj) {
  if (!headersObj || typeof headersObj !== 'object') return headersObj;
  const out = {};
  for (const [k, v] of Object.entries(headersObj)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(String(k).toLowerCase()) ? maskCredentialValue(v) : v;
  }
  return out;
}

// Auth endpoints (URL matches /token | /login | /auth | /logon | /oauth) carry
// client_id / client_secret / password in the request body, and access_token /
// refresh_token in the response body. Strip the entire body for these.
function isAuthRequestUrl(url) {
  return /\/(token|login|auth|logon|oauth)/i.test(String(url || ''));
}

/**
 * Heuristic linkage for the "navigate up/down through message chain" feature.
 *
 * The OSDM flow generally goes:
 *   /offers → /bookings (booking references an offerId from /offers)
 *   /booking/{id} → /refund-offers → /refunds
 *   /booking/{id} → /exchange-offers → /exchanges
 *   /booking/{id} → /fulfillments
 *
 * For now we use a path-based heuristic: a request to one of the "child"
 * endpoints links to the most recent earlier "parent" request from the same
 * scenario (same run_id + scenario_name). We rely on insertion order — by the
 * time we link, the parent has already been INSERT-ed in this transaction.
 *
 * This stays accurate without needing to parse offerIds out of every body,
 * which would be brittle across vendor variations.
 */
const PARENT_PATH_RULES = [
  // child endpoint regex                    →   parent endpoint regex
  { child: /\/bookings(\b|\?|\/|$)/i,             parent: /\/offers(\b|\?|\/|$)/i },
  { child: /\/refund-offers(\b|\?|\/|$)/i,        parent: /\/bookings(\/|$)/i },
  { child: /\/refunds(\b|\?|\/|$)/i,              parent: /\/refund-offers(\b|\?|\/|$)/i },
  { child: /\/exchange-offers(\b|\?|\/|$)/i,      parent: /\/bookings(\/|$)/i },
  { child: /\/exchanges(\b|\?|\/|$)/i,            parent: /\/exchange-offers(\b|\?|\/|$)/i },
  { child: /\/fulfillments(\b|\?|\/|$)/i,         parent: /\/bookings(\/|$)/i },
];

function inferParentRequestId(url, runId, scenarioName) {
  if (!url || !runId) return null;
  for (const { child, parent } of PARENT_PATH_RULES) {
    if (child.test(url)) {
      // Find the most recent matching parent in the same scenario.
      // We can't filter by parent regex directly in SQL, so we pull the last
      // few requests of this scenario and pick the first that matches.
      const candidates = require('../db/db').all(
        `SELECT rq.id, rq.http_url
           FROM run_requests rq
           JOIN run_suites s ON s.id = rq.suite_id
          WHERE rq.run_id = ?
            AND s.scenario_name IS ?
            AND rq.http_url IS NOT NULL
          ORDER BY rq.id DESC
          LIMIT 30`,
        [runId, scenarioName ?? null]
      );
      for (const c of candidates) {
        if (parent.test(c.http_url)) return c.id;
      }
      return null;   // child pattern matched but no parent yet — chain root
    }
  }
  return null;       // not a recognized child endpoint
}

// Auth/token URL patterns to skip (same as diff.js)
const AUTH_URL_RE = /\/(token|login|auth|logon|oauth)/i;
const AUTH_NAME_RE = /access.?token/i;

// #488/#489 field review (Farruggia + Heuguet, OTST, 2026-07/08 + 2026-09):
// the SAME optional, read-only GET requests that osdmCompliance.js's
// classifySystemInfoStatus (Bruno_Collection/library-bruno/) now treats as
// "not implemented" on a bare 403/404/405/406/500 — no confirming OSDM
// Problem body required, since field testing against SBB showed providers
// routinely just answer with a bare status and nothing else. Mirrored here,
// by exact Bruno request name (entry.name / reqName), so this report-level
// Vendor Capability Matrix agrees with the per-run assertion it's
// summarizing instead of showing a stale "ERROR" for the same response the
// live run already accepted as a documented capability gap.
//
// Deliberately an EXACT-NAME allowlist, not a blanket status-code rule: a
// blind "403/404/405/406/500 anywhere = NOT_IMPLEMENTED" would also
// reclassify an unrelated NHF (negative-test) probe elsewhere in the
// collection that deliberately sends a bad request and asserts one of these
// same codes as its correct, passing outcome — that request DOES implement
// the endpoint; it correctly rejected bad input. Scoping to these exact
// names (kept in sync with every call site of classifySystemInfoStatus /
// handleSystemInfoStatus) makes that cross-contamination impossible.
const CAPABILITY_PROBE_ENDPOINTS = new Set([
  '00. GET System Version Check',
  '01. GET Coach',
  '02. GET Coach By Id',
  '04. GET Passenger Categories',
  '05. GET Promotion Codes',
  '06. GET Reduction Cards',
  '07. GET Zones',
  '08. GET Products',
  '09. GET Product By ProductId',
  '10. GET Product Tags',
  '04. GET Passenger',
  '11. GET Refund Offer',
  '12. GET Exchange Offer',
]);

/**
 * Classify a request's vendor capability status based on HTTP status and
 * assertion outcomes. This is deliberately independent of the PASS/FAIL
 * aggregate so certifiers can see "endpoint not implemented" at a glance
 * without decoding a sea of failed assertions.
 *
 *   NOT_IMPLEMENTED — 501, 404 on an endpoint defined in the OSDM spec, or a
 *                      bare 403/405/406/500 on one of the known optional
 *                      capability-probe endpoints (CAPABILITY_PROBE_ENDPOINTS)
 *   NOT_APPLICABLE  — attempted by the runner but inapplicable to this offer
 *                      (e.g. Add ancillary on an offer with no ancillaryOfferParts,
 *                       Place selection on a non-reservable leg). Emitted by
 *                       library-bruno as a synthetic request with httpStatus = 0.
 *   ERROR           — 5xx other than 501 (vendor side error, not a capability gap)
 *   IMPLEMENTED     — 2xx and every assertion passed
 *   PARTIAL         — 2xx but some assertions failed
 *   null            — no response captured / inconclusive
 */
function classifyVendorCapability(httpStatus, totalAssertions, failedAssertions, reqName) {
  const s = typeof httpStatus === 'number' ? httpStatus : parseInt(httpStatus, 10);
  // library-bruno signals "attempted but inapplicable" by writing an entry
  // with httpStatus === 0 (no real network call, but a bookkeeping row so the
  // certifier sees the step was considered). Treat as a distinct class.
  if (s === 0) return 'NOT_APPLICABLE';
  if (!s || Number.isNaN(s)) return null;
  if (s === 501) return 'NOT_IMPLEMENTED';
  if (s === 404) return 'NOT_IMPLEMENTED';   // OSDM endpoints we're hitting are spec-defined
  if ([403, 405, 406, 500].includes(s) && CAPABILITY_PROBE_ENDPOINTS.has(reqName)) return 'NOT_IMPLEMENTED';
  if (s >= 500) return 'ERROR';
  if (s >= 200 && s < 300) {
    if (totalAssertions === 0) return 'IMPLEMENTED';
    return failedAssertions === 0 ? 'IMPLEMENTED' : 'PARTIAL';
  }
  return null;
}

/**
 * Extract structured results from a completed run.
 * @param {string} runId   - Run UUID
 * @param {string} companyId - Company UUID
 * @returns {{ suites: number, requests: number, assertions: number }}
 */
function extractStructuredResults(runId, companyId) {
  // Inline path-traversal guard (Sonar S6549). The same regex lives in
  // src/utils/paths.js for defence in depth, but Sonar's per-function
  // analyzer needs to see the validation here, in the same function as
  // the filesystem call, to flag the data flow as sanitised.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return { suites: 0, requests: 0, assertions: 0 };
  }
  const jsonPath = safeJoinUuid(ARTIFACTS_DIR, runId, '.bru_results.json');
  if (!jsonPath || !fs.existsSync(jsonPath)) return { suites: 0, requests: 0, assertions: 0 };

  // Bruno collections in OSDM are usually flat — entry.test.filename looks like
  // "01-System Infos Requests/00. GET System Version Check.yml" (only 2 levels).
  // The scenario name lives on the run row (runs.scenario_code), set by the
  // worker before launching Bruno. Use it as the canonical scenario_name.
  const runRow = get('SELECT scenario_code FROM runs WHERE id = ?', [runId]);
  const runScenarioCode = (runRow && runRow.scenario_code) || null;

  // v1.11.5 — artifact files are OSCAR1-encrypted since v1.11.0. The
  // helper handles both encrypted and legacy plaintext files transparently.
  const { decryptFromFile } = require('../utils/at-rest');
  const raw = JSON.parse(decryptFromFile(jsonPath).toString('utf8'));

  // Handle Bruno CLI output format variations (array wrapper, iterations, etc.)
  let results;
  if (Array.isArray(raw) && raw.length > 0 && raw[0].results) {
    results = raw[0].results; // iteration wrapper: [{ iterationIndex, results: [...] }]
  } else if (Array.isArray(raw)) {
    results = raw;
  } else if (Array.isArray(raw.results)) {
    results = raw.results;
  } else if (Array.isArray(raw.testResults)) {
    results = raw.testResults;
  } else {
    results = [];
  }

  if (results.length === 0) return { suites: 0, requests: 0, assertions: 0 };

  // ── Group results by (scenario, suite) ───────────────────────────────────
  // OSDM Bruno collections are organised as:
  //   <scenario>/<request-group>/<request>.bru
  // e.g. OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG/02-Common Requests/01. POST Get Offer.bru
  // → scenario = grandparent folder, suite (request group) = parent folder.
  const suiteMap = new Map(); // "<scenario>||<suite>" → { scenario, suite, entries: [] }

  for (const entry of results) {
    const pathStr = (entry.path || entry.test?.filename || '').replace(/\\/g, '/');
    const parts = pathStr.split('/').filter(Boolean);
    const suite    = parts.length >= 2 ? parts[parts.length - 2] : '(root)';
    // Prefer a real grandparent folder (rare for OSDM) but fall back to the
    // run's scenario_code so suites are always tagged with something useful.
    const scenario = (parts.length >= 3 ? parts[parts.length - 3] : null) || runScenarioCode;
    const reqName = (entry.name || '').trim() ||
      pathStr.replace(/\.yml$|\.bru$/i, '').split('/').pop() || '(unnamed)';

    // Skip auth/token requests
    const url = ((entry.request && entry.request.url) || '').toLowerCase();
    const nameLower = reqName.toLowerCase();
    if (AUTH_URL_RE.test(url) || AUTH_NAME_RE.test(nameLower)) continue;
    if (entry.skipped || entry.status === 'skipped') continue;

    const key = `${scenario || ''}||${suite}`;
    if (!suiteMap.has(key)) suiteMap.set(key, { scenario, suite, entries: [] });
    suiteMap.get(key).entries.push({ entry, suite, reqName });
  }

  // ── Insert into DB in a single transaction ────────────────────────────────
  let suiteCount = 0, requestCount = 0, assertionCount = 0;

  transaction(() => {
    for (const [, group] of suiteMap) {
      const { scenario, suite: suiteName, entries } = group;
      // Insert suite row
      const suiteResult = dbRun(
        `INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)`,
        [runId, companyId, scenario, suiteName]
      );
      const suiteId = suiteResult.lastInsertRowid;
      const suiteTotals = { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 };
      suiteCount++;

      for (const { entry, suite, reqName } of entries) {
        // Extract request-level data
        const method = (entry.request && entry.request.method) || null;
        const url = (entry.request && entry.request.url) || null;
        const status = entry.response ? (entry.response.status || entry.response.statusCode) : null;
        const httpStatus = typeof status === 'number' ? status : (parseInt(status, 10) || null);
        // Bruno CLI writes runDuration in SECONDS (fractional), not ms.
        // E.g. a 2780ms request appears as runDuration: 2.78 — rounding the
        // raw value gives "3ms" in the UI which contradicts the log line.
        // Multiply to ms so the assertion header matches what the log shows.
        const duration = Math.round((entry.runDuration || 0) * 1000);

        // Extract per-endpoint context (refund overrule code, exchange mode,
        // offer flexibility filter, …) from the sent payload. Stored as JSON
        // so the Report Builder can render it as inline tags without needing
        // to know which extractor was used.
        const context = extractRequestContext(entry);

        // Capture full HTTP traffic (bounded by MAX_BODY_SIZE) so Report Builder
        // can show req/res content + headers and let users navigate the message
        // chain. Bodies are JSON-serialized; when already a string they pass
        // through unchanged. Headers are stored as JSON objects.
        //
        // Issue #17 — redact credentials BEFORE serialisation so they never
        // hit the DB. Headers: filter sensitive header values. Bodies: when
        // the URL is an auth endpoint, the body carries client_secret /
        // access_token — replace it entirely.
        const isAuth = isAuthRequestUrl(url);
        const reqBody = isAuth
          ? `${REDACTED_MARKER} (auth-endpoint request body — typically client_id / client_secret / grant_type)`
          : serializeBounded(getRequestBody(entry));
        const resBody = isAuth
          ? `${REDACTED_MARKER} (auth-endpoint response body — typically access_token / refresh_token)`
          : serializeBounded(getResponseBody(entry));
        const reqHeaders = serializeBounded(redactHeaders(getHeaders(entry.request)));
        const resHeaders = serializeBounded(redactHeaders(getHeaders(entry.response)));

        // Heuristic parent linkage: when this is a /bookings, /refund-offers,
        // /exchange-offers, or /fulfillments call, look up the most recent
        // /offers (or /refund-offers / /exchange-offers) request earlier in
        // the same scenario and link to it. Lets the UI render
        // "← view originating offer" arrows in the JSON viewer.
        let parentRequestId = null;
        try {
          parentRequestId = inferParentRequestId(url, runId, scenario);
        } catch (_e) { /* linkage is best-effort */ }

        // Insert request row. Phase 2 of issue #60: HTTP traffic columns
        // (request_body, request_headers, response_body, response_headers)
        // are encrypted at rest with the same enc:v1: prefix used elsewhere.
        // Structural columns (http_method, http_url, http_status, duration)
        // remain plaintext so the UI can sort/filter without decrypt cost.
        // The `context` column is JSON-extracted intent metadata (e.g.
        // refund mode, paxCount) — encrypted because it can carry custom
        // per-call values the vendor would prefer to keep private.
        const reqResult = dbRun(
          `INSERT INTO run_requests
             (suite_id, run_id, company_id, request_name, http_method, http_url,
              http_status, duration_ms, context,
              request_body, request_headers, response_body, response_headers,
              parent_request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [suiteId, runId, companyId, reqName, method, url, httpStatus, duration,
           colEncrypt(context),
           colEncrypt(reqBody), colEncrypt(reqHeaders),
           colEncrypt(resBody), colEncrypt(resHeaders),
           parentRequestId]
        );
        const requestId = reqResult.lastInsertRowid;
        const reqTotals = { total: 0, passed: 0, failed: 0 };
        requestCount++;
        suiteTotals.duration += duration;

        // Collect all assertions from this request
        const allTests = [
          ...(entry.preRequestTestResults || []),
          ...(entry.testResults || []),
          ...(entry.postResponseTestResults || []),
        ];
        const allAssertions = entry.assertionResults || [];

        // Process test() results
        for (const t of allTests) {
          const desc = (t.description || t.name || t.lhsExpr || '(unnamed)').trim();
          const passed = t.status === 'pass' || t.passed === true;
          const error = t.error || t.message || null;
          const category = classifyCategory(desc);
          const domain = classifyDomain(desc, suite);
          const offerPart = classifyOfferPart(desc);
          const severity = classifySeverity(desc, category, passed);
          const parameterized = isParameterized(desc) ? 1 : 0;
          const expected = extractExpected(desc);
          const actual = extractActual(desc);
          const key = `${suite}|${reqName}|${desc}`;

          dbRun(
            `INSERT INTO run_assertions (request_id, suite_id, run_id, company_id,
              assertion_key, assertion_name, type, category, domain, offer_part, severity,
              passed, error_msg, expected_value, actual_value, parameterized)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [requestId, suiteId, runId, companyId,
             key, desc, t.isScriptError ? 'script_error' : 'test',
             category, domain, offerPart, severity,
             passed ? 1 : 0, error, expected, actual, parameterized]
          );
          assertionCount++;
          reqTotals.total++;
          suiteTotals.total++;
          if (passed) { reqTotals.passed++; suiteTotals.passed++; }
          else { reqTotals.failed++; suiteTotals.failed++; }
        }

        // Process declarative assertion results
        for (const a of allAssertions) {
          const label = (a.name || `${a.lhsExpr || ''} ${a.operator || ''} ${a.rhsExpr || ''}`.trim() || 'assertion');
          const passed = a.status === 'pass' || a.passed === true;
          const error = a.error || null;
          const category = classifyCategory(label);
          const domain = classifyDomain(label, suite);
          const offerPart = classifyOfferPart(label);
          const severity = classifySeverity(label, category, passed);
          const parameterized = isParameterized(label) ? 1 : 0;
          const expected = a.rhsExpr || extractExpected(label);
          const actual = a.lhsExpr || extractActual(label);
          const key = `${suite}|${reqName}|${label}`;

          dbRun(
            `INSERT INTO run_assertions (request_id, suite_id, run_id, company_id,
              assertion_key, assertion_name, type, category, domain, offer_part, severity,
              passed, error_msg, expected_value, actual_value, parameterized)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [requestId, suiteId, runId, companyId,
             key, label, 'assertion',
             category, domain, offerPart, severity,
             passed ? 1 : 0, error, expected, actual, parameterized]
          );
          assertionCount++;
          reqTotals.total++;
          suiteTotals.total++;
          if (passed) { reqTotals.passed++; suiteTotals.passed++; }
          else { reqTotals.failed++; suiteTotals.failed++; }
        }

        // Update request totals + vendor capability classification
        const reqStatus = reqTotals.failed > 0 ? 'FAIL' : (reqTotals.total > 0 ? 'PASS' : 'SKIP');
        const capability = classifyVendorCapability(httpStatus, reqTotals.total, reqTotals.failed, reqName);
        dbRun(
          `UPDATE run_requests SET total=?, passed=?, failed=?, result=?, vendor_capability=? WHERE id=?`,
          [reqTotals.total, reqTotals.passed, reqTotals.failed, reqStatus, capability, requestId]
        );
      }

      // Update suite totals
      const suitePassRate = suiteTotals.total > 0
        ? Math.round(suiteTotals.passed / suiteTotals.total * 1000) / 10
        : 0;
      dbRun(
        `UPDATE run_suites SET total=?, passed=?, failed=?, skipped=?, pass_rate=?, duration_ms=? WHERE id=?`,
        [suiteTotals.total, suiteTotals.passed, suiteTotals.failed, suiteTotals.skipped,
         suitePassRate, suiteTotals.duration, suiteId]
      );
    }
  });

  return { suites: suiteCount, requests: requestCount, assertions: assertionCount };
}

module.exports = { extractStructuredResults, classifyVendorCapability, serializeBounded };
