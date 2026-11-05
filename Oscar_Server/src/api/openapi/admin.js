// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The administrator's routes (routes/admin.js under /v1/admin, and
 * routes/admin-simulator.js under /v1/admin/simulator) not described in
 * openapi.js itself.
 */

const { bearer, pathParam, queryParam, jsonBody } = require('./common');

const tags = ['Admin'];

// routes/admin.js: administrators only; its writes share one limit.
const ADMIN = 'Administrators only. Writes (POST, PATCH, PUT, DELETE) share a limit of 60 per 5 minutes per address.';
const USER = '{ user: { id, email, role, status, company_id, company_name, company_slug, created_at } }';
const COMPANY = '{ id, name, slug, auth_mode, api_base, created_at, user_count }';

const userId = pathParam('id', 'The user\'s id');
const companyId = pathParam('id', 'The company\'s id');

const r401 = { description: 'Not signed in' };
const r403 = { description: 'Administrators only' };
const r404User = { description: 'No such user' };
const r404Company = { description: 'No such company' };
const r429 = { description: 'Too many requests' };

// routes/admin-simulator.js: OSCAR is the only caller of the simulator's
// administration API, with the key saved for that address only.
const SIM = 'Administrators only, 60 requests a minute per address. Answers carry Cache-Control: no-store and are built field by field from the simulator\'s.';
const SIM_CALL = `${SIM} OSCAR calls the simulator's administration API at the saved address, with the key saved for that address, naming the administrator; the change is also in OSCAR's audit.`;
const simErrors = {
  401: r401, 403: r403,
  409: { description: 'No simulator set up, or no key saved for its address' },
  422: { description: 'The saved address is not one OSCAR may call' },
  429: r429,
  502: { description: 'The simulator did not answer, or answered something unusable' },
};
const provider = pathParam('provider', 'The simulator\'s provider key (lower-case letters, digits and hyphens)', null);
const clientId = pathParam('clientId', 'The account\'s client id (3 to 64 printable characters, no colon or space)', null);
const days = queryParam('days', 'The period in days, today (UTC) included: 1, 7, 30 (default), 90 or 365', { type: 'integer', enum: [1, 7, 30, 90, 365] });

