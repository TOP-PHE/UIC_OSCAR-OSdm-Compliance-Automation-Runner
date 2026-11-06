// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Access to OSCAR is asked, checked twice, then given (maintainer decision,
 * 2026-11-05). No list of companies is ever shown to a visitor.
 *
 *   1. A visitor asks: name, e-mail and the company they work for, typed.
 *      The answer is the same whatever exists (no company, no e-mail told).
 *   2. They confirm their e-mail with the link sent to it: state "verified".
 *   3. An administrator places the request in a company (state "assigned"),
 *      or refuses it. The administrator alone gives access only to the first
 *      Test Manager of a company that has none (it creates the first one).
 *   4. A Test Manager of that company confirms it, as a tester or a Test
 *      Manager, or refuses it.
 *   5. The account is made with no usable password, and the person receives a
 *      link to choose theirs: nobody else ever knows it.
 *
 * Rows are access_request (migration 49): one open request per e-mail. A
 * refused request is deleted (the audit log keeps the decision).
 */

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { get, all, run, transaction } = require('../db/db');
const log = require('./logger').child({ module: 'access-requests' });

const VERIFY_HOURS = 24;
const ACTIVATION_HOURS = 72;
const ROLES = new Set(['company_user', 'test_manager']);

const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();
const appUrl = () => (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');

function clean(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Step 1. Returns { token } when a link is to be sent, or null when nothing
 * is (the e-mail already has an account, or a request for it is still open:
 * confirmed, or its link not expired). The caller answers the same in every case.
 */
function createRequest({ email, name, company }) {
  const lowerEmail = String(email).toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email = ?', [lowerEmail])) return null;
  // One e-mail per address while its link is valid, and a request already
  // confirmed is not replaced (1.11.480): the form cannot be used to flood an
  // address, nor to undo someone's request. Only an expired link gives way.
  if (stillOpen(get('SELECT state, token_expires_at FROM access_request WHERE email = ?', [lowerEmail]))) return null;
  const token = crypto.randomUUID();
  transaction(() => {
    run('DELETE FROM access_request WHERE email = ?', [lowerEmail]);
    run(`INSERT INTO access_request (id, email, full_name, company_text, token, token_expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, 'unverified')`,
      [crypto.randomUUID(), lowerEmail, clean(name, 120), clean(company, 160), token, hoursFromNow(VERIFY_HOURS)]);
  });
  return { token, url: `${appUrl()}/verify-email.html?token=${token}` };
}

// A request that holds its address: confirmed, or a link not expired yet.
function stillOpen(row) {
  if (!row) return false;
  if (row.state !== 'unverified') return true;
  return !row.token_expires_at || new Date(row.token_expires_at) > new Date();
}

/** The request a verification link stands for, or { status, detail }. */
function requestOfToken(token) {
  const row = get(`SELECT * FROM access_request WHERE token = ? AND state = 'unverified'`, [token]);
  if (!row) return { status: 404, detail: 'Invalid or already used confirmation link.' };
  if (new Date(row.token_expires_at) < new Date()) {
    run('DELETE FROM access_request WHERE id = ?', [row.id]);
    return { status: 410, detail: 'This confirmation link has expired (24h limit). Please ask again.' };
  }
  return { row };
}

/** Step 2: the e-mail is confirmed; the request waits for an administrator. */
function verifyRequest(token) {
  const found = requestOfToken(token);
  if (!found.row) return found;
  run(`UPDATE access_request SET state = 'verified', verified_at = datetime('now'), token = NULL, token_expires_at = NULL
       WHERE id = ?`, [found.row.id]);
  return { row: get('SELECT * FROM access_request WHERE id = ?', [found.row.id]) };
}

/** Requests waiting for an administrator or a Test Manager, as a view. */
function viewOf(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    company_typed: row.company_text,
    state: row.state,
    verified_at: row.verified_at,
    company_id: row.company_id || null,
    company_name: row.company_name || null,
    assigned_at: row.assigned_at || null,
    // An address not confirmed yet: shown to the administrator, who can only
    // refuse it, with the time its confirmation link runs out.
    link_expires_at: row.state === 'unverified' ? row.token_expires_at : null,
  };
}

function waitingRequests() {
  return all(`SELECT r.*, c.name AS company_name FROM access_request r
                LEFT JOIN companies c ON c.id = r.company_id
               WHERE r.state IN ('verified', 'assigned', 'unverified')
               ORDER BY r.state = 'unverified', r.verified_at, r.created_at`).map(viewOf);
}

function requestsOfCompany(companyId) {
  return all(`SELECT r.*, c.name AS company_name FROM access_request r
                JOIN companies c ON c.id = r.company_id
               WHERE r.state = 'assigned' AND r.company_id = ?
               ORDER BY r.assigned_at`, [companyId]).map(viewOf);
}

function activeTestManagers(companyId) {
  return all(`SELECT id, email FROM users WHERE company_id = ? AND role = 'test_manager' AND status = 'active'`, [companyId]);
}

/**
 * Makes the account, with no usable password, and the link that lets its
 * owner choose one. Returns { user, activationUrl }.
 */
async function activate(request, companyId, role) {
  return invite({ email: request.email, companyId, role }, () => run('DELETE FROM access_request WHERE id = ?', [request.id]));
}

/**
 * An account made by invitation: no usable password, and a link (72 hours,
 * once) for its owner to choose one. Nobody else ever knows the password.
 * `also` runs in the same transaction. Returns { user, activationUrl }.
 */
async function invite({ email, companyId, role }, also = () => {}) {
  const lowerEmail = String(email).toLowerCase().trim();
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('base64'), 12);
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID();
  transaction(() => {
    run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'active')`,
      [userId, companyId, lowerEmail, unusable, role]);
    run('INSERT INTO password_reset_tokens (id, user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?, NULL)',
      [crypto.randomUUID(), userId, token, hoursFromNow(ACTIVATION_HOURS)]);
    also();
  });
  return { user: { id: userId, email: lowerEmail, role }, activationUrl: `${appUrl()}/reset-password.html?token=${token}&welcome=1` };
}

/**
 * A company nobody uses yet: no user and no test data. Only there may the
 * administrator alone bring in a Test Manager: anywhere else it could empty
 * a company of its people and take its tests over with a person of its own.
 */
function isNewCompany(companyId) {
  const held = [
    'SELECT 1 AS x FROM users WHERE company_id = ? LIMIT 1',
    'SELECT 1 AS x FROM runs WHERE company_id = ? LIMIT 1',
    'SELECT 1 AS x FROM test_frameworks WHERE company_id = ? LIMIT 1',
    'SELECT 1 AS x FROM test_resources WHERE company_id = ? LIMIT 1',
    'SELECT 1 AS x FROM finding WHERE company_id = ? LIMIT 1',
  ];
  if (held.some(sql => get(sql, [companyId]))) return false;
  return !get('SELECT datafile_path FROM companies WHERE id = ?', [companyId])?.datafile_path;
}

/** A link to choose a new password, sent to the account's own address only. */
function sendPasswordReset(user) {
  const token = crypto.randomUUID();
  run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
  run('INSERT INTO password_reset_tokens (id, user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?, NULL)',
    [crypto.randomUUID(), user.id, token, hoursFromNow(24)]);
  const resetUrl = `${appUrl()}/reset-password.html?token=${token}`;
  const { sendPasswordResetEmail } = require('./mailer');
  Promise.resolve()
    .then(() => sendPasswordResetEmail({ to: user.email, resetUrl }))
    .catch(err => log.error({ err: err.message }, 'password-reset e-mail not sent'));
}

/**
 * The administrator places someone in a company that has a Test Manager:
 * an access request the company's Test Manager confirms, as if the person
 * had asked. Returns the request.
 */
function placeInCompany(email, company) {
  const lowerEmail = String(email).toLowerCase().trim();
  const id = crypto.randomUUID();
  transaction(() => {
    run('DELETE FROM access_request WHERE email = ?', [lowerEmail]);
    run(`INSERT INTO access_request (id, email, full_name, company_text, state, verified_at, company_id, assigned_at)
         VALUES (?, ?, '', ?, 'assigned', datetime('now'), ?, datetime('now'))`, [id, lowerEmail, company.name, company.id]);
  });
  return get('SELECT * FROM access_request WHERE id = ?', [id]);
}

/**
 * Step 3, the administrator: place a verified (or already placed) request in
 * a top-level company. A company with no active Test Manager gets its first
 * one here, and only when the administrator says so (firstTestManager).
 * Returns { assigned } | { activated } | { status, detail }.
 */
async function assignRequest(id, companyId, { firstTestManager = false } = {}) {
  const request = get(`SELECT * FROM access_request WHERE id = ? AND state IN ('verified', 'assigned')`, [id]);
  if (!request) return { status: 404, detail: 'Request not found.' };
  const company = get('SELECT id, name, slug, parent_id FROM companies WHERE id = ?', [companyId]);
  const { PLATFORM_SLUG } = require('../api/helpers/shared');
  if (!company || company.parent_id || company.slug === PLATFORM_SLUG) {
    return { status: 400, detail: 'Choose a company (not a provider, not the platform).' };
  }
  if (get('SELECT id FROM users WHERE email = ?', [request.email])) {
    run('DELETE FROM access_request WHERE id = ?', [id]);
    return { status: 409, detail: 'This e-mail already has an account.' };
  }
  const managers = activeTestManagers(company.id);
  if (managers.length === 0) {
    if (!isNewCompany(company.id)) {
      return { status: 409, detail: `${company.name} has no active Test Manager but already has users or test data: name one of its users Test Manager first.` };
    }
    if (!firstTestManager) {
      return { status: 409, detail: `${company.name} has no Test Manager: confirming makes this person its first Test Manager.`, needsFirstTestManager: true };
    }
    const done = await activate(request, company.id, 'test_manager');
    return { activated: true, company, ...done };
  }
  run(`UPDATE access_request SET state = 'assigned', company_id = ?, assigned_at = datetime('now') WHERE id = ?`, [company.id, id]);
  return { assigned: true, company, request, managers };
}

/** Step 4, a Test Manager of the request's company. */
async function confirmRequest(id, companyId, role) {
  if (!ROLES.has(role)) return { status: 400, detail: 'role must be company_user or test_manager.' };
  const request = get(`SELECT * FROM access_request WHERE id = ? AND state = 'assigned' AND company_id = ?`, [id, companyId]);
  if (!request) return { status: 404, detail: 'Request not found.' };
  if (get('SELECT id FROM users WHERE email = ?', [request.email])) {
    run('DELETE FROM access_request WHERE id = ?', [id]);
    return { status: 409, detail: 'This e-mail already has an account.' };
  }
  return activate(request, companyId, role);
}

/** A refusal, by the administrator (any waiting request) or a Test Manager (theirs). */
function refuseRequest(id, companyId = null) {
  const request = companyId
    ? get(`SELECT * FROM access_request WHERE id = ? AND state = 'assigned' AND company_id = ?`, [id, companyId])
    : get(`SELECT * FROM access_request WHERE id = ? AND state IN ('verified', 'assigned', 'unverified')`, [id]);
  if (!request) return { status: 404, detail: 'Request not found.' };
  run('DELETE FROM access_request WHERE id = ?', [id]);
  return { request };
}

/** Sends a notice without holding the answer; a failure is logged only. */
function notify(kind, message) {
  const { sendAccessNotice } = require('./mailer');
  Promise.resolve()
    .then(() => sendAccessNotice(message))
    .catch(err => log.error({ err: err.message, kind }, 'access-request notice not sent'));
}

function administratorEmails() {
  return all(`SELECT email FROM users WHERE role = 'administrator' AND status = 'active'`).map(r => r.email);
}

const manageUsersUrl = () => `${appUrl()}/admin.html?tab=users`;
const who = r => `${r.full_name || r.email} (${r.email})`;

/** The administrators are told a confirmed request waits to be placed. */
function noticeVerified(request) {
  const to = administratorEmails();
  if (to.length === 0) return;
  notify('to_administrators', {
    to,
    subject: 'OSCAR — An access request to place',
    heading: 'An access request is waiting',
    lines: [`${who(request)} asks for access and names the company "${request.company_text}".`,
      'Place it in a company, or refuse it, from Manage Users.'],
    url: manageUsersUrl(),
  });
}

/** The company's Test Managers are told a request waits for them. */
function noticeAssigned(request, company, managers) {
  notify('to_test_managers', {
    to: managers.map(m => m.email),
    subject: `OSCAR — An access request for ${company.name}`,
    heading: 'An access request is waiting for you',
    lines: [`${who(request)} asks to join ${company.name}.`,
      'Confirm it, as a tester or a Test Manager, or refuse it, from Manage Users.'],
    url: manageUsersUrl(),
  });
}

/** The person receives the link to choose their password. */
function noticeActivated(user, companyName, activationUrl) {
  const as = user.role === 'test_manager' ? 'a Test Manager' : 'a tester';
  notify('activation', {
    to: user.email,
    subject: 'OSCAR — Your access is ready',
    heading: 'Your access to OSCAR is ready',
    lines: [`You can now use OSCAR for ${companyName}, as ${as}.`,
      `Choose your password with the link below (valid ${ACTIVATION_HOURS} hours, once).`],
    url: activationUrl,
  });
}

function noticeRefused(request) {
  notify('refusal', {
    to: request.email,
    subject: 'OSCAR — Your access request',
    heading: 'Your access request was not accepted',
    lines: ['Your request for access to OSCAR was not accepted. If you think this is a mistake, contact the person who invited you to OSCAR.'],
  });
}

module.exports = {
  createRequest, requestOfToken, verifyRequest, waitingRequests, requestsOfCompany,
  assignRequest, confirmRequest, refuseRequest, activeTestManagers,
  invite, isNewCompany, sendPasswordReset, placeInCompany,
  noticeVerified, noticeAssigned, noticeActivated, noticeRefused,
  VERIFY_HOURS, ACTIVATION_HOURS,
};
