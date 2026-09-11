// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runSelections.js — a tester's personal run list (v1.11.197).
 *
 * The datafile's scenariosToRun is one company-wide list, so a tester ticking
 * or unticking a scenario used to change every other tester's next run.
 * Maintainer decision, 2026-09-11: each tester picks what THEY run, from their
 * own scenarios and the shared ones; the Test Manager's list stays the company
 * default a tester starts from. Stored here, per (company, user), not in the
 * datafile: a Test Manager's whole-file upload must not wipe testers' lists,
 * and the file Bruno reads should not carry per-user state.
 *
 * null means "no personal list yet" — callers fall back to the company default.
 */

const { get, run } = require('../db/db');

function getRunSelection(companyId, userId) {
  const row = get('SELECT codes_json FROM run_selections WHERE company_id = ? AND user_id = ?', [companyId, userId]);
  if (!row) return null;
  try {
    const codes = JSON.parse(row.codes_json);
    return Array.isArray(codes) ? codes.filter(c => typeof c === 'string') : null;
  } catch (_) {
    // A corrupt row is treated as "no personal list yet": the tester falls
    // back to the company default, and their next save overwrites the row.
    return null;
  }
}

function setRunSelection(companyId, userId, codes) {
  run(
    `INSERT INTO run_selections (company_id, user_id, codes_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id, user_id) DO UPDATE SET codes_json = excluded.codes_json, updated_at = excluded.updated_at`,
    [companyId, userId, JSON.stringify(codes)]
  );
}

module.exports = { getRunSelection, setRunSelection };
