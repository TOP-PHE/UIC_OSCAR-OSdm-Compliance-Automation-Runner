// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * What OSCAR does when a run meets an answer meant to attack it.
 *
 * The collection (library-bruno/answerTemplates.js) stops the run and logs one
 * line starting with INTRUSION_MARK: `[INTRUSION] kind=<kind> step=<request>`.
 * The runner hands each such line to onIntrusionLine(), which, once per run:
 *   - records a security event (security_event, migration 47: run, company,
 *     user, kind, step, time; never the answer);
 *   - suspends the endpoint of the company or provider (companies
 *     endpoint_suspended_at / _reason): no new run goes to it until a Test
 *     Manager resumes it (POST /v1/company/endpoint/resume) or saves another
 *     endpoint;
 *   - drops every cached provider token of that company or provider, so the
 *     next request needs a token asked again;
 *   - writes an audit line and e-mails the administrators.
 */

const { get, all, run, transaction } = require('../db/db');
const log = require('./logger').child({ module: 'intrusion' });

const INTRUSION_MARK = '[INTRUSION] ';
const KINDS = new Set(['template', 'script', 'redirect']);
const KIND_TEXT = {
  template: 'an answer held a template ("{{") the test engine would have filled in with its own variables',
  script: 'an answer held markup meant to run in a browser',
  redirect: 'an answer redirected to a private or internal address',
};

// The step is a request name: kept to printable text, 120 characters.
function cleanStep(raw) {
  return String(raw || '').replace(/[^\x20-\x7e -ɏ]/g, '').trim().slice(0, 120) || null;
}

/** { kind, step } from a log line, or null when it is not an intrusion line. */
function parseIntrusionLine(line) {
  const text = String(line || '');
  const at = text.indexOf(INTRUSION_MARK);
  if (at === -1) return null;
  const rest = text.slice(at + INTRUSION_MARK.length);
  const kind = /^kind=([a-z]+)/.exec(rest)?.[1];
  if (!KINDS.has(kind)) return null;
  const stepAt = rest.indexOf(' step=');
  return { kind, step: stepAt === -1 ? null : cleanStep(rest.slice(stepAt + 6)) };
}

/** The open (not resumed) suspension of a company's endpoint, or null. */
function endpointSuspension(companyId) {
  const row = get('SELECT endpoint_suspended_at, endpoint_suspended_reason FROM companies WHERE id = ?', [companyId]);
  if (!row?.endpoint_suspended_at) return null;
  return { since: row.endpoint_suspended_at, reason: row.endpoint_suspended_reason || 'intrusion' };
}

/** Ends a suspension (a Test Manager's resume, or another endpoint saved). */
function resumeEndpoint(companyId, byEmail) {
  run(`UPDATE companies SET endpoint_suspended_at = NULL, endpoint_suspended_reason = NULL WHERE id = ?`, [companyId]);
  run(`UPDATE security_event SET resumed_at = datetime('now'), resumed_by = ? WHERE company_id = ? AND resumed_at IS NULL`,
    [byEmail || null, companyId]);
}

/**
 * Records the event and acts on it. Returns the event row, or null when the
 * run already has one. Never throws: a failure is logged, the run is stopped
 * by the collection anyway.
 */
function recordIntrusion({ runId, companyId, userId, kind, step }, notify = notifyAdministrators) {
  try {
    if (get('SELECT id FROM security_event WHERE run_id = ?', [runId])) return null;
    const id = require('node:crypto').randomUUID();
    transaction(() => {
      run(`INSERT INTO security_event (id, run_id, company_id, user_id, kind, step) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, runId, companyId, userId || null, kind, step || null]);
      run(`UPDATE companies SET endpoint_suspended_at = datetime('now'), endpoint_suspended_reason = 'intrusion'
           WHERE id = ? AND endpoint_suspended_at IS NULL`, [companyId]);
      run(`UPDATE tester_credentials SET cached_token_enc = NULL, cached_token_expires_at = NULL, cached_token_cred_fp = NULL
           WHERE company_id = ?`, [companyId]);
      run(`INSERT INTO auth_events (user_id, company_id, email, event_type, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
        [userId || null, companyId, null, `intrusion_detected:${kind}:${runId}`]);
    });
    const event = get('SELECT * FROM security_event WHERE id = ?', [id]);
    Promise.resolve().then(() => notify(event)).catch(err => log.error({ err: err.message, runId }, 'intrusion alert not sent'));
    return event;
  } catch (err) {
    log.error({ err: err.message, runId }, 'intrusion not recorded');
    return null;
  }
}

/** The runner's hook: a log line of a run. True when it was an intrusion line. */
function onIntrusionLine(line, runRow, notify) {
  const found = parseIntrusionLine(line);
  if (!found || !runRow) return false;
  recordIntrusion({ runId: runRow.id, companyId: runRow.company_id, userId: runRow.user_id, ...found }, notify);
  return true;
}

// The e-mail to every administrator: who, where, what, when; no answer content.
async function notifyAdministrators(event) {
  const { sendSecurityAlert } = require('./mailer');
  const admins = all(`SELECT email FROM users WHERE role = 'administrator' AND status = 'active'`).map(r => r.email);
  if (admins.length === 0) return;
  const company = get('SELECT name FROM companies WHERE id = ?', [event.company_id]);
  const user = event.user_id ? get('SELECT email FROM users WHERE id = ?', [event.user_id]) : null;
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  await sendSecurityAlert({
    to: admins,
    subject: `OSCAR security alert: intrusion attempt detected (${company?.name || 'unknown company'})`,
    heading: 'Intrusion attempt detected',
    lines: [
      `During a run, ${KIND_TEXT[event.kind] || 'an answer was refused'}.`,
      `Company or provider: ${company?.name || event.company_id}. Run: ${event.run_id}. Step: ${event.step || 'unknown'}. Started by: ${user?.email || 'unknown'}. Time (UTC): ${event.detected_at}.`,
      'The run was stopped, the cached provider tokens of this company or provider were dropped, and its endpoint is suspended until a Test Manager resumes it.',
    ],
    url: appUrl ? `${appUrl}/admin.html` : null,
  });
}

module.exports = {
  INTRUSION_MARK, KINDS, KIND_TEXT,
  parseIntrusionLine, recordIntrusion, onIntrusionLine, endpointSuspension, resumeEndpoint, notifyAdministrators,
};
