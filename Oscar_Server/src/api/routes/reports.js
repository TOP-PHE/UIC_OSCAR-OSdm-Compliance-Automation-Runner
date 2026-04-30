'use strict';

/**
 * reports.js — Report comparison routes
 *
 * POST /v1/reports/compare     — compute diff between two runs
 * GET  /v1/reports/comparisons — list stored comparison snapshots for company
 * GET  /v1/reports/comparisons/:id — retrieve a stored comparison
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { get, all, run: dbRun } = require('../../db/db');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { compareRuns } = require('../../reports/diff');

const router = express.Router();
router.use(requireAuth, enforceTenant);

// Defensive JSON.parse — never let a corrupt stored blob take down a report.
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ── POST /v1/reports/compare ──────────────────────────────────────────────────
router.post('/compare', (req, res) => {
  const { run_a_id, run_b_id } = req.body || {};

  if (!run_a_id || !run_b_id) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'run_a_id and run_b_id are required.' });
  }
  if (run_a_id === run_b_id) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'run_a_id and run_b_id must be different.' });
  }

  const isPlatform = isPlatformRole(req.user.role);

  // Verify both runs are accessible and are COMPLETED
  const runA = isPlatform
    ? get("SELECT * FROM runs WHERE id = ? AND status != 'DELETED'", [run_a_id])
    : get("SELECT * FROM runs WHERE id = ? AND company_id = ? AND status != 'DELETED'", [run_a_id, req.companyId]);
  const runB = isPlatform
    ? get("SELECT * FROM runs WHERE id = ? AND status != 'DELETED'", [run_b_id])
    : get("SELECT * FROM runs WHERE id = ? AND company_id = ? AND status != 'DELETED'", [run_b_id, req.companyId]);

  if (!runA) return res.status(404).json({ status: 404, title: 'Run A not found.' });
  if (!runB) return res.status(404).json({ status: 404, title: 'Run B not found.' });
  if (runA.company_id !== runB.company_id) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Runs must belong to the same company.' });
  }

  const targetCompanyId = isPlatform ? (req.companyId || runA.company_id) : req.companyId;
  if (targetCompanyId !== runA.company_id) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Runs do not match requested company scope.' });
  }

  if (runA.status !== 'COMPLETED') return res.status(409).json({ status: 409, title: 'Conflict', detail: `Run A status is ${runA.status}. Only COMPLETED runs can be compared.` });
  if (runB.status !== 'COMPLETED') return res.status(409).json({ status: 409, title: 'Conflict', detail: `Run B status is ${runB.status}. Only COMPLETED runs can be compared.` });

  // Check if a stored snapshot already exists for this pair
  const existing = get(
    `SELECT * FROM report_comparisons WHERE company_id = ? AND run_a_id = ? AND run_b_id = ?`,
    [targetCompanyId, run_a_id, run_b_id]
  );
  if (existing) {
    return res.json({ id: existing.id, cached: true, ...JSON.parse(existing.diff_json) });
  }

  // Compute diff
  let diff;
  try {
    diff = compareRuns(run_a_id, run_b_id);
  } catch (err) {
    return res.status(422).json({ status: 422, title: 'Unprocessable', detail: err.message });
  }

  // Store snapshot
  const comparisonId = uuidv4();
  dbRun(
    `INSERT INTO report_comparisons (id, company_id, run_a_id, run_b_id, diff_json) VALUES (?, ?, ?, ?, ?)`,
    [comparisonId, targetCompanyId, run_a_id, run_b_id, JSON.stringify(diff)]
  );

  return res.status(201).json({
    id:     comparisonId,
    cached: false,
    run_a:  { id: runA.id, queued_at: runA.queued_at, api_base: runA.api_base_used },
    run_b:  { id: runB.id, queued_at: runB.queued_at, api_base: runB.api_base_used },
    ...diff
  });
});

// ── GET /v1/reports/comparisons ───────────────────────────────────────────────
router.get('/comparisons', (req, res) => {
  const isPlatform = isPlatformRole(req.user.role);
  let rows;

  if (isPlatform && !req.companyId) {
    rows = all(
      `SELECT rc.id, rc.company_id, c.name AS company_name, rc.run_a_id, rc.run_b_id, rc.created_at,
              ra.queued_at as run_a_date, rb.queued_at as run_b_date
       FROM report_comparisons rc
       JOIN companies c ON c.id = rc.company_id
       JOIN runs ra ON ra.id = rc.run_a_id
       JOIN runs rb ON rb.id = rc.run_b_id
       WHERE ra.status != 'DELETED' AND rb.status != 'DELETED'
       ORDER BY rc.created_at DESC
       LIMIT 200`
    );
  } else {
    rows = all(
      `SELECT rc.id, rc.run_a_id, rc.run_b_id, rc.created_at,
              ra.queued_at as run_a_date, rb.queued_at as run_b_date
       FROM report_comparisons rc
       JOIN runs ra ON ra.id = rc.run_a_id
       JOIN runs rb ON rb.id = rc.run_b_id
       WHERE rc.company_id = ? AND ra.status != 'DELETED' AND rb.status != 'DELETED'
       ORDER BY rc.created_at DESC
       LIMIT 100`,
      [req.companyId]
    );
  }

  return res.json({ comparisons: rows });
});

// ── GET /v1/reports/comparisons/:id ──────────────────────────────────────────
router.get('/comparisons/:id', (req, res) => {
  const isPlatform = isPlatformRole(req.user.role);
  const row = (isPlatform && !req.companyId)
    ? get(`SELECT * FROM report_comparisons WHERE id = ?`, [req.params.id])
    : get(`SELECT * FROM report_comparisons WHERE id = ? AND company_id = ?`, [req.params.id, req.companyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Comparison not found.' });

  const runA = get('SELECT id, queued_at, api_base_used, status FROM runs WHERE id = ?', [row.run_a_id]);
  const runB = get('SELECT id, queued_at, api_base_used, status FROM runs WHERE id = ?', [row.run_b_id]);

  return res.json({
    id:         row.id,
    created_at: row.created_at,
    run_a:      runA,
    run_b:      runB,
    ...JSON.parse(row.diff_json)
  });
});

// ── POST /v1/reports/configured ───────────────────────────────────────────────
// Generates a filtered assertion report for selected runs.
// Available to all authenticated users; certifiers use it for formal reports.
router.post('/configured', (req, res) => {
  const { run_ids, filters, title } = req.body || {};

  if (!Array.isArray(run_ids) || run_ids.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'run_ids array is required.' });
  }

  // Tenant scope: non-platform users (tester, test_manager) may only request
  // reports for runs in their own company. Reject foreign run_ids early so we
  // never leak another company's assertion data via a crafted request body.
  if (!isPlatformRole(req.user.role)) {
    const placeholdersScope = run_ids.map(() => '?').join(',');
    const ownedRows = all(
      `SELECT id FROM runs WHERE id IN (${placeholdersScope}) AND company_id = ?`,
      [...run_ids, req.user.companyId]
    );
    const ownedSet = new Set(ownedRows.map(r => r.id));
    const foreign = run_ids.filter(id => !ownedSet.has(id));
    if (foreign.length > 0) {
      return res.status(403).json({
        status: 403,
        title: 'Forbidden',
        detail: 'One or more run_ids are not in your company.',
        foreign_run_ids: foreign
      });
    }
  }

  const { categories, domains, status, severities } = filters || {};

  // Build assertion query with dynamic filters
  const placeholders = run_ids.map(() => '?').join(',');
  let sql = `
    SELECT ra.*, r.queued_at, r.completed_at, r.scenario_code, r.env_name_used,
           rs.suite_name, rs.scenario_name,
           rq.request_name, rq.http_method, rq.http_status, rq.duration_ms,
           rq.vendor_capability, rq.context AS request_context, rq.result AS request_result
    FROM run_assertions ra
    JOIN runs r ON r.id = ra.run_id
    JOIN run_suites rs ON rs.id = ra.suite_id
    JOIN run_requests rq ON rq.id = ra.request_id
    WHERE ra.run_id IN (${placeholders})
  `;
  const params = [...run_ids];

  if (status === 'passed') { sql += ' AND ra.passed = 1'; }
  else if (status === 'failed') { sql += ' AND ra.passed = 0'; }

  if (Array.isArray(categories) && categories.length > 0) {
    sql += ` AND ra.category IN (${categories.map(() => '?').join(',')})`;
    params.push(...categories);
  }
  if (Array.isArray(domains) && domains.length > 0) {
    sql += ` AND ra.domain IN (${domains.map(() => '?').join(',')})`;
    params.push(...domains);
  }
  if (Array.isArray(severities) && severities.length > 0) {
    sql += ` AND ra.severity IN (${severities.map(() => '?').join(',')})`;
    params.push(...severities);
  }

  sql += ' ORDER BY ra.suite_id ASC, ra.request_id ASC, ra.id ASC';

  const assertions = all(sql, params);

  // Compute summary
  const total = assertions.length;
  const passed = assertions.filter(a => a.passed).length;
  const failed = total - passed;
  const passRate = (n, d) => (d > 0 ? Math.round(n / d * 1000) / 10 : 0);

  // Group-by helper → array of {<keyField>, total, passed, failed, pass_rate}
  function groupByKey(items, pickKey, keyField) {
    const acc = {};
    items.forEach(a => {
      const k = pickKey(a) || 'other';
      if (!acc[k]) acc[k] = { [keyField]: k, total: 0, passed: 0, failed: 0 };
      acc[k].total++;
      if (a.passed) acc[k].passed++; else acc[k].failed++;
    });
    return Object.values(acc)
      .map(r => ({ ...r, pass_rate: passRate(r.passed, r.total) }))
      .sort((a, b) => b.failed - a.failed || b.total - a.total);
  }

  const byDomain   = groupByKey(assertions, a => a.domain,   'domain');
  const byCategory = groupByKey(assertions, a => a.category, 'category');

  // Build suites → requests → assertions hierarchy from filtered assertions
  const suiteMap = new Map();
  assertions.forEach(a => {
    if (!suiteMap.has(a.suite_id)) {
      suiteMap.set(a.suite_id, {
        suite_id:      a.suite_id,
        suite_name:    a.suite_name,
        scenario_name: a.scenario_name,
        total: 0, passed: 0, failed: 0,
        _requests: new Map()
      });
    }
    const suite = suiteMap.get(a.suite_id);
    suite.total++;
    if (a.passed) suite.passed++; else suite.failed++;

    if (!suite._requests.has(a.request_id)) {
      suite._requests.set(a.request_id, {
        request_id:        a.request_id,
        request_name:      a.request_name,
        http_method:       a.http_method,
        http_status:       a.http_status,
        duration_ms:       a.duration_ms,
        vendor_capability: a.vendor_capability || null,
        context:           a.request_context ? safeJsonParse(a.request_context) : null,
        result:            'PASS',
        assertions:        []
      });
    }
    const reqGroup = suite._requests.get(a.request_id);
    reqGroup.assertions.push(a);
    if (!a.passed) reqGroup.result = 'FAIL';
  });

  const suites = Array.from(suiteMap.values()).map(s => ({
    suite_id:      s.suite_id,
    suite_name:    s.suite_name,
    scenario_name: s.scenario_name,
    total:         s.total,
    passed:        s.passed,
    failed:        s.failed,
    pass_rate:     passRate(s.passed, s.total),
    requests:      Array.from(s._requests.values())
  }));

  // ── Fetch run_events scoped to the (suite_name, request_name) pairs that
  //    survived the assertion filter, so logs and assertions stay coherent.
  //    Frontend further filters between failing-only vs all surviving requests.
  //    Scenario milestone events (event_kind != 'log') are always fetched —
  //    they carry scenario transitions/retries and are rendered as banners
  //    above the groups they apply to, so the viewer never has to guess which
  //    scenario/attempt a log belongs to.
  const surviving = new Set();
  suites.forEach(s => {
    s.requests.forEach(rq => {
      surviving.add(`${s.suite_name}||${rq.request_name}||${rq.result}`);
    });
  });

  let events = [];
  const eventRows = all(
    `SELECT id, run_id, ts, level, message, category, phase,
            suite_name, request_name, http_status,
            event_kind, attempt_index, attempt_total, scenario_name
     FROM run_events
     WHERE run_id IN (${placeholders})
       AND (
         (suite_name IS NOT NULL AND request_name IS NOT NULL)
         OR (event_kind IS NOT NULL AND event_kind != 'log')
       )
     ORDER BY id ASC
     LIMIT 5000`,
    [...run_ids]
  );
  events = eventRows
    .filter(e => {
      // Milestones always pass (they describe scenario boundaries).
      if (e.event_kind && e.event_kind !== 'log') return true;
      const passKey = `${e.suite_name}||${e.request_name}||PASS`;
      const failKey = `${e.suite_name}||${e.request_name}||FAIL`;
      return surviving.has(passKey) || surviving.has(failKey);
    })
    .map(e => {
      if (e.event_kind && e.event_kind !== 'log') {
        return { ...e, request_result: null };
      }
      const failKey = `${e.suite_name}||${e.request_name}||FAIL`;
      return { ...e, request_result: surviving.has(failKey) ? 'FAIL' : 'PASS' };
    });

  // ── Vendor capability matrix ──────────────────────────────────────────────
  // Distinct (suite_name, request_name) pairs with their capability status.
  // Built directly from run_requests so the matrix reflects the full set of
  // attempted endpoints — not only those that survived the assertion filter.
  // Ordered by rq.id so rows come back in the sequence Bruno executed them —
  // certifiers read top-to-bottom expecting the execution flow (auth → system
  // → common → refund/exchange). Sorting by status would shuffle failing
  // endpoints around and break that mental model.
  const capabilityRows = all(
    `SELECT rs.scenario_name, rs.suite_name, rq.request_name,
            rq.http_method, rq.http_status, rq.vendor_capability, rq.result,
            rq.context, rq.id AS rq_id
     FROM run_requests rq
     JOIN run_suites rs ON rs.id = rq.suite_id
     WHERE rq.run_id IN (${placeholders})
     ORDER BY rq.id ASC`,
    [...run_ids]
  );

  // Aggregate across iterations: keep the worst capability per endpoint so
  // the matrix does not mislead the certifier when one iteration succeeded by
  // chance. Ranking order (highest first in output):
  //   NOT_IMPLEMENTED > ERROR > PARTIAL > IMPLEMENTED > NOT_APPLICABLE > null
  // NOT_APPLICABLE is ranked lowest because "runner attempted the action and
  // the offer didn't support it" is not a vendor failure; it just means the
  // flow wasn't exercised on this offer.
  const capRank = { NOT_IMPLEMENTED: 5, ERROR: 4, PARTIAL: 3, IMPLEMENTED: 2, NOT_APPLICABLE: 1 };
  const capMatrix = {};
  capabilityRows.forEach(r => {
    const key = `${r.scenario_name || ''}||${r.suite_name}||${r.request_name}`;
    const existing = capMatrix[key];
    const incomingRank = capRank[r.vendor_capability] || 0;
    const existingRank = existing ? (capRank[existing.vendor_capability] || 0) : -1;
    if (!existing || incomingRank > existingRank) {
      capMatrix[key] = {
        scenario_name: r.scenario_name,
        suite_name:    r.suite_name,
        request_name:  r.request_name,
        http_method:   r.http_method,
        http_status:   r.http_status,
        vendor_capability: r.vendor_capability,
        result:        r.result,
        context:       r.context ? safeJsonParse(r.context) : null,
      };
    }
  });
  const capability_matrix = Object.values(capMatrix);

  return res.json({
    title: title || 'OSDM Conformance Report',
    generated_at: new Date().toISOString(),
    filters: filters || {},
    run_ids,
    summary: { total, passed, failed, pass_rate: passRate(passed, total) },
    by_domain: byDomain,
    by_category: byCategory,
    suites,
    events,
    capability_matrix,
    assertions
  });
});

// ── Report Templates CRUD ────────────────────────────────────────────────────

// GET /v1/reports/templates — list saved templates
router.get('/templates', (req, res) => {
  const companyId = req.companyId || req.user.companyId;
  const rows = all(
    `SELECT rt.id, rt.name, rt.config, rt.created_at, rt.updated_at, u.email AS created_by
     FROM report_templates rt
     JOIN users u ON u.id = rt.user_id
     ${companyId ? 'WHERE rt.company_id = ? OR rt.company_id IS NULL' : ''}
     ORDER BY rt.updated_at DESC`,
    companyId ? [companyId] : []
  );
  return res.json({ templates: rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })) });
});

// POST /v1/reports/templates — create a template
router.post('/templates', (req, res) => {
  const { name, config } = req.body || {};
  if (!name) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'name is required.' });

  const id = uuidv4();
  const companyId = req.companyId || req.user.companyId || null;
  dbRun(
    `INSERT INTO report_templates (id, company_id, user_id, name, config) VALUES (?, ?, ?, ?, ?)`,
    [id, companyId, req.user.id, name, JSON.stringify(config || {})]
  );
  return res.status(201).json({ id, name, config: config || {} });
});

// DELETE /v1/reports/templates/:id — delete a template
router.delete('/templates/:id', (req, res) => {
  const row = get('SELECT * FROM report_templates WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ status: 404, title: 'Template not found.' });
  if (row.user_id !== req.user.id && !isPlatformRole(req.user.role)) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'You can only delete your own templates.' });
  }
  dbRun('DELETE FROM report_templates WHERE id = ?', [req.params.id]);
  return res.json({ deleted: true });
});

// ── GET /v1/reports/trends/summary ────────────────────────────────────────────
// Returns top-20 most-failing assertions for the company (last 30 days).
// Must be defined BEFORE /trends to avoid Express treating "summary" as a param.
router.get('/trends/summary', (req, res) => {
  const companyId = req.companyId || req.user.companyId;
  if (!companyId) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Company scope required.' });

  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);

  const rows = all(`
    SELECT ra.assertion_key, ra.assertion_name, ra.category, ra.domain, ra.severity,
           COUNT(*) as run_count,
           SUM(CASE WHEN ra.passed = 0 THEN 1 ELSE 0 END) as fail_count,
           ROUND(100.0 * SUM(ra.passed) / COUNT(*), 1) as pass_rate
    FROM run_assertions ra
    JOIN runs r ON r.id = ra.run_id
    WHERE ra.company_id = ?
      AND r.status IN ('COMPLETED', 'FAILED')
      AND r.queued_at >= datetime('now', '-30 days')
    GROUP BY ra.assertion_key
    HAVING fail_count > 0
    ORDER BY fail_count DESC, pass_rate ASC
    LIMIT ?
  `, [companyId, limit]);

  return res.json({ company_id: companyId, top_failures: rows });
});

// ── GET /v1/reports/trends ───────────────────────────────────────────────────
// Returns last N pass/fail results for a specific assertion key across runs.
router.get('/trends', (req, res) => {
  const { assertion_key, limit: limitStr } = req.query;
  if (!assertion_key) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'assertion_key query param is required.' });
  }
  const limit = Math.min(parseInt(limitStr || '20', 10), 100);
  const companyId = req.companyId || req.user.companyId;
  if (!companyId) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Company scope required.' });

  const rows = all(`
    SELECT ra.run_id, ra.passed, ra.error_msg, ra.category, ra.severity,
           r.queued_at, r.completed_at, r.scenario_code
    FROM run_assertions ra
    JOIN runs r ON r.id = ra.run_id
    WHERE ra.company_id = ? AND ra.assertion_key = ? AND r.status IN ('COMPLETED', 'FAILED')
    ORDER BY r.queued_at DESC
    LIMIT ?
  `, [companyId, assertion_key, limit]);

  return res.json({
    assertion_key,
    points: rows.map(r => ({
      run_id: r.run_id,
      passed: !!r.passed,
      error: r.error_msg,
      category: r.category,
      severity: r.severity,
      scenario_code: r.scenario_code,
      completed_at: r.completed_at
    }))
  });
});

module.exports = router;
