// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * knownDeviationProjection.js — bridge from the Test Findings register to the
 * Bruno run engine (#398).
 *
 * The findings store (src/api/routes/company-findings.js) is the front-of-house
 * conformance dialogue. Its runtime effect is narrow and explicit: a finding
 * the test team has marked `baseline_in_run = 1` AND that carries a numeric
 * `expected_status` and a `step` label is projected into the datafile's
 * top-level `knownDeviations[]` (sibling of systemInfoParameters), in the exact
 * {step, expectedStatus, note, active} shape the #398 engine consumes
 * (scenarioParser.setKnownDeviations → loopback.knownDeviationFor). Everything
 * else in the register is dialogue only — no runtime effect.
 *
 * The datafile is the single source a run reads (Bruno fetches it from
 * /data/:slug-datafile.json at run time), so the projection must be written to
 * disk. Two triggers call reprojectDatafile():
 *   1. a finding mutation that can change the baselined set (create/patch/delete)
 *   2. a wizard datafile save (PUT /v1/company/datafile/json) — which also calls
 *      buildProjection() inline so a save can never wipe or hand-edit the array.
 *
 * Soft by construction: no datafile yet, or any decrypt/parse failure, is a
 * logged no-op — projection never throws to its caller and never blocks a save.
 */

const fs     = require('fs');
const crypto = require('crypto');
const { get, all, run } = require('../db/db');
const { decryptFromFileAsync, encryptToFileAsync } = require('./at-rest');
const log = require('./logger').child({ module: 'known-deviation-projection' });

/**
 * Build the knownDeviations[] array for a company from its findings table.
 * Only enforceable rows are included: baseline_in_run = 1 with a numeric
 * expected_status and a non-empty step. `active` is always true — baseline_in_run
 * is the single enforce switch, so an un-baselined finding is simply omitted
 * (kept on record in the register, not enforced). Synchronous (node:sqlite).
 */
function buildProjection(companyId) {
  if (!companyId) return [];
  let rows;
  try {
    rows = all(
      `SELECT step, expected_status, title
         FROM finding
        WHERE company_id = ?
          AND baseline_in_run = 1
          AND expected_status IS NOT NULL
          AND step IS NOT NULL
          AND TRIM(step) != ''`,
      [companyId]
    );
  } catch (err) {
    log.warn({ err: err.message, companyId }, 'buildProjection: query failed — returning empty');
    return [];
  }
  return rows.map(r => ({
    step:           String(r.step).trim(),
    expectedStatus: r.expected_status,
    note:           (String(r.title || '').trim() || 'documented in the Test Findings register'),
    active:         true
  }));
}

/**
 * Re-derive knownDeviations from the findings table and write it into the
 * company's on-disk datafile (decrypt → set the array → re-encrypt), then
 * refresh the stored plaintext hash so the dashboard reflects the change.
 * Returns true if the datafile was rewritten, false on any soft no-op.
 */
async function reprojectDatafile(companyId) {
  const company = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!company || !company.datafile_path || !fs.existsSync(company.datafile_path)) {
    return false;   // no datafile uploaded yet — nothing to project into
  }

  let df;
  try {
    const buf = await decryptFromFileAsync(company.datafile_path);
    df = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    log.warn({ err: err.message, companyId }, 'reproject: could not read/parse datafile — skipping');
    return false;
  }
  if (!df || typeof df !== 'object' || Array.isArray(df)) {
    log.warn({ companyId }, 'reproject: datafile is not a JSON object — skipping');
    return false;
  }

  df.knownDeviations = buildProjection(companyId);
  const content = JSON.stringify(df, null, 4);

  try {
    await encryptToFileAsync(content, company.datafile_path);
  } catch (err) {
    log.error({ err: err.message, companyId }, 'reproject: failed to encrypt-write datafile');
    return false;
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  try {
    run(
      `UPDATE companies SET datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [hash, companyId]
    );
  } catch (_) { /* hash refresh is best-effort — the file itself is the source of truth */ }

  return true;
}

module.exports = { buildProjection, reprojectDatafile };
