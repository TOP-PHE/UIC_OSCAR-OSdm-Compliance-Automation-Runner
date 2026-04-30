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
const { run: dbRun, get, transaction } = require('../db/db');
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

// Auth/token URL patterns to skip (same as diff.js)
const AUTH_URL_RE = /\/(token|login|auth|logon|oauth)/i;
const AUTH_NAME_RE = /access.?token/i;

/**
 * Classify a request's vendor capability status based on HTTP status and
 * assertion outcomes. This is deliberately independent of the PASS/FAIL
 * aggregate so certifiers can see "endpoint not implemented" at a glance
 * without decoding a sea of failed assertions.
 *
 *   NOT_IMPLEMENTED — 501, or 404 on an endpoint defined in the OSDM spec
 *   NOT_APPLICABLE  — attempted by the runner but inapplicable to this offer
 *                      (e.g. Add ancillary on an offer with no ancillaryOfferParts,
 *                       Place selection on a non-reservable leg). Emitted by
 *                       library-bruno as a synthetic request with httpStatus = 0.
 *   ERROR           — 5xx other than 501 (vendor side error, not a capability gap)
 *   IMPLEMENTED     — 2xx and every assertion passed
 *   PARTIAL         — 2xx but some assertions failed
 *   null            — no response captured / inconclusive
 */
function classifyVendorCapability(httpStatus, totalAssertions, failedAssertions) {
  const s = typeof httpStatus === 'number' ? httpStatus : parseInt(httpStatus, 10);
  // library-bruno signals "attempted but inapplicable" by writing an entry
  // with httpStatus === 0 (no real network call, but a bookkeeping row so the
  // certifier sees the step was considered). Treat as a distinct class.
  if (s === 0) return 'NOT_APPLICABLE';
  if (!s || Number.isNaN(s)) return null;
  if (s === 501) return 'NOT_IMPLEMENTED';
  if (s === 404) return 'NOT_IMPLEMENTED';   // OSDM endpoints we're hitting are spec-defined
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
  const jsonPath = path.join(ARTIFACTS_DIR, runId, '.bru_results.json');
  if (!fs.existsSync(jsonPath)) return { suites: 0, requests: 0, assertions: 0 };

  // Bruno collections in OSDM are usually flat — entry.test.filename looks like
  // "01-System Infos Requests/00. GET System Version Check.yml" (only 2 levels).
  // The scenario name lives on the run row (runs.scenario_code), set by the
  // worker before launching Bruno. Use it as the canonical scenario_name.
  const runRow = get('SELECT scenario_code FROM runs WHERE id = ?', [runId]);
  const runScenarioCode = (runRow && runRow.scenario_code) || null;

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

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

        // Insert request row
        const reqResult = dbRun(
          `INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, duration_ms, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [suiteId, runId, companyId, reqName, method, url, httpStatus, duration, context]
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
        const capability = classifyVendorCapability(httpStatus, reqTotals.total, reqTotals.failed);
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

module.exports = { extractStructuredResults };
