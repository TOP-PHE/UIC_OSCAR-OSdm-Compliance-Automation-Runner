// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runLaunch.js — starting a batch of runs for one company or provider, shared
 * by POST /v1/runs (a person, on the Run page) and POST
 * /v1/api/test-requests (a Company API account, #1342).
 *
 *   launchReadiness(userId, companyId) — what a launch needs there, or why it
 *     cannot start: endpoint suspended, endpoint or credentials or data file
 *     missing, data file unreadable. The answers are those POST /v1/runs has
 *     always given.
 *   enqueueBatch({ … }) — one run per code, written in one transaction and
 *     queued; the batch's selection kept when there is one (#1029).
 */

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { get, all, run: dbRun, transaction, colDecrypt } = require('../../db/db');
const queue = require('../../worker/queue');
const { credentialsFor } = require('../../utils/testerCredentials');
const { endpointSuspension } = require('../../utils/intrusion');
const RF = require('../../utils/runFilters');

const SUSPENDED_ENDPOINT = Object.freeze({ status: 409, title: 'Conflict', endpoint_suspended: true,
  detail: 'The OSDM endpoint is suspended: an answer meant to attack OSCAR was detected during a run. A Test Manager resumes it on the API Config page once the provider is checked.' });

// What a run needs of the user's credentials, in words (the runner reads the
// same row when the job is dequeued; checking here answers at once).
function missingCredentials(c) {
  const missing = [];
  if (c.auth_mode === 'bearer' && !c.access_token_enc) missing.push('Bearer token (your credentials)');
  if (c.auth_mode === 'oauth2') {
    if (!c.token_url)         missing.push('OAuth2 token URL (your credentials)');
    if (!c.client_id_enc)     missing.push('OAuth2 client_id (your credentials)');
    if (!c.client_secret_enc) missing.push('OAuth2 client_secret (your credentials)');
    if (c.oauth_profile === 'sqills_extension' && !c.oauth_extra_enc) {
      missing.push('OAuth2 extra credential (your Sqills Basic auth value)');
    }
    if (c.oauth_profile === 'custom' && !c.oauth_custom_template) {
      missing.push('OAuth2 custom request template (your credentials)');
    }
  }
  return missing;
}

// The company's limit of runs at once, from its Test Framework. The config
// column is encrypted at rest (issue #60): it MUST be colDecrypt()'d before
// JSON.parse, or the limit silently falls back to 1 (the concurrency bug).
function concurrentLimitOf(companyId) {
  const tfRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
  let fwConfig = {};
  if (tfRow) {
    try { fwConfig = JSON.parse(colDecrypt(tfRow.config)); } catch { fwConfig = {}; }
  }
  // Handle double-nested config (legacy: { config: { concurrentSessionLimit: N } })
  if (fwConfig.config && typeof fwConfig.config === 'object' && !Array.isArray(fwConfig.config)) {
    fwConfig = fwConfig.config;
  }
  return fwConfig.concurrentSessionLimit || 1;
}

/**
 * What a launch of `userId` in `companyId` needs, or why it cannot start:
 * { company, credentials, datafile, concurrentLimit } or { refusal: [status, body] }.
 */
function launchReadiness(userId, companyId) {
  const company = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!company) return { refusal: [404, { status: 404, title: 'Company not found.' }] };
  // An endpoint suspended after an intrusion attempt takes no run (utils/intrusion.js).
  if (endpointSuspension(companyId)) return { refusal: [409, SUSPENDED_ENDPOINT] };
  // Credentials are per user and company (#540).
  const credentials = credentialsFor(userId, companyId);
  if (!credentials) return { refusal: [404, { status: 404, title: 'User not found.' }] };

  const missing = [];
  if (!company.api_base) missing.push('OSDM API endpoint (set on the Company tab)');
  missing.push(...missingCredentials(credentials));
  if (!company.datafile_path || !fs.existsSync(company.datafile_path)) missing.push('data file');
  if (missing.length > 0) {
    return { refusal: [400, { status: 400, title: 'Bad Request', detail: `Cannot start run — missing: ${missing.join(', ')}.`, missing }] };
  }

  // v1.11.5: the data file on disk is AES-256-GCM encrypted (OSCAR1 envelope);
  // decryptFromFile handles both it and legacy plaintext.
  let datafile;
  try {
    const { decryptFromFile } = require('../../utils/at-rest');
    datafile = JSON.parse(decryptFromFile(company.datafile_path).toString('utf8'));
  } catch (err) {
    return { refusal: [400, { status: 400, title: 'Bad Request', detail: 'Could not parse data file: ' + err.message }] };
  }
  return { company, credentials, datafile, concurrentLimit: concurrentLimitOf(companyId) };
}

/**
 * One run per code, written in one transaction, then queued: { batchId, runs }
 * (each run's id, status, scenario_code, batch_id, queued_at). `selection`,
 * when given, is kept as what the batch was chosen by (#1029 PR 3).
 */
function enqueueBatch({ companyId, userId, company, credentials, codes, concurrentLimit, selection }) {
  const batchId = randomUUID();
  const runs = [];
  transaction(() => {
    for (const code of codes) {
      const runId = randomUUID();
      dbRun(
        `INSERT INTO runs (id, company_id, user_id, status, auth_mode_used, api_base_used, datafile_hash_used, env_name_used, batch_id, scenario_code)
         VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`,
        [runId, companyId, userId, credentials.auth_mode, company.api_base, company.datafile_hash || null,
         `OTST_${company.slug}_Env`, batchId, code]
      );
      runs.push({ runId, code });
    }
    if (selection !== undefined) {
      dbRun('INSERT INTO run_batch (batch_id, company_id, selection) VALUES (?, ?, ?)',
        [batchId, companyId, JSON.stringify(RF.withDefaults(selection))]);
    }
  });

  // The queue respects the company's limit of runs at once.
  for (const { runId, code } of runs) {
    queue.enqueue({ runId, companyId, scenarioOverride: code, concurrentLimit, batchId, scenarioCode: code, userId });
  }

  return {
    batchId,
    runs: all(`SELECT id, status, scenario_code, batch_id, queued_at FROM runs WHERE company_id = ? AND batch_id = ? ORDER BY +queued_at ASC`,
      [companyId, batchId]),
  };
}

module.exports = { launchReadiness, enqueueBatch, missingCredentials, concurrentLimitOf };
