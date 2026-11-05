// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Deleting a company removes what it holds, without anyone reading it: every
 * row naming the company, the rows hanging from its runs and findings, the
 * provider links naming it, its pending registrations, and its data files on
 * disk. The administrator who deletes it never sees any of it.
 *
 * Every table with a company_id column is in OWNED or KEPT:
 * admin-no-test-config.test.js reads the schema and fails on a new one.
 */

const fs = require('node:fs');
const { run, transaction } = require('../db/db');
const { liveDatafilePath, previousDatafilePath } = require('./datafileWrite');

// Rows that hang from the company's runs and findings: deleted first.
const BY_PARENT = [
  'DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)',
  'DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)',
  'DELETE FROM finding_comment WHERE finding_id IN (SELECT id FROM finding WHERE company_id = ?)',
];
// Every table naming the company, children before the runs they point to.
const OWNED = [
  'run_requests', 'run_assertions', 'run_suites', 'run_share', 'run_batch', 'security_event',
  'report_comparisons', 'report_templates', 'test_frameworks', 'test_resources', 'places_cache',
  'run_selections', 'tester_credentials', 'provider_access', 'finding_suggestion', 'finding',
  'ai_access_request', 'ai_config', 'ai_analysis', 'ai_setup', 'provider_checklist', 'api_key',
  'checklist_import', 'coverage_report', 'runs', 'users',
];
// Kept: the audit trail. The company row itself goes last.
const KEPT = ['auth_events', 'companies'];
const DELETE_OWNED = OWNED.map(table => `DELETE FROM ${table} WHERE company_id = ?`);

/** Deletes every row of the company and its data files. The caller checks it may. */
function purgeCompany(company) {
  const id = company.id;
  transaction(() => {
    run('PRAGMA defer_foreign_keys = ON');
    for (const sql of BY_PARENT) run(sql, [id]);
    for (const sql of DELETE_OWNED) run(sql, [id]);
    run('DELETE FROM provider_operator WHERE provider_id = ? OR operator_id = ?', [id, id]);
    run('DELETE FROM pending_registrations WHERE company_slug = ?', [company.slug]);
    run('DELETE FROM companies WHERE id = ?', [id]);
  });
  for (const pathOf of [liveDatafilePath, previousDatafilePath]) {
    try { fs.rmSync(pathOf(company.slug), { force: true }); } catch { /* the rows are gone; a file left is removed by hand */ }
  }
}

module.exports = { purgeCompany, OWNED, KEPT };
