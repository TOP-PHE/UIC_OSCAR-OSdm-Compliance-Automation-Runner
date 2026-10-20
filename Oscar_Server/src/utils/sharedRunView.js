// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * sharedRunView.js — what the company a run is shared with sees of it (#901).
 * Pure.
 *
 * The distributor's people are named by the distributor, never by e-mail:
 * every e-mail of the distributor's users is replaced by its name in the run
 * log and the reports, and the run row loses the fields that name a person
 * or an internal state of the distributor.
 */

/**
 * `text` with every one of `emails` replaced by `name`, compared without
 * case. No regular expression is built from the e-mails.
 */
function replaceEmails(text, emails, name) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(emails)) return text;
  let out = text;
  for (const email of emails) {
    if (typeof email !== 'string' || email.length < 3) continue;
    const needle = email.toLowerCase();
    let lower = out.toLowerCase();
    let at = lower.indexOf(needle);
    while (at !== -1) {
      out = out.slice(0, at) + name + out.slice(at + email.length);
      lower = out.toLowerCase();
      at = lower.indexOf(needle, at + name.length);
    }
  }
  return out;
}

// The run row fields the company shared with may see.
const RUN_FIELDS = [
  'id', 'company_id', 'status', 'batch_id', 'scenario_code', 'queued_at', 'started_at', 'completed_at',
  'exit_code', 'api_base_used', 'env_name_used', 'auth_mode_used',
];

/** The run row as the company shared with sees it. */
function sharedRunRow(run, view) {
  const out = {};
  for (const key of RUN_FIELDS) if (key in (run || {})) out[key] = run[key];
  out.submitted_by = view.distributor.name;
  out.shared = { distributor: view.distributor.name, provider: view.provider.name };
  return out;
}

module.exports = { replaceEmails, sharedRunRow, RUN_FIELDS };
