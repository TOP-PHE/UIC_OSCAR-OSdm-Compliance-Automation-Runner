// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * findings.js — writing a Test Finding, shared by "Open a finding"
 * (company-findings.js) and accepting a suggested draft (#735,
 * company-finding-suggestions.js), so both store exactly the same thing.
 */

const crypto = require('node:crypto');
const { get, run } = require('../../db/db');

const CATEGORIES = new Set(['open', 'provider_deviation', 'oscar_issue', 'not_supported', 'spec_question']);
const SEVERITIES = new Set(['major', 'minor', 'not_supported']);
const STATUSES   = new Set(['open', 'discussing', 'resolved']);

// ── Serialisers (snake_case row → camelCase API) ──────────────────────────────
function toApiFinding(f) {
  return {
    id:             f.id,
    title:          f.title,
    step:           f.step || null,
    scenarioCode:   f.scenario_code || null,
    expectedStatus: (f.expected_status === null || f.expected_status === undefined) ? null : f.expected_status,
    observed:       f.observed || '',
    interpretation: f.interpretation || '',
    category:       f.category,
    severity:       f.severity || null,
    status:         f.status,
    baselineInRun:  !!f.baseline_in_run,
    raiseToOsdm:    !!f.raise_to_osdm,
    evidence:       f.evidence || '',
    createdBy:      f.created_by || null,
    createdAt:      f.created_at,
    updatedAt:      f.updated_at,
    // The provider's position taken on its coverage point (#994).
    position:        f.position || null,
    positionBy:      f.position_by || null,
    positionRole:    f.position_role || null,
    positionAt:      f.position_at || null,
    positionComment: f.position_comment || ''
  };
}

function asStr(v) { return (v === null || v === undefined) ? null : String(v); }
function asStatus(v) {
  // Accept '', null, a number, or a numeric string. Empty → null (not status-level).
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Insert a finding from a request body (the POST /findings fields). The
 * caller has checked the title. Returns the stored row.
 */
function createFinding(companyId, b, userEmail) {
  const id             = crypto.randomUUID();
  const category       = CATEGORIES.has(b.category) ? b.category : 'open';
  const severity       = SEVERITIES.has(b.severity) ? b.severity : null;
  const expectedStatus = asStatus(b.expectedStatus);
  const step           = b.step ? String(b.step).trim() : null;
  const scenarioCode   = b.scenarioCode ? String(b.scenarioCode).trim() : null;
  const baselineInRun  = (b.baselineInRun && expectedStatus !== null && step) ? 1 : 0;
  const createdBy      = (typeof b.createdBy === 'string' && b.createdBy.trim()) ? b.createdBy.trim() : userEmail;

  run(
    `INSERT INTO finding
       (id, company_id, title, step, scenario_code, expected_status, observed, interpretation,
        category, severity, status, baseline_in_run, raise_to_osdm, evidence, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, companyId, String(b.title).trim(), step, scenarioCode, expectedStatus, asStr(b.observed), asStr(b.interpretation),
     category, severity, 'open', baselineInRun, b.raiseToOsdm ? 1 : 0, asStr(b.evidence), createdBy]
  );
  return get('SELECT * FROM finding WHERE id = ?', [id]);
}

module.exports = { CATEGORIES, SEVERITIES, STATUSES, toApiFinding, asStr, asStatus, createFinding };