module.exports = {
  '/v1/admin/users/{id}': {
    patch: { tags, summary: 'Change a user\'s e-mail, role or company', security: bearer,
      description: `${ADMIN} Body: { email?, role?, company_id? }. A Tester or Test Manager keeps their company unless another top-level company is named; an administrator is moved to the platform company. Provider access and stored credentials follow a change of company or role. Answer: ${USER}.`,
      parameters: [userId], requestBody: jsonBody('{ email?, role?, company_id? }'),
      responses: { 200: { description: 'The user' }, 400: { description: 'A field refused, or nothing to change' }, 401: r401, 403: r403, 404: { description: 'No such user or company' }, 409: { description: 'E-mail already used by another user' }, 429: r429 } },
    delete: { tags, summary: 'Delete a user and their runs', security: bearer,
      description: `${ADMIN} Removes the user's runs and the comparisons that name them; login history is kept without the user. An administrator cannot delete their own account. Answer: { deleted, id, email }.`,
      parameters: [userId],
      responses: { 200: { description: 'Deleted' }, 400: { description: 'Own account' }, 401: r401, 403: r403, 404: r404User, 429: r429 } },
  },
  '/v1/admin/users/{id}/approve': {
    post: { tags, summary: 'Activate a self-registered user awaiting approval (#449)', security: bearer,
      description: `${ADMIN} Only for a company with no active Test Manager: elsewhere a Test Manager approves. Answer: ${USER}.`,
      parameters: [userId],
      responses: { 200: { description: 'The user, now active' }, 400: { description: 'The user is not awaiting approval' }, 401: r401, 403: r403, 404: r404User, 409: { description: 'The company has a Test Manager, who approves' }, 429: r429 } },
  },
  '/v1/admin/access-requests': {
    get: { tags, summary: 'Access requests waiting to be placed or confirmed', security: bearer,
      description: `${ADMIN} Requests whose e-mail is confirmed: { requests: [{ id, email, name, company_typed, state (verified | assigned), verified_at, company_id, company_name, assigned_at }] }.`,
      responses: { 200: { description: 'The requests' }, 401: r401, 403: r403, 429: r429 } },
  },
  '/v1/admin/access-requests/{id}/assign': {
    post: { tags, summary: 'Place an access request in a company', security: bearer,
      description: `${ADMIN} Body: { company_id, first_test_manager? }. A top-level company, not the platform. Its Test Managers are told and confirm it. A company with no active Test Manager gets its first one here, only with first_test_manager: true (409 with needs_first_test_manager otherwise); the person then receives the link to choose a password. Audited.`,
      parameters: [pathParam('id', 'The request')], requestBody: jsonBody('{ company_id, first_test_manager? }'),
      responses: { 200: { description: '{ assigned: true, company } or { activated: true, user, company }' }, 400: { description: 'No company, or a provider or the platform' }, 401: r401, 403: r403, 404: { description: 'No such request waiting' }, 409: { description: 'First Test Manager to confirm, or the e-mail has an account' }, 429: r429 } },
  },
  '/v1/admin/access-requests/{id}/refuse': {
    post: { tags, summary: 'Refuse an access request', security: bearer,
      description: `${ADMIN} The request is deleted and the person told. Audited.`,
      parameters: [pathParam('id', 'The request')],
      responses: { 200: { description: '{ refused: true }' }, 401: r401, 403: r403, 404: { description: 'No such request waiting' }, 429: r429 } },
  },
  '/v1/admin/users/{id}/reset-password': {
    post: { tags, summary: 'Set a user\'s password', security: bearer,
      description: `${ADMIN} Body: { new_password } (at least 12 characters, with an upper-case letter, a lower-case letter and a digit). Answer: { id, email, password_reset }; the password is never returned.`,
      parameters: [userId], requestBody: jsonBody('{ new_password }'),
      responses: { 200: { description: 'Password set' }, 400: { description: 'Password refused' }, 401: r401, 403: r403, 404: r404User, 429: r429 } },
  },
  '/v1/admin/users/{id}/generate-reset-link': {
    post: { tags, summary: 'A password-reset link to hand to the user, without e-mail', security: bearer,
      description: `${ADMIN} Replaces any earlier link of the user. The link is single-use and expires after 24 hours; it is returned to the administrator only, to be passed on out-of-band. Answer: { id, email, resetUrl, expires_at, note }.`,
      parameters: [userId],
      responses: { 200: { description: 'The link' }, 401: r401, 403: r403, 404: r404User, 429: r429 } },
  },
  '/v1/admin/activity': {
    get: { tags, summary: 'Server activity: totals, runs, logins', security: bearer,
      description: 'Administrators only. { totals, runs_last_24h, logins_last_24h, failed_logins_last_24h, run_status_distribution, top_submitters_last_7d, runs_in_progress, latest_auth_events, auth_events_range }. Without from and to, the 50 latest authentication events; with both, those in [from, to), at most 1,000.',
      parameters: [
        queryParam('from', 'UTC "YYYY-MM-DD HH:MM:SS", start of the range (with to)'),
        queryParam('to', 'UTC "YYYY-MM-DD HH:MM:SS", end of the range, excluded (with from)'),
      ],
      responses: { 200: { description: 'Activity' }, 401: r401, 403: r403 } },
  },
  '/v1/admin/companies': {
    get: { tags, summary: 'List the top-level companies', security: bearer,
      description: `Administrators only. Providers are not listed. { companies: [${COMPANY}] }.`,
      responses: { 200: { description: 'Companies' }, 401: r401, 403: r403 } },
    post: { tags, summary: 'Create a company', security: bearer,
      description: `${ADMIN} Body: { name, slug }; the slug is lower-cased, other characters than letters, digits and hyphens become hyphens. Answer: { company: ${COMPANY} }.`,
      requestBody: jsonBody('{ name, slug }'),
      responses: { 201: { description: 'Created' }, 400: { description: 'name and slug are required' }, 401: r401, 403: r403, 409: { description: 'Slug already used' }, 429: r429 } },
  },
  '/v1/admin/companies/{id}': {
    patch: { tags, summary: 'Rename a company or change its slug', security: bearer,
      description: `${ADMIN} Body: { name?, slug? }. The platform company cannot be changed. Answer: { company: ${COMPANY} }.`,
      parameters: [companyId], requestBody: jsonBody('{ name?, slug? }'),
      responses: { 200: { description: 'The company' }, 400: { description: 'Platform company, or nothing to change' }, 401: r401, 403: r403, 404: r404Company, 409: { description: 'Slug already used' }, 429: r429 } },
    delete: { tags, summary: 'Delete a company with no users and no providers', security: bearer,
      description: `${ADMIN} Removes everything the company holds with it (every row naming it, its runs, findings and their comments, its data files), unread; the deletion stays in the audit log. The list and the answers name a company by id, name and slug only, never its endpoint. The platform company cannot be deleted. Answer: { deleted, id, name }.`,
      parameters: [companyId],
      responses: { 200: { description: 'Deleted' }, 400: { description: 'Platform company' }, 401: r401, 403: r403, 404: r404Company, 409: { description: 'The company still has users or providers' }, 429: r429 } },
  },
  '/v1/admin/alertmanager/apply': {
    post: { tags, summary: 'Write the alerting configuration from the server settings and reload the alert service', security: bearer,
      description: `${ADMIN} Built from the SMTP and alerting settings of the server configuration. Answers 200 whatever the outcome: { ok, written, reloaded, configPath, reloadUrl, reloadStatus, reloadBody, error }.`,
      responses: { 200: { description: 'The outcome of each step' }, 401: r401, 403: r403, 429: r429 } },
  },
  '/v1/admin/test-email': {
    post: { tags, summary: 'Send a test e-mail with the current SMTP settings', security: bearer,
      description: `${ADMIN} Also 6 per 5 minutes per administrator. Body: { to }. Answers 200 { ok: true, to, messageId, response, accepted, rejected }, or 200 { ok: false, to, error, code, command, responseCode, response } when the SMTP server refused.`,
      requestBody: jsonBody('{ to }'),
      responses: { 200: { description: 'Sent, or the SMTP error' }, 400: { description: 'Not an e-mail address' }, 401: r401, 403: r403, 409: { description: 'SMTP not configured' }, 429: r429 } },
  },
  '/v1/admin/simulator/config': {
    get: { tags, summary: 'The OSDM simulator\'s address, and whether a key is saved for it (#930)', security: bearer,
      description: `${SIM} { url, keySet }; the key is never returned.`,
      responses: { 200: { description: 'The set-up' }, 401: r401, 403: r403, 429: r429 } },
    put: { tags, summary: 'Save the simulator\'s address and administration key, after trying them (#930)', security: bearer,
      description: `${SIM} Body: { url, key? }: a plain URL (no user, query or fragment); no key keeps the saved one, for the same address only. The pair is tried (the accounts list must answer) before anything is saved; the key is stored encrypted, sent only to the address it was saved with, and never returned. Answer: { url, keySet }.`,
      requestBody: jsonBody('{ url, key? }'),
      responses: { 200: { description: 'Saved' }, 400: { description: 'Address or key refused, or the key to enter again' }, 401: r401, 403: r403, 422: { description: 'Not saved: the trial failed' }, 429: r429 } },
    delete: { tags, summary: 'Forget the simulator\'s address and key (#930)', security: bearer,
      description: `${SIM} Answer: { url: null, keySet: false }.`,
      responses: { 200: { description: 'Removed' }, 401: r401, 403: r403, 429: r429 } },
  },
  '/v1/admin/simulator/version': {
    get: { tags, summary: 'The simulator\'s version and what OSCAR needs of it (#1010)', security: bearer,
      description: `${SIM} Read from the simulator's public health check at the saved address; no key is sent. { version (N.N.N or null), needs, supports }.`,
      responses: { 200: { description: 'The version' }, ...simErrors, 409: { description: 'No simulator set up' } } },
  },
  '/v1/admin/simulator/accounts': {
    get: { tags, summary: 'Every simulator provider and its accounts (#930)', security: bearer,
      description: `${SIM_CALL} { providers: [{ provider, name, osdmVersion, accounts: [{ clientId, createdAt, lastTokenAt }] }] }; no secret.`,
      responses: { 200: { description: 'Accounts' }, ...simErrors } },
  },
  '/v1/admin/simulator/accounts/{provider}': {
    post: { tags, summary: 'Add an account to a simulator provider; its secret is shown once (#930)', security: bearer,
      description: `${SIM_CALL} Body: { clientId } or { kind: tst | tstmgr }, or empty. Answer 201: { provider, clientId, clientSecret }. The simulator keeps only a digest of the secret: it cannot be shown again.`,
      parameters: [provider], requestBody: jsonBody('{ clientId } or { kind }', false),
      responses: { 201: { description: 'The account and its secret' }, 400: { description: 'Provider, client id or kind refused' }, 404: { description: 'Refused by the simulator' }, ...simErrors, 409: { description: 'No simulator set up, or refused by the simulator' } } },
  },
  '/v1/admin/simulator/accounts/{provider}/{clientId}': {
    delete: { tags, summary: 'Delete a simulator account (#930)', security: bearer,
      description: `${SIM_CALL} Answer: { provider, clientId, deleted }.`,
      parameters: [provider, clientId],
      responses: { 200: { description: 'Deleted' }, 400: { description: 'Provider or client id refused' }, 404: { description: 'Refused by the simulator' }, ...simErrors } },
  },
  '/v1/admin/simulator/accounts/{provider}/{clientId}/reset-secret': {
    post: { tags, summary: 'Give a simulator account a new secret, shown once (#930)', security: bearer,
      description: `${SIM_CALL} The old secret and the tokens made with it stop working. Answer: { provider, clientId, clientSecret }; it cannot be shown again.`,
      parameters: [provider, clientId],
      responses: { 200: { description: 'The new secret' }, 400: { description: 'Provider or client id refused' }, 404: { description: 'Refused by the simulator' }, ...simErrors } },
  },
  '/v1/admin/simulator/audit': {
    get: { tags, summary: 'The simulator\'s audit of account changes (#930)', security: bearer,
      description: `${SIM_CALL} { entries: [{ at, by, action, provider, clientId, count, address }] }, at most 200; never a secret.`,
      responses: { 200: { description: 'Audit' }, ...simErrors } },
  },
  '/v1/admin/simulator/stats': {
    get: { tags, summary: 'What each simulator account did, per provider and per day (#930)', security: bearer,
      description: `${SIM_CALL} Counters only (tokens, requests, offers, bookings, confirmations, refunds, exchanges, clientErrors, serverErrors). { days, from, to, providers: [{ provider, name, totals, unidentified, accounts: [{ clientId, … }] }], daily: [{ day, … }] }.`,
      parameters: [days],
      responses: { 200: { description: 'Statistics' }, 400: { description: 'Not one of the periods' }, ...simErrors } },
  },
  '/v1/admin/simulator/runs': {
    get: { tags, summary: 'The test sets OSCAR sent to the simulator, per provider and user (#930)', security: bearer,
      description: `${SIM} Read from OSCAR's own runs whose endpoint is under the saved simulator address; the simulator is not called. Counts only: { days, from, to, providers: [{ provider, totals, users: [{ email, sets, scenarios, scenariosPerSet, scenariosFailed, failedChecks }] }] }, totals with the same counters.`,
      parameters: [days],
      responses: { 200: { description: 'The test sets' }, 400: { description: 'Not one of the periods' }, 401: r401, 403: r403, 409: { description: 'No simulator set up' }, 429: r429 } },
  },
};
